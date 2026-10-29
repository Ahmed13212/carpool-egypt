import type { Queryable } from '../database/database.service';
import { AppError } from '../common/app-error';

/**
 * Seat inventory per route segment. A passenger boarding at stop `a` and leaving at stop `b` (a < b)
 * occupies segments a..b-1, so a seat freed at stop b is immediately sellable on b..end.
 *
 * CONCURRENCY CONTRACT (prevents deadlocks): every code path that changes seats_booked or a trip's
 * bookings MUST (1) lock the affected trip_segments rows via lockSegments (ascending seq), and only
 * THEN (2) lock booking rows. The CHECK constraint `segment_not_overbooked` is the final safety net.
 */
export interface SegmentRow {
  seq: number;
  seats_total: number;
  seats_booked: number;
  price_minor: number;
}

export async function lockSegments(
  c: Queryable,
  tripId: string,
  fromSeq = 0,
  toSeq = 32767,
): Promise<SegmentRow[]> {
  const { rows } = await c.query(
    `SELECT seq, seats_total, seats_booked, price_minor FROM trip_segments
      WHERE trip_id = $1 AND seq >= $2 AND seq < $3 ORDER BY seq FOR UPDATE`,
    [tripId, fromSeq, toSeq],
  );
  return rows as SegmentRow[];
}

export function assertCapacity(segments: SegmentRow[], seats: number): void {
  const blocked = segments.find((s) => s.seats_booked + seats > s.seats_total);
  if (blocked) {
    throw new AppError(409, 'seat_unavailable', 'Not enough seats available for the selected route', {
      segmentSeq: blocked.seq,
      available: blocked.seats_total - blocked.seats_booked,
    });
  }
}

export async function holdSeats(c: Queryable, tripId: string, fromSeq: number, toSeq: number, seats: number) {
  await c.query(
    `UPDATE trip_segments SET seats_booked = seats_booked + $4 WHERE trip_id = $1 AND seq >= $2 AND seq < $3`,
    [tripId, fromSeq, toSeq, seats],
  );
}

export async function releaseSeats(
  c: Queryable,
  tripId: string,
  fromSeq: number,
  toSeq: number,
  seats: number,
) {
  await c.query(
    `UPDATE trip_segments SET seats_booked = seats_booked - $4 WHERE trip_id = $1 AND seq >= $2 AND seq < $3`,
    [tripId, fromSeq, toSeq, seats],
  );
}
