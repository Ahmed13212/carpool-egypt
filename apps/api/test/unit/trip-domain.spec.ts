import { randomUUID } from 'node:crypto';
import { CreateTripInput, quoteMinor, validateTripPlan } from '../../src/trips/trip.domain';

const now = new Date('2030-01-01T00:00:00Z');
const rules = { now, minLeadMinutes: 30, maxSegmentPriceMinor: 500000, vehicleSeats: 5 };
const stop = (offsetMinutes: number, over: Record<string, unknown> = {}) => ({
  cityId: randomUUID(),
  name: 'Station',
  lat: 30.04,
  lng: 31.23,
  offsetMinutes,
  ...over,
});
const plan = (over: Partial<CreateTripInput> = {}): CreateTripInput => ({
  vehicleId: randomUUID(),
  departureAt: '2030-01-02T10:00:00Z',
  seatsTotal: 3,
  bookingMode: 'approval',
  stops: [stop(0), stop(120), stop(240)],
  segmentPricesMinor: [5000, 4000],
  ...over,
});

describe('validateTripPlan', () => {
  it('accepts a valid plan and computes arrival from the last stop offset', () => {
    const r = validateTripPlan(plan(), rules);
    expect(r.arrivalAt.toISOString()).toBe('2030-01-02T14:00:00.000Z');
  });
  it.each([
    ['price count mismatch', plan({ segmentPricesMinor: [5000] })],
    ['first offset not zero', plan({ stops: [stop(5), stop(120)], segmentPricesMinor: [5000] })],
    ['non-increasing offsets', plan({ stops: [stop(0), stop(120), stop(120)] })],
    ['price above maximum', plan({ segmentPricesMinor: [5000, 500001] })],
    ['seats exceed vehicle capacity minus driver', plan({ seatsTotal: 5 })],
    ['departure inside lead time', plan({ departureAt: '2030-01-01T00:10:00Z' })],
    ['departure in the past', plan({ departureAt: '2029-12-31T00:00:00Z' })],
    [
      'stop outside the supported area',
      plan({ stops: [stop(0), stop(60, { lat: 51.5, lng: -0.12 })], segmentPricesMinor: [5000] }),
    ],
  ])('rejects: %s', (_name, input) => {
    expect(() => validateTripPlan(input, rules)).toThrow();
  });
  it('rejects the same city twice', () => {
    const city = randomUUID();
    expect(() =>
      validateTripPlan(
        plan({ stops: [stop(0, { cityId: city }), stop(60), stop(120, { cityId: city })] }),
        rules,
      ),
    ).toThrow();
  });
});

describe('quoteMinor', () => {
  const prices = [10000, 8000, 5000];
  it('sums the segments between the stops and multiplies by seats', () => {
    expect(quoteMinor(prices, 0, 3, 1)).toBe(23000);
    expect(quoteMinor(prices, 1, 3, 2)).toBe(26000);
    expect(quoteMinor(prices, 0, 1, 3)).toBe(30000);
  });
  it('rejects invalid ranges', () => {
    expect(() => quoteMinor(prices, 2, 2, 1)).toThrow();
    expect(() => quoteMinor(prices, 0, 4, 1)).toThrow();
  });
});
