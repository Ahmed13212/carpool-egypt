import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DevMailer } from '../src/auth/mailer';
import { PasswordService } from '../src/auth/password.service';
import type { AuthUser } from '../src/auth/auth.types';
import { BookingsService } from '../src/bookings/bookings.service';
import { createPrivilegedUser } from '../src/scripts/bootstrap-admin';
import { TripsService } from '../src/trips/trips.service';

export interface Harness {
  app: NestExpressApplication;
  http: any;
  pool: Pool;
  mailer: DevMailer;
  bookings: BookingsService;
  trips: TripsService;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app);
  await app.init();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  return {
    app,
    http: app.getHttpServer(),
    pool,
    mailer: app.get(DevMailer),
    bookings: app.get(BookingsService),
    trips: app.get(TripsService),
    close: async () => {
      await pool.end();
      await app.close();
    },
  };
}

export const PASSWORD = 'correct-horse-battery';
export const uniqueEmail = () => `u${randomUUID().replace(/-/g, '').slice(0, 14)}@example.test`;
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const idemKey = () => `key-${randomUUID()}`;

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  cookies: string[];
}

export async function login(
  h: Harness,
  email: string,
  password = PASSWORD,
): Promise<{ token: string; cookies: string[] }> {
  const res = await request(h.http).post('/api/v1/auth/login').send({ email, password }).expect(200);
  return { token: res.body.accessToken, cookies: res.headers['set-cookie'] as unknown as string[] };
}

/** Registers via the real API, verifies the e-mail with the mailer-outbox token, and logs in. */
export async function newUser(h: Harness, fullName = 'Test User', verify = true): Promise<TestUser> {
  const email = uniqueEmail();
  const reg = await request(h.http)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName, locale: 'en' })
    .expect(201);
  if (verify) {
    const token = h.mailer.lastTokenFor(email, 'email_verification')!;
    await request(h.http).post('/api/v1/auth/verify-email').send({ token }).expect(204);
  }
  const { token, cookies } = await login(h, email);
  return { id: reg.body.id, email, password: PASSWORD, token, cookies };
}

export async function newStaff(h: Harness, role: string): Promise<TestUser> {
  const email = uniqueEmail();
  const id = await createPrivilegedUser(h.pool, {
    email,
    password: PASSWORD,
    fullName: `Staff ${role}`,
    role,
    scryptN: 1024,
  });
  const { token, cookies } = await login(h, email);
  return { id, email, password: PASSWORD, token, cookies };
}

export interface TestDriver extends TestUser {
  vehicleId: string;
  plate: string;
}

export async function newVerifiedDriver(h: Harness, reviewer: TestUser, seats = 5): Promise<TestDriver> {
  const u = await newUser(h, 'Driver Person');
  await request(h.http).post('/api/v1/drivers/apply').set(bearer(u.token)).expect(200);
  await request(h.http).post(`/api/v1/admin/drivers/${u.id}/approve`).set(bearer(reviewer.token)).expect(204);
  const plate = `TST ${Math.floor(1000 + Math.random() * 8999)}`;
  const v = await request(h.http)
    .post('/api/v1/vehicles')
    .set(bearer(u.token))
    .send({ make: 'Toyota', model: 'Corolla', color: 'White', seats, plateNumber: plate })
    .expect(201);
  await request(h.http)
    .post(`/api/v1/admin/vehicles/${v.body.id}/approve`)
    .set(bearer(reviewer.token))
    .expect(204);
  return { ...u, vehicleId: v.body.id, plate };
}

export const COORDS: Record<string, [number, number]> = {
  cairo: [30.0444, 31.2357],
  'beni-suef': [29.0661, 31.0994],
  minya: [28.1099, 30.7503],
  asyut: [27.1783, 31.1859],
  alexandria: [31.2001, 29.9187],
  giza: [29.987, 31.2118],
};

export async function cityIds(h: Harness): Promise<Record<string, string>> {
  const { rows } = await h.pool.query('SELECT slug, id FROM cities');
  return Object.fromEntries(rows.map((r) => [r.slug, r.id]));
}

