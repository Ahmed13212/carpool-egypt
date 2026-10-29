import request from 'supertest';
import {
  cityIds,
  newStaff,
  newVerifiedDriver,
  publishTrip,
  startHarness,
  Harness,
  makePassengers,
} from '../helpers';

describe('schema and database-level guarantees', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('has PostGIS and computes a plausible Cairo-Alexandria distance', async () => {
    const { rows } = await h.pool.query(
      `SELECT ST_Distance(a.location, b.location)/1000 AS km FROM cities a, cities b WHERE a.slug='cairo' AND b.slug='alexandria'`,
    );
    expect(rows[0].km).toBeGreaterThan(170);
    expect(rows[0].km).toBeLessThan(190);
  });

  it('migrations are recorded and seeded cities exist', async () => {
    const m = await h.pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(m.rows.map((r) => r.version)).toEqual(['001_foundation.sql', '002_reference_data.sql']);
    const c = await h.pool.query('SELECT count(*)::int AS n FROM cities');
    expect(c.rows[0].n).toBeGreaterThanOrEqual(20);
  });

  it('seed permissions: finance role cannot read audit logs or documents; support cannot touch finance', async () => {
    const q = (role: string) =>
      h.pool
        .query('SELECT permission_key FROM role_permissions WHERE role_key = $1', [role])
        .then((r) => r.rows.map((x) => x.permission_key));
    const finance = await q('finance_operator');
    expect(finance).toEqual(expect.arrayContaining(['finance:read', 'finance:refund']));
    expect(finance).not.toContain('audit:read');
    expect(finance).not.toContain('verification:review');
    const support = await q('support_agent');
    expect(support.some((p) => p.startsWith('finance:'))).toBe(false);
  });

  it('the CHECK constraint alone prevents overbooking, even for raw SQL that bypasses the application', async () => {
    const reviewer = await newStaff(h, 'verification_reviewer');
    const driver = await newVerifiedDriver(h, reviewer);
    const ids = await cityIds(h);
    const trip = await publishTrip(h, driver, ids, { seatsTotal: 2 });
    await expect(
      h.pool.query('UPDATE trip_segments SET seats_booked = 3 WHERE trip_id = $1 AND seq = 0', [trip.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'segment_not_overbooked' });
    await expect(
      h.pool.query('UPDATE trip_segments SET seats_booked = -1 WHERE trip_id = $1 AND seq = 0', [trip.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a passenger cannot hold two active bookings on one trip (partial unique index)', async () => {
    const reviewer = await newStaff(h, 'verification_reviewer');
    const driver = await newVerifiedDriver(h, reviewer);
    const trip = await publishTrip(h, driver, await cityIds(h));
    const [p] = await makePassengers(h.pool, 1);
    const ins = () =>
      h.pool.query(
        `INSERT INTO bookings(trip_id, passenger_id, from_stop_seq, to_stop_seq, seats, status, price_total_minor) VALUES ($1,$2,0,1,1,'confirmed',100)`,
        [trip.id, p.id],
      );
    await ins();
    await expect(ins()).rejects.toMatchObject({
      code: '23505',
      constraint: 'bookings_one_active_per_passenger',
    });
    // after cancellation a new booking is allowed again
    await h.pool.query(`UPDATE bookings SET status='cancelled' WHERE trip_id=$1 AND passenger_id=$2`, [
      trip.id,
      p.id,
    ]);
    await expect(ins()).resolves.toBeDefined();
  });

  it('trips must arrive after they depart and stops are unique per sequence', async () => {
    const reviewer = await newStaff(h, 'verification_reviewer');
    const driver = await newVerifiedDriver(h, reviewer);
    const trip = await publishTrip(h, driver, await cityIds(h));
    await expect(
      h.pool.query(`UPDATE trips SET arrival_at = departure_at WHERE id = $1`, [trip.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.pool.query(
        `INSERT INTO trip_stops(trip_id, seq, city_id, name, location, offset_minutes)
                    SELECT trip_id, seq, city_id, 'dup', location, 5 FROM trip_stops WHERE id = $1`,
        [trip.stops[0].id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const res = await request(h.http).get(`/api/v1/trips/${trip.id}`).expect(200);
    expect(res.body.id).toBe(trip.id);
  });
});
