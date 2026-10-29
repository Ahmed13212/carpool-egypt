import request from 'supertest';
import {
  bearer,
  cityIds,
  COORDS,
  futureAt,
  idemKey,
  newStaff,
  newUser,
  newVerifiedDriver,
  publishTrip,
  startHarness,
  tripPayload,
  Harness,
  TestUser,
} from '../helpers';

const api = '/api/v1';

describe('marketplace journey and authorization (HTTP)', () => {
  let h: Harness;
  let ids: Record<string, string>;
  let reviewer: TestUser, admin: TestUser, superAdmin: TestUser, finance: TestUser, support: TestUser;
  beforeAll(async () => {
    h = await startHarness();
    ids = await cityIds(h);
    [reviewer, admin, superAdmin, finance, support] = await Promise.all([
      newStaff(h, 'verification_reviewer'),
      newStaff(h, 'administrator'),
      newStaff(h, 'super_administrator'),
      newStaff(h, 'finance_operator'),
      newStaff(h, 'support_agent'),
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  describe('publishing requires verification', () => {
    it('passengers, unverified-email users and pending drivers cannot publish', async () => {
      const passenger = await newUser(h);
      const body = tripPayload(ids, '00000000-0000-4000-8000-000000000000');
      await request(h.http).post(`${api}/trips`).set(bearer(passenger.token)).send(body).expect(403);
      await request(h.http).post(`${api}/trips`).expect(401);

      const unverified = await newUser(h, 'No Verify', false);
      await request(h.http).post(`${api}/drivers/apply`).set(bearer(unverified.token)).expect(403); // e-mail not verified

      const pending = await newUser(h);
      const st = await request(h.http).post(`${api}/drivers/apply`).set(bearer(pending.token)).expect(200);
      expect(st.body.verificationStatus).toBe('pending_review');
      await request(h.http).post(`${api}/trips`).set(bearer(pending.token)).send(body).expect(403); // lacks trip:publish
    });

    it('rejected applications stay unable to publish; an applicant cannot self-approve or self-grant roles', async () => {
      const d = await newUser(h);
      await request(h.http).post(`${api}/drivers/apply`).set(bearer(d.token)).expect(200);
      await request(h.http).post(`${api}/admin/drivers/${d.id}/approve`).set(bearer(d.token)).expect(403);
      await request(h.http)
        .post(`${api}/admin/users/${d.id}/roles`)
        .set(bearer(d.token))
        .send({ role: 'administrator' })
        .expect(403);
      await request(h.http)
        .post(`${api}/admin/drivers/${d.id}/reject`)
        .set(bearer(reviewer.token))
        .send({ reason: 'documents unreadable' })
        .expect(204);
      expect(
        (await request(h.http).get(`${api}/me/driver`).set(bearer(d.token)).expect(200)).body,
      ).toMatchObject({ verificationStatus: 'rejected', rejectionReason: 'documents unreadable' });
      const v = await request(h.http)
        .post(`${api}/vehicles`)
        .set(bearer(d.token))
        .send({ make: 'Kia', model: 'Rio', color: 'Red', seats: 5, plateNumber: 'ABC 123' })
        .expect(201);
      await request(h.http)
        .post(`${api}/trips`)
        .set(bearer(d.token))
        .send(tripPayload(ids, v.body.id))
        .expect(403);
    });

    it('an approved driver still needs an approved vehicle, and may only use their own vehicle', async () => {
      const d = await newUser(h);
      await request(h.http).post(`${api}/drivers/apply`).set(bearer(d.token)).expect(200);
      await request(h.http)
        .post(`${api}/admin/drivers/${d.id}/approve`)
        .set(bearer(reviewer.token))
        .expect(204);
      const v = await request(h.http)
        .post(`${api}/vehicles`)
        .set(bearer(d.token))
        .send({ make: 'Kia', model: 'Rio', color: 'Red', seats: 5, plateNumber: 'XYZ 987' })
        .expect(201);
      await request(h.http)
        .post(`${api}/trips`)
        .set(bearer(d.token))
        .send(tripPayload(ids, v.body.id))
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('vehicle_not_verified'));
      const other = await newVerifiedDriver(h, reviewer);
      await request(h.http)
        .post(`${api}/trips`)
        .set(bearer(d.token))
        .send(tripPayload(ids, other.vehicleId))
        .expect(404);
    });

    it('operational flag: trip_publishing_enabled=false blocks publishing', async () => {
      const d = await newVerifiedDriver(h, reviewer);
      await h.pool.query(`UPDATE platform_settings SET value='false' WHERE key='trip_publishing_enabled'`);
      try {
        await request(h.http)
          .post(`${api}/trips`)
          .set(bearer(d.token))
          .send(tripPayload(ids, d.vehicleId))
          .expect(403)
          .expect((r) => expect(r.body.error.code).toBe('feature_disabled'));
      } finally {
        await h.pool.query(`UPDATE platform_settings SET value='true' WHERE key='trip_publishing_enabled'`);
      }
    });
  });

  describe('trip validation over HTTP', () => {
    it.each([
      ['price above platform maximum', { segmentPricesMinor: [10000, 900000] }],
      ['seats above vehicle capacity', { seatsTotal: 5 }],
      ['departure in the past', { departureAt: new Date(Date.now() - 3600_000).toISOString() }],
      ['non-increasing stop offsets', {}],
      ['unknown field types', { seatsTotal: '3' }],
    ])('rejects %s', async (name, over) => {
      const d = await newVerifiedDriver(h, reviewer);
      const payload: any = tripPayload(ids, d.vehicleId, over);
      if (name === 'non-increasing stop offsets') payload.stops[2].offsetMinutes = 100;
      await request(h.http).post(`${api}/trips`).set(bearer(d.token)).send(payload).expect(400);
    });
    it('rejects a stop outside Egypt and an unknown city', async () => {
      const d = await newVerifiedDriver(h, reviewer);
      const p: any = tripPayload(ids, d.vehicleId);
      p.stops[1].lat = 48.85;
      p.stops[1].lng = 2.35;
      await request(h.http).post(`${api}/trips`).set(bearer(d.token)).send(p).expect(400);
      const q: any = tripPayload(ids, d.vehicleId);
      q.stops[1].cityId = '11111111-1111-4111-8111-111111111111';
      await request(h.http).post(`${api}/trips`).set(bearer(d.token)).send(q).expect(400);
    });
  });

  describe('search', () => {
    let driver: Awaited<ReturnType<typeof newVerifiedDriver>>;
    let trip: Awaited<ReturnType<typeof publishTrip>>;
    const day = 21;
    const date = futureAt(day).toISOString().slice(0, 10);
    beforeAll(async () => {
      driver = await newVerifiedDriver(h, reviewer);
      trip = await publishTrip(h, driver, ids, {
        departureAt: futureAt(day).toISOString(),
        bookingMode: 'instant',
        seatsTotal: 2,
      });
    });
    const search = (qs: string) => request(h.http).get(`${api}/trips/search?${qs}`).expect(200);
    const found = (res: request.Response) => res.body.items.some((i: any) => i.tripId === trip.id);

    it('matches by city and date, prices the requested sub-route from segments, and exposes no private data', async () => {
      const r = await search(`fromCity=cairo&toCity=asyut&date=${date}&seats=2`);
      const item = r.body.items.find((i: any) => i.tripId === trip.id);
      expect(item).toMatchObject({
        pricePerSeatMinor: 18000,
        totalPriceMinor: 36000,
        seatsAvailable: 2,
        currency: 'EGP',
      });
      const sub = (await search(`fromCity=minya&toCity=asyut&date=${date}`)).body.items.find(
        (i: any) => i.tripId === trip.id,
      );
      expect(sub.pricePerSeatMinor).toBe(8000); // intermediate pick-up
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(driver.email);
      expect(text).not.toContain(driver.plate);
    });
    it('is direction-aware and date-aware', async () => {
      expect(found(await search(`fromCity=asyut&toCity=cairo&date=${date}`))).toBe(false);
      expect(
        found(
          await search(
            `fromCity=cairo&toCity=asyut&date=${futureAt(day + 1)
              .toISOString()
              .slice(0, 10)}`,
          ),
        ),
      ).toBe(false);
    });
    it('geographic search uses PostGIS proximity to the trip stops', async () => {
      const [lat, lng] = COORDS.cairo;
      const near = await search(
        `fromLat=${lat + 0.02}&fromLng=${lng + 0.02}&fromRadiusKm=10&toCity=asyut&date=${date}`,
      );
      expect(found(near)).toBe(true);
      const [alat, alng] = COORDS.alexandria;
      expect(
        found(await search(`fromLat=${alat}&fromLng=${alng}&fromRadiusKm=10&toCity=asyut&date=${date}`)),
      ).toBe(false);
    });
    it('filters by price and seats, sorts, paginates and validates input', async () => {
      expect(found(await search(`fromCity=cairo&toCity=asyut&date=${date}&maxPriceMinor=1000`))).toBe(false);
      expect(found(await search(`fromCity=cairo&toCity=asyut&date=${date}&seats=3`))).toBe(false); // only 2 seats on the trip
      const p = await search(`fromCity=cairo&toCity=asyut&sort=price&pageSize=1&page=1`);
      expect(p.body.items.length).toBeLessThanOrEqual(1);
      expect(p.body.total).toBeGreaterThanOrEqual(1);
      await request(h.http).get(`${api}/trips/search?toCity=asyut`).expect(400);
      await request(h.http).get(`${api}/trips/search?fromCity=cairo&toCity=asyut&pageSize=1000`).expect(400);
      await request(h.http).get(`${api}/trips/search?fromCity=cairo'%20OR%201=1--&toCity=asyut`).expect(200); // injection string is just an unknown slug
    });
    it('a fully booked route disappears from results', async () => {
      const p1 = await newUser(h);
      const p2 = await newUser(h);
      for (const p of [p1, p2]) {
        await request(h.http)
          .post(`${api}/trips/${trip.id}/bookings`)
          .set(bearer(p.token))
          .set('Idempotency-Key', idemKey())
          .send({ fromStopId: trip.stops[0].id, toStopId: trip.stops[2].id, seats: 1 })
          .expect(201);
      }
      expect(found(await search(`fromCity=cairo&toCity=asyut&date=${date}`))).toBe(false);
      expect(found(await search(`fromCity=cairo&toCity=minya&date=${date}`))).toBe(false);
    });
  });

  describe('booking journey with object-level authorization', () => {
    it('book -> driver confirms -> passenger cancels -> seats return; every other actor is blocked', async () => {
      const driver = await newVerifiedDriver(h, reviewer);
      const otherDriver = await newVerifiedDriver(h, reviewer);
      const trip = await publishTrip(h, driver, ids, {
        departureAt: futureAt(8).toISOString(),
        seatsTotal: 2,
      });
      const [a, stranger] = [await newUser(h), await newUser(h)];
      const body = { fromStopId: trip.stops[0].id, toStopId: trip.stops[1].id, seats: 1 };

      await request(h.http)
        .post(`${api}/trips/${trip.id}/bookings`)
        .set(bearer(a.token))
        .send(body)
        .expect(400)
        .expect((r) => expect(r.body.error.code).toBe('idempotency_key_required'));
      const key = idemKey();
      const created = await request(h.http)
        .post(`${api}/trips/${trip.id}/bookings`)
        .set(bearer(a.token))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(created.body).toMatchObject({
        status: 'pending_approval',
        seats: 1,
        priceTotalMinor: 10000,
        currency: 'EGP',
      });
      const replay = await request(h.http)
        .post(`${api}/trips/${trip.id}/bookings`)
        .set(bearer(a.token))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body.id).toBe(created.body.id);
      await request(h.http)
        .post(`${api}/trips/${trip.id}/bookings`)
        .set(bearer(a.token))
        .set('Idempotency-Key', key)
        .send({ ...body, seats: 2 })
        .expect(422);
      const id = created.body.id;

      // object-level access
      await request(h.http).get(`${api}/bookings/${id}`).set(bearer(a.token)).expect(200);
      await request(h.http).get(`${api}/bookings/${id}`).set(bearer(driver.token)).expect(200);
      await request(h.http).get(`${api}/bookings/${id}`).set(bearer(support.token)).expect(200); // bookings:read:any
      await request(h.http).get(`${api}/bookings/${id}`).set(bearer(stranger.token)).expect(404);
      await request(h.http).get(`${api}/bookings/${id}`).set(bearer(otherDriver.token)).expect(404);
      await request(h.http).get(`${api}/bookings/${id}`).set(bearer(finance.token)).expect(404); // finance has no booking access
      await request(h.http).get(`${api}/trips/${trip.id}/bookings`).set(bearer(stranger.token)).expect(404);
      expect(
        (await request(h.http).get(`${api}/trips/${trip.id}/bookings`).set(bearer(driver.token)).expect(200))
          .body.total,
      ).toBe(1);

      // decisions
      await request(h.http).post(`${api}/bookings/${id}/confirm`).set(bearer(a.token)).expect(404);
      await request(h.http).post(`${api}/bookings/${id}/confirm`).set(bearer(otherDriver.token)).expect(404);
      await request(h.http).post(`${api}/bookings/${id}/cancel`).set(bearer(stranger.token)).expect(404);
      const conf = await request(h.http)
        .post(`${api}/bookings/${id}/confirm`)
        .set(bearer(driver.token))
        .expect(200);
      expect(conf.body.status).toBe('confirmed');

      const mine = await request(h.http).get(`${api}/me/bookings`).set(bearer(a.token)).expect(200);
      expect(mine.body.items.map((b: any) => b.id)).toEqual([id]);
      expect(
        (await request(h.http).get(`${api}/me/bookings`).set(bearer(stranger.token)).expect(200)).body.total,
      ).toBe(0);

      const before = await request(h.http).get(`${api}/trips/${trip.id}`).expect(200);
      expect(before.body.segments.map((s: any) => s.seatsAvailable)).toEqual([1, 2]);
      await request(h.http)
        .post(`${api}/bookings/${id}/cancel`)
        .set(bearer(a.token))
        .send({ reason: 'plans changed' })
        .expect(200);
      const after = await request(h.http).get(`${api}/trips/${trip.id}`).expect(200);
      expect(after.body.segments.map((s: any) => s.seatsAvailable)).toEqual([2, 2]);
      const detail = await request(h.http).get(`${api}/bookings/${id}`).set(bearer(a.token)).expect(200);
      expect(detail.body.history.map((x: any) => x.to)).toEqual([
        'pending_approval',
        'confirmed',
        'cancelled',
      ]);
    });

    it('public trip view never contains plate number, e-mail or phone', async () => {
      const driver = await newVerifiedDriver(h, reviewer);
      await request(h.http)
        .patch(`${api}/me`)
        .set(bearer(driver.token))
        .send({ phone: '+201112223334' })
        .expect(200);
      const trip = await publishTrip(h, driver, ids, { departureAt: futureAt(9).toISOString() });
      const text = JSON.stringify((await request(h.http).get(`${api}/trips/${trip.id}`).expect(200)).body);
      for (const secret of [driver.plate, driver.email, '+201112223334', 'password'])
        expect(text).not.toContain(secret);
      await request(h.http).get(`${api}/trips/11111111-1111-4111-8111-111111111111`).expect(404);
    });

    it('trip edit/cancel authorization: strangers get 404, admins with trips:cancel:any can cancel with an audit entry', async () => {
      const driver = await newVerifiedDriver(h, reviewer);
      const stranger = await newVerifiedDriver(h, reviewer);
      const trip = await publishTrip(h, driver, ids, { departureAt: futureAt(10).toISOString() });
      await request(h.http)
        .patch(`${api}/trips/${trip.id}`)
        .set(bearer(stranger.token))
        .send({ notes: 'hijack' })
        .expect(404);
      await request(h.http).post(`${api}/trips/${trip.id}/cancel`).set(bearer(stranger.token)).expect(404);
      await request(h.http).post(`${api}/trips/${trip.id}/cancel`).set(bearer(support.token)).expect(404); // support lacks trips:cancel:any
      await request(h.http)
        .post(`${api}/trips/${trip.id}/cancel`)
        .set(bearer(admin.token))
        .send({ reason: 'policy violation' })
        .expect(200);
      const logs = await request(h.http)
        .get(`${api}/admin/audit-logs?action=trip.cancelled_by_admin&pageSize=50`)
        .set(bearer(admin.token))
        .expect(200);
      expect(
        logs.body.items.some((l: any) => l.targetId === trip.id && l.metadata.reason === 'policy violation'),
      ).toBe(true);
      await request(h.http).post(`${api}/trips/${trip.id}/cancel`).set(bearer(driver.token)).expect(409);
    });
  });

  describe('administrative permission boundaries', () => {
    it('each staff role can do only its own work', async () => {
      const u = await newUser(h);
      // finance: no user management, no audit logs, no verification
      await request(h.http).get(`${api}/admin/users`).set(bearer(finance.token)).expect(403);
      await request(h.http).get(`${api}/admin/audit-logs`).set(bearer(finance.token)).expect(403);
      await request(h.http)
        .post(`${api}/admin/drivers/${u.id}/approve`)
        .set(bearer(finance.token))
        .expect(403);
      // support: can read users, cannot suspend or review
      await request(h.http)
        .get(`${api}/admin/users?q=${encodeURIComponent(u.email)}`)
        .set(bearer(support.token))
        .expect(200)
        .expect((r) => expect(r.body.total).toBe(1));
      await request(h.http)
        .post(`${api}/admin/users/${u.id}/suspend`)
        .set(bearer(support.token))
        .send({ reason: 'nope nope' })
        .expect(403);
      // reviewer: verification only
      await request(h.http).get(`${api}/admin/users`).set(bearer(reviewer.token)).expect(403);
      // admin: cannot assign roles or touch staff accounts; super can
      await request(h.http)
        .post(`${api}/admin/users/${u.id}/roles`)
        .set(bearer(admin.token))
        .send({ role: 'support_agent' })
        .expect(403);
      await request(h.http)
        .post(`${api}/admin/users/${support.id}/suspend`)
        .set(bearer(admin.token))
        .send({ reason: 'test staff' })
        .expect(403);
      await request(h.http)
        .post(`${api}/admin/users/${u.id}/roles`)
        .set(bearer(superAdmin.token))
        .send({ role: 'support_agent' })
        .expect(204);
      await request(h.http)
        .post(`${api}/admin/users/${u.id}/roles`)
        .set(bearer(superAdmin.token))
        .send({ role: 'super_administrator' })
        .expect(400); // not grantable via API
      // self-suspension forbidden
      await request(h.http)
        .post(`${api}/admin/users/${admin.id}/suspend`)
        .set(bearer(admin.token))
        .send({ reason: 'self harm?' })
        .expect(403);
      // regular users: nothing under /admin
      const plain = await newUser(h);
      for (const path of ['users', 'audit-logs', 'settings'])
        await request(h.http).get(`${api}/admin/${path}`).set(bearer(plain.token)).expect(403);
      await request(h.http).get(`${api}/admin/users`).expect(401);
    });

    it('settings: validated, audited; unknown keys rejected; only settings:write may change them', async () => {
      await request(h.http)
        .put(`${api}/admin/settings/max_segment_price_minor`)
        .set(bearer(support.token))
        .send({ value: 1 })
        .expect(403);
      await request(h.http)
        .put(`${api}/admin/settings/max_segment_price_minor`)
        .set(bearer(admin.token))
        .send({ value: 'lots' })
        .expect(400);
      await request(h.http)
        .put(`${api}/admin/settings/not_a_setting`)
        .set(bearer(admin.token))
        .send({ value: 1 })
        .expect(404);
      await request(h.http)
        .put(`${api}/admin/settings/min_booking_lead_minutes`)
        .set(bearer(admin.token))
        .send({ value: 45 })
        .expect(204);
      try {
        expect(
          (await request(h.http).get(`${api}/admin/settings`).set(bearer(admin.token)).expect(200)).body
            .min_booking_lead_minutes,
        ).toBe(45);
        const logs = await request(h.http)
          .get(`${api}/admin/audit-logs?action=setting.changed`)
          .set(bearer(admin.token))
          .expect(200);
        expect(logs.body.items[0].metadata).toMatchObject({ to: 45 });
      } finally {
        await h.pool.query(`UPDATE platform_settings SET value='30' WHERE key='min_booking_lead_minutes'`);
      }
    });
  });
});
