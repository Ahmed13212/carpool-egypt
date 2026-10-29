import {
  asAuthUser,
  cityIds,
  expectInventoryConsistent,
  futureAt,
  idemKey,
  makePassengers,
  newStaff,
  newVerifiedDriver,
  publishTrip,
  startHarness,
  withSetting,
  Harness,
} from '../helpers';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? e.constructor.name,
  );

describe('booking engine (service level, real PostgreSQL)', () => {
  let h: Harness;
  let reviewer: Awaited<ReturnType<typeof newStaff>>;
  let ids: Record<string, string>;
  beforeAll(async () => {
    h = await startHarness();
    reviewer = await newStaff(h, 'verification_reviewer');
    ids = await cityIds(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const setup = async (over: Record<string, unknown> = {}) => {
    const driver = await newVerifiedDriver(h, reviewer);
    const trip = await publishTrip(h, driver, ids, over);
    return { driver, trip, s: (i: number) => trip.stops[i].id };
  };

  it('instant trip: booking is confirmed immediately and seats are held on the covered segments only', async () => {
    const { trip, s } = await setup({ bookingMode: 'instant' });
    const [p] = await makePassengers(h.pool, 1);
    const r = await h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 2 }, idemKey());
    expect(r.replayed).toBe(false);
    expect(r.booking).toMatchObject({
      status: 'confirmed',
      seats: 2,
      priceTotalMinor: 20000,
      fromStopSeq: 0,
      toStopSeq: 1,
    });
    const seg = await h.pool.query(
      'SELECT seq, seats_booked FROM trip_segments WHERE trip_id=$1 ORDER BY seq',
      [trip.id],
    );
    expect(seg.rows.map((x) => x.seats_booked)).toEqual([2, 0]);
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('a seat freed at an intermediate stop is resold on the later segment (segment-based inventory)', async () => {
    const { trip, s } = await setup({ bookingMode: 'instant', seatsTotal: 1 });
    const [a, b, c] = await makePassengers(h.pool, 3);
    await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey()); // cairo -> minya
    await h.bookings.create(b, trip.id, { fromStopId: s(1), toStopId: s(2), seats: 1 }, idemKey()); // minya -> asyut: same physical seat
    expect(
      await code(h.bookings.create(c, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey())),
    ).toBe('seat_unavailable');
    expect(
      await code(h.bookings.create(c, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey())),
    ).toBe('seat_unavailable');
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('approval flow: pending -> driver confirms; reject releases seats; wrong driver sees 404', async () => {
    const { driver, trip, s } = await setup({ seatsTotal: 2 });
    const other = await newVerifiedDriver(h, reviewer);
    const [a, b] = await makePassengers(h.pool, 2);
    const ba = (
      await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey())
    ).booking;
    const bb = (
      await h.bookings.create(b, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey())
    ).booking;
    expect(ba.status).toBe('pending_approval');
    expect(ba.expiresAt).not.toBeNull();
    expect(await code(h.bookings.decide(asAuthUser(other), ba.id, 'confirm'))).toBe('not_found');
    expect(await code(h.bookings.decide(a, ba.id, 'confirm'))).toBe('not_found'); // passengers cannot self-approve
    const confirmed = await h.bookings.decide(asAuthUser(driver), ba.id, 'confirm');
    expect(confirmed).toMatchObject({ status: 'confirmed', expiresAt: null });
    expect(await code(h.bookings.decide(asAuthUser(driver), ba.id, 'confirm'))).toBe(
      'invalid_booking_transition',
    );
    expect((await h.bookings.decide(asAuthUser(driver), bb.id, 'reject', 'full')).status).toBe('rejected');
    const seg = await h.pool.query('SELECT seats_booked FROM trip_segments WHERE trip_id=$1', [trip.id]);
    expect(seg.rows.map((x) => x.seats_booked)).toEqual([1, 1]);
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('cancel releases seats, records history, and cannot be repeated; outsiders see 404', async () => {
    const { trip, s } = await setup({ bookingMode: 'instant' });
    const [a, outsider] = await makePassengers(h.pool, 2);
    const b = (await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 3 }, idemKey()))
      .booking;
    expect(await code(h.bookings.cancel(outsider, b.id))).toBe('not_found');
    const c = await h.bookings.cancel(a, b.id, 'changed plans');
    expect(c.status).toBe('cancelled');
    expect(await code(h.bookings.cancel(a, b.id))).toBe('invalid_booking_transition');
    const hist = await h.pool.query(
      'SELECT to_status FROM booking_status_history WHERE booking_id=$1 ORDER BY id',
      [b.id],
    );
    expect(hist.rows.map((x) => x.to_status)).toEqual(['confirmed', 'cancelled']);
    await expectInventoryConsistent(h.pool, trip.id);
    // seats are sellable again
    await expect(
      h.bookings.create(outsider, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 3 }, idemKey()),
    ).resolves.toBeDefined();
  });

  it('idempotency: same key replays the stored response; same key with a different body is rejected', async () => {
    const { trip, s } = await setup({ bookingMode: 'instant' });
    const [a] = await makePassengers(h.pool, 1);
    const key = idemKey();
    const first = await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, key);
    const second = await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, key);
    expect(second.replayed).toBe(true);
    expect(second.booking.id).toBe(first.booking.id);
    expect(
      await code(h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 2 }, key)),
    ).toBe('idempotency_key_reuse');
    const n = await h.pool.query('SELECT count(*)::int AS n FROM bookings WHERE trip_id=$1', [trip.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('rejects duplicates, own-trip bookings, bad stop pairs, unverified e-mail and closed departures', async () => {
    const { driver, trip, s } = await setup({ bookingMode: 'instant' });
    const [a] = await makePassengers(h.pool, 1);
    await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey());
    expect(
      await code(h.bookings.create(a, trip.id, { fromStopId: s(1), toStopId: s(2), seats: 1 }, idemKey())),
    ).toBe('duplicate_booking');
    expect(
      await code(
        h.bookings.create(
          asAuthUser(driver),
          trip.id,
          { fromStopId: s(0), toStopId: s(1), seats: 1 },
          idemKey(),
        ),
      ),
    ).toBe('cannot_book_own_trip');
    const [b] = await makePassengers(h.pool, 1);
    expect(
      await code(h.bookings.create(b, trip.id, { fromStopId: s(2), toStopId: s(0), seats: 1 }, idemKey())),
    ).toBe('invalid_stops');
    expect(
      await code(
        h.bookings.create(
          { ...b, emailVerified: false },
          trip.id,
          { fromStopId: s(0), toStopId: s(1), seats: 1 },
          idemKey(),
        ),
      ),
    ).toBe('email_not_verified');
    // departure becomes too close -> booking closed
    await h.pool.query(
      `UPDATE trips SET departure_at = now() + interval '5 minutes', arrival_at = now() + interval '9 hours' WHERE id = $1`,
      [trip.id],
    );
    expect(
      await code(h.bookings.create(b, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey())),
    ).toBe('booking_closed');
    // failed attempts leave no seats held and no stray idempotency rows that would block a retry
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('operational flag: booking_enabled=false blocks new bookings', async () => {
    const { trip, s } = await setup({ bookingMode: 'instant' });
    const [a] = await makePassengers(h.pool, 1);
    await withSetting(h.pool, 'booking_enabled', false, async () => {
      expect(
        await code(h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey())),
      ).toBe('feature_disabled');
    });
    await expect(
      h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey()),
    ).resolves.toBeDefined();
  });

  it('expiry: stale pending bookings are expired once and their seats released (idempotent)', async () => {
    const { trip, s } = await setup({ seatsTotal: 1 });
    const [a, b] = await makePassengers(h.pool, 2);
    const bk = (
      await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey())
    ).booking;
    expect(
      await code(h.bookings.create(b, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey())),
    ).toBe('seat_unavailable');
    await h.pool.query(`UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [bk.id]);
    expect(await h.bookings.expireStale()).toBeGreaterThanOrEqual(1);
    expect(await h.bookings.expireStale()).toBe(0);
    const row = await h.pool.query('SELECT status, expires_at FROM bookings WHERE id=$1', [bk.id]);
    expect(row.rows[0]).toMatchObject({ status: 'expired', expires_at: null });
    await expectInventoryConsistent(h.pool, trip.id);
    await expect(
      h.bookings.create(b, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey()),
    ).resolves.toBeDefined();
  });

  it('payments_enabled=true: instant booking waits for payment; the driver cannot bypass payment; hold expires', async () => {
    await withSetting(h.pool, 'payments_enabled', true, async () => {
      const { driver, trip, s } = await setup({ bookingMode: 'instant', seatsTotal: 1 });
      const [a] = await makePassengers(h.pool, 1);
      const bk = (
        await h.bookings.create(a, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey())
      ).booking;
      expect(bk.status).toBe('awaiting_payment');
      expect(bk.expiresAt).not.toBeNull();
      expect(await code(h.bookings.decide(asAuthUser(driver), bk.id, 'confirm'))).toBe(
        'invalid_booking_transition',
      );
      await h.pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [
        bk.id,
      ]);
      await h.bookings.expireStale();
      expect((await h.pool.query('SELECT status FROM bookings WHERE id=$1', [bk.id])).rows[0].status).toBe(
        'expired',
      );
      await expectInventoryConsistent(h.pool, trip.id);
    });
  });

  it('driver cancel of a trip cancels every held booking and zeroes inventory; editing departure is blocked while bookings exist', async () => {
    const { driver, trip, s } = await setup({ bookingMode: 'instant' });
    const ps = await makePassengers(h.pool, 3);
    for (const p of ps)
      await h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey());
    await expect(
      h.trips.update(asAuthUser(driver), trip.id, { departureAt: futureAt(5).toISOString() }),
    ).rejects.toMatchObject({ code: 'trip_has_bookings' });
    await expect(
      h.trips.update(asAuthUser(driver), trip.id, { bookingMode: 'approval', notes: 'no smoking' }),
    ).resolves.toMatchObject({ bookingMode: 'approval', notes: 'no smoking' });
    await h.trips.cancel(asAuthUser(driver), trip.id, 'car trouble');
    const b = await h.pool.query(
      `SELECT status, count(*)::int AS n FROM bookings WHERE trip_id=$1 GROUP BY status`,
      [trip.id],
    );
    expect(b.rows).toEqual([{ status: 'cancelled', n: 3 }]);
    await expectInventoryConsistent(h.pool, trip.id);
    expect(
      await code(
        h.bookings.create(ps[0], trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey()),
      ),
    ).toBe('trip_not_bookable');
  });

  it('publishing guards: overlapping trips for one driver are rejected; departure edit works without bookings', async () => {
    const { driver, trip } = await setup();
    await expect(publishTrip(h, driver, ids)).rejects.toThrow(/trip_overlap/);
    const moved = await h.trips.update(asAuthUser(driver), trip.id, {
      departureAt: futureAt(6).toISOString(),
    });
    expect(new Date(moved.departureAt).toISOString()).toBe(futureAt(6).toISOString());
    await expect(publishTrip(h, driver, ids)).resolves.toBeDefined(); // original slot is free again
  });
});