export const futureAt = (daysAhead: number, hourUtc = 10) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

export function tripPayload(
  ids: Record<string, string>,
  vehicleId: string,
  over: Record<string, unknown> = {},
) {
  const stop = (slug: string, offsetMinutes: number) => ({
    cityId: ids[slug],
    name: `${slug} station`,
    lat: COORDS[slug][0],
    lng: COORDS[slug][1],
    offsetMinutes,
  });
  return {
    vehicleId,
    departureAt: futureAt(3).toISOString(),
    seatsTotal: 3,
    bookingMode: 'approval',
    stops: [stop('cairo', 0), stop('minya', 240), stop('asyut', 360)],
    segmentPricesMinor: [10000, 8000],
    ...over,
  };
}

export async function publishTrip(
  h: Harness,
  driver: TestDriver,
  ids: Record<string, string>,
  over: Record<string, unknown> = {},
) {
  const res = await request(h.http)
    .post('/api/v1/trips')
    .set(bearer(driver.token))
    .send(tripPayload(ids, driver.vehicleId, over));
  if (res.status !== 201) throw new Error(`publishTrip failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as {
    id: string;
    stops: { id: string; seq: number }[];
    segments: { seq: number; seatsAvailable: number }[];
  };
}

/** Fast passenger fixtures for service-level concurrency tests (no HTTP, no password hashing per user). */
export async function makePassengers(pool: Pool, n: number): Promise<AuthUser[]> {
  const hash = await new PasswordService({ PASSWORD_SCRYPT_N: 1024 }).hash(PASSWORD);
  const out: AuthUser[] = [];
  for (let i = 0; i < n; i++) {
    const email = uniqueEmail();
    const { rows } = await pool.query(
      `INSERT INTO users(email, password_hash, email_verified_at) VALUES ($1,$2,now()) RETURNING id`,
      [email, hash],
    );
    await pool.query(`INSERT INTO user_profiles(user_id, full_name) VALUES ($1,$2)`, [
      rows[0].id,
      `Passenger ${i}`,
    ]);
    await pool.query(`INSERT INTO user_roles(user_id, role_key) VALUES ($1,'passenger')`, [rows[0].id]);
    out.push({
      id: rows[0].id,
      email,
      sessionId: 'test',
      roles: ['passenger'],
      permissions: ['booking:create'],
      emailVerified: true,
    });
  }
  return out;
}

export const asAuthUser = (u: TestUser, permissions: string[] = []): AuthUser => ({
  id: u.id,
  email: u.email,
  sessionId: 'test',
  roles: [],
  permissions,
  emailVerified: true,
});

/** Core invariant: seats_booked on every segment equals the seats held by seat-holding bookings that cover it, and never exceeds capacity. */
export async function expectInventoryConsistent(pool: Pool, tripId: string) {
  const { rows } = await pool.query(
    `SELECT s.seq, s.seats_total, s.seats_booked,
            COALESCE((SELECT SUM(b.seats) FROM bookings b WHERE b.trip_id = s.trip_id
               AND b.status IN ('pending_approval','awaiting_payment','confirmed')
               AND b.from_stop_seq <= s.seq AND b.to_stop_seq > s.seq), 0)::int AS held
       FROM trip_segments s WHERE s.trip_id = $1 ORDER BY s.seq`,
    [tripId],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect({ seq: r.seq, booked: r.seats_booked }).toEqual({ seq: r.seq, booked: r.held });
    expect(r.seats_booked).toBeLessThanOrEqual(r.seats_total);
  }
}

export async function withSetting<T>(
  pool: Pool,
  key: string,
  value: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const old = (await pool.query('SELECT value FROM platform_settings WHERE key = $1', [key])).rows[0].value;
  await pool.query('UPDATE platform_settings SET value = $2 WHERE key = $1', [key, JSON.stringify(value)]);
  try {
    return await fn();
  } finally {
    await pool.query('UPDATE platform_settings SET value = $2 WHERE key = $1', [key, JSON.stringify(old)]);
  }
}
