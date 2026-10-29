import { z } from 'zod';
import { AppError } from '../common/app-error';

/** Rough bounding box of Egypt; rejects obviously wrong coordinates (not a legal border). */
export const EGYPT_BBOX = { minLat: 21.5, maxLat: 31.9, minLng: 24.5, maxLng: 37.0 };

export const stopSchema = z.object({
  cityId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  offsetMinutes: z.number().int().min(0).max(3000),
});
export const createTripSchema = z.object({
  vehicleId: z.uuid(),
  departureAt: z.iso.datetime({ offset: true }),
  seatsTotal: z.number().int().min(1).max(7),
  bookingMode: z.enum(['instant', 'approval']).default('approval'),
  notes: z.string().trim().max(500).optional(),
  stops: z.array(stopSchema).min(2).max(10),
  /** One price per segment (stops.length - 1 entries), integer minor units (piastres) per seat. */
  segmentPricesMinor: z.array(z.number().int().positive().max(10_000_000)).min(1).max(9),
});
export const updateTripSchema = z
  .object({
    departureAt: z.iso.datetime({ offset: true }).optional(),
    bookingMode: z.enum(['instant', 'approval']).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type CreateTripInput = z.infer<typeof createTripSchema>;

const invalid = (msg: string) => new AppError(400, 'invalid_trip_plan', msg);

export interface PlanRules {
  now: Date;
  minLeadMinutes: number;
  maxSegmentPriceMinor: number;
  vehicleSeats: number;
}

/** Pure validation of a trip plan. Returns the computed arrival time. */
export function validateTripPlan(
  input: CreateTripInput,
  rules: PlanRules,
): { arrivalAt: Date; departureAt: Date } {
  const { stops, segmentPricesMinor: prices } = input;
  if (prices.length !== stops.length - 1)
    throw invalid('segmentPricesMinor must have exactly one price per segment');
  if (stops[0].offsetMinutes !== 0) throw invalid('First stop must have offsetMinutes 0');
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].offsetMinutes <= stops[i - 1].offsetMinutes)
      throw invalid('Stop offsets must be strictly increasing');
  }
  const cityIds = stops.map((s) => s.cityId);
  if (new Set(cityIds).size !== cityIds.length) throw invalid('A city can appear only once per trip');
  for (const s of stops) {
    if (
      s.lat < EGYPT_BBOX.minLat ||
      s.lat > EGYPT_BBOX.maxLat ||
      s.lng < EGYPT_BBOX.minLng ||
      s.lng > EGYPT_BBOX.maxLng
    ) {
      throw invalid(`Stop "${s.name}" is outside the supported area`);
    }
  }
  if (prices.some((p) => p > rules.maxSegmentPriceMinor))
    throw invalid('A segment price exceeds the platform maximum');
  if (input.seatsTotal > rules.vehicleSeats - 1)
    throw invalid('seatsTotal exceeds the vehicle capacity (driver occupies one seat)');
  const departureAt = new Date(input.departureAt);
  if (departureAt.getTime() < rules.now.getTime() + rules.minLeadMinutes * 60_000) {
    throw invalid(`Departure must be at least ${rules.minLeadMinutes} minutes from now`);
  }
  const arrivalAt = new Date(departureAt.getTime() + stops[stops.length - 1].offsetMinutes * 60_000);
  return { arrivalAt, departureAt };
}

/** Total price in minor units for seats between two stop sequence numbers (segments from..to-1). */
export function quoteMinor(
  segmentPricesMinor: number[],
  fromSeq: number,
  toSeq: number,
  seats: number,
): number {
  if (fromSeq < 0 || toSeq <= fromSeq || toSeq > segmentPricesMinor.length)
    throw invalid('Invalid stop range');
  return segmentPricesMinor.slice(fromSeq, toSeq).reduce((a, b) => a + b, 0) * seats;
}
