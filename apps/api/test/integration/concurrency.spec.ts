import { AppError } from '../../src/common/app-error';
import {
  asAuthUser,
  cityIds,
  expectInventoryConsistent,
  idemKey,
  makePassengers,
  newStaff,
  newVerifiedDriver,
  publishTrip,
  startHarness,
  Harness,
} from '../helpers';

/** Every failure must be a deliberate domain error; a raw pg error (deadlock 40P01, serialization, check violation) fails the test. */
function expectOnlyDomainErrors(results: PromiseSettledResult<unknown>[], allowed: string[]) {
  for (const r of results) {
    if (r.status === 'rejected') {
      expect(r.reason).toBeInstanceOf(AppError);
      expect(allowed).toContain((r.reason as AppError).code);
    }
  }
}

describe('concurrency: simultaneous bookings never exceed capacity on any segment', () => {
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
    const trip = await publishTrip(h, driver, ids, { bookingMode: 'instant', ...over });
    return { driver, trip, s: (i: number) => trip.stops[i].id };
  };

  it('30 passengers race for 3 seats on the full route: exactly 3 succeed', async () => {
    const { trip, s } = await setup({ seatsTotal: 3 });
    const ps = await makePassengers(h.pool, 30);
    const results = await Promise.allSettled(
      ps.map((p) => h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey())),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expectOnlyDomainErrors(results, ['seat_unavailable']);
    const seg = await h.pool.query('SELECT seats_booked FROM trip_segments WHERE trip_id=$1 ORDER BY seq', [
      trip.id,
    ]);
    expect(seg.rows.map((x) => x.seats_booked)).toEqual([3, 3]);
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('multi-seat requests: 12 passengers want 2 seats each on a 3-seat trip -> exactly 1 succeeds', async () => {
    const { trip, s } = await setup({ seatsTotal: 3 });
    const ps = await makePassengers(h.pool, 12);
    const results = await Promise.allSettled(
      ps.map((p) => h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 2 }, idemKey())),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1); // 2 <= 3 but 2 + 2 = 4 > 3
    expectOnlyDomainErrors(results, ['seat_unavailable']);
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('mixed overlapping routes (capacity 2, 4 stops, 40 random requests): invariants hold and no raw DB errors', async () => {
    const driver = await newVerifiedDriver(h, reviewer);
    const stop = (slug: string, offsetMinutes: number, lat: number, lng: number) => ({
      cityId: ids[slug],
      name: `${slug} stn`,
      lat,
      lng,
      offsetMinutes,
    });
    const trip = await publishTrip(h, driver, ids, {
      bookingMode: 'instant',
      seatsTotal: 2,
      stops: [
        stop('cairo', 0, 30.04, 31.23),
        stop('beni-suef', 100, 29.06, 31.09),
        stop('minya', 200, 28.11, 30.75),
        stop('asyut', 300, 27.17, 31.18),
      ],
      segmentPricesMinor: [5000, 5000, 5000],
    });
    const ps = await makePassengers(h.pool, 40);
    // deterministic pseudo-random request mix
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const reqs = ps.map((p) => {
      const a = rnd(3);
      const b = a + 1 + rnd(3 - a);
      return h.bookings.create(
        p,
        trip.id,
        { fromStopId: trip.stops[a].id, toStopId: trip.stops[b].id, seats: 1 + rnd(2) },
        idemKey(),
      );
    });
    const results = await Promise.allSettled(reqs);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(2);
    expectOnlyDomainErrors(results, ['seat_unavailable']);
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('8 parallel retries with the SAME idempotency key create exactly one booking', async () => {
    const { trip, s } = await setup({ seatsTotal: 3 });
    const [p] = await makePassengers(h.pool, 1);
    const key = idemKey();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 2 }, key),
      ),
    );
    expect(new Set(results.map((r) => r.booking.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const n = await h.pool.query('SELECT count(*)::int AS n FROM bookings WHERE trip_id=$1', [trip.id]);
    expect(n.rows[0].n).toBe(1);
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('one passenger firing 6 parallel requests with different keys gets exactly one active booking', async () => {
    const { trip, s } = await setup({ seatsTotal: 3 });
    const [p] = await makePassengers(h.pool, 1);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(1), seats: 1 }, idemKey()),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expectOnlyDomainErrors(results, ['duplicate_booking']);
    await expectInventoryConsistent(h.pool, trip.id);
  });

  it('bookings racing against cancellations, driver decisions and a trip cancellation: no deadlocks, consistent final state', async () => {
    for (let round = 0; round < 3; round++) {
      const { driver, trip, s } = await setup({
        seatsTotal: 4,
        bookingMode: round % 2 ? 'instant' : 'approval',
      });
      const ps = await makePassengers(h.pool, 20);
      // seed a few bookings that will be cancelled / decided during the race
      const seeded = await Promise.all(
        ps
          .slice(0, 4)
          .map((p) =>
            h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey()),
          ),
      );
      const ops: Promise<unknown>[] = [];
      ps.slice(4).forEach((p) =>
        ops.push(
          h.bookings.create(
            p,
            trip.id,
            { fromStopId: s(0), toStopId: s(1 + (round % 2)), seats: 1 },
            idemKey(),
          ),
        ),
      );
      seeded.slice(0, 2).forEach((b, i) => ops.push(h.bookings.cancel(ps[i], b.booking.id)));
      seeded.slice(2).forEach((b) => ops.push(h.bookings.decide(asAuthUser(driver), b.booking.id, 'reject')));
      ops.push(h.trips.cancel(asAuthUser(driver), trip.id, 'race'));
      const results = await Promise.allSettled(ops);
      expectOnlyDomainErrors(results, [
        'seat_unavailable',
        'trip_not_bookable',
        'invalid_booking_transition',
        'not_found',
      ]);
      await expectInventoryConsistent(h.pool, trip.id);
      // trip was cancelled: nothing may still hold seats
      const held = await h.pool.query(
        `SELECT count(*)::int AS n FROM bookings WHERE trip_id=$1 AND status IN ('pending_approval','awaiting_payment','confirmed')`,
        [trip.id],
      );
      expect(held.rows[0].n).toBe(0);
    }
  });

  it('concurrent expiry sweeps release each seat exactly once', async () => {
    const { trip, s } = await setup({ seatsTotal: 4, bookingMode: 'approval' });
    const ps = await makePassengers(h.pool, 4);
    for (const p of ps)
      await h.bookings.create(p, trip.id, { fromStopId: s(0), toStopId: s(2), seats: 1 }, idemKey());
    await h.pool.query(`UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE trip_id = $1`, [
      trip.id,
    ]);
    const counts = await Promise.all([
      h.bookings.expireStale(),
      h.bookings.expireStale(),
      h.bookings.expireStale(),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4);
    const seg = await h.pool.query('SELECT seats_booked FROM trip_segments WHERE trip_id=$1', [trip.id]);
    expect(seg.rows.every((x) => x.seats_booked === 0)).toBe(true); // never negative (CHECK would have failed the sweep)
    await expectInventoryConsistent(h.pool, trip.id);
  });
});
