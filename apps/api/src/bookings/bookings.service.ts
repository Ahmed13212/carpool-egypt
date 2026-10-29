import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types';
import { hasPermission } from '../auth/auth.types';
import { AppError, conflict, notFound } from '../common/app-error';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../settings/settings.service';
import { assertCapacity, holdSeats, lockSegments, releaseSeats } from '../trips/segment-inventory';
import { assertTransition, BookingStatus, initialStatus, statusAfterApproval } from './booking-state-machine';

export const createBookingSchema = z.object({
  fromStopId: z.uuid(),
  toStopId: z.uuid(),
  seats: z.number().int().min(1).max(7),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const SCOPE_CREATE = 'booking.create';

interface BookingRow {
  id: string;
  trip_id: string;
  passenger_id: string;
  from_stop_seq: number;
  to_stop_seq: number;
  seats: number;
  status: BookingStatus;
  price_total_minor: number;
  currency: string;
  expires_at: Date | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  created_at: Date;
  updated_at: Date;
}
const toDto = (b: BookingRow) => ({
  id: b.id,
  tripId: b.trip_id,
  passengerId: b.passenger_id,
  fromStopSeq: b.from_stop_seq,
  toStopSeq: b.to_stop_seq,
  seats: b.seats,
  status: b.status,
  priceTotalMinor: b.price_total_minor,
  currency: b.currency,
  expiresAt: b.expires_at,
  cancellationReason: b.cancellation_reason,
  createdAt: b.created_at,
  updatedAt: b.updated_at,
});

@Injectable()
export class BookingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- create
  async create(user: AuthUser, tripId: string, input: CreateBookingInput, idempotencyKey: string) {
    if (!user.emailVerified) throw new AppError(403, 'email_not_verified', 'Verify your email first');
    const requestHash = createHash('sha256')
      .update(JSON.stringify([tripId, input.fromStopId, input.toStopId, input.seats]))
      .digest('hex');

    return this.db.tx(async (c) => {
      const s = await this.settings.getAll(c);
      if (s.booking_enabled !== true)
        throw new AppError(403, 'feature_disabled', 'Booking is not enabled on this platform yet');

      // Idempotency: the record is inserted inside the same transaction as the booking. A concurrent request with the
      // same key blocks on the unique index until we commit, then replays our stored response.
      const ins = await c.query(
        `INSERT INTO idempotency_records(user_id, scope, key, request_hash) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, scope, key) DO NOTHING RETURNING id`,
        [user.id, SCOPE_CREATE, idempotencyKey, requestHash],
      );
      if (!ins.rows[0]) {
        const ex = (
          await c.query(
            `SELECT request_hash, status_code, response FROM idempotency_records WHERE user_id = $1 AND scope = $2 AND key = $3`,
            [user.id, SCOPE_CREATE, idempotencyKey],
          )
        ).rows[0];
        if (ex.request_hash !== requestHash) {
          throw new AppError(
            422,
            'idempotency_key_reuse',
            'This Idempotency-Key was already used with a different request',
          );
        }
        return { replayed: true, booking: ex.response };
      }

      const stops = (
        await c.query(`SELECT id, seq FROM trip_stops WHERE trip_id = $1 AND id = ANY($2::uuid[])`, [
          tripId,
          [input.fromStopId, input.toStopId],
        ])
      ).rows;
      const from = stops.find((x: any) => x.id === input.fromStopId);
      const to = stops.find((x: any) => x.id === input.toStopId);
      if (!from || !to) {
        const exists = await c.query('SELECT 1 FROM trips WHERE id = $1', [tripId]);
        throw exists.rowCount
          ? new AppError(400, 'invalid_stops', 'Stops do not belong to this trip')
          : notFound('Trip');
      }
      if (from.seq >= to.seq) throw new AppError(400, 'invalid_stops', 'Drop-off must come after pick-up');

      // (1) lock the affected segments, (2) only then read trip state -> serialised with trip cancel / edit.
      const segments = await lockSegments(c, tripId, from.seq, to.seq);
      const trip = (
        await c.query(
          `SELECT t.status, t.driver_id, t.booking_mode, t.currency, t.departure_at + st.offset_minutes * interval '1 minute' AS boarding_at
           FROM trips t JOIN trip_stops st ON st.id = $2 WHERE t.id = $1`,
          [tripId, input.fromStopId],
        )
      ).rows[0];
      if (trip.status !== 'scheduled')
        throw conflict('trip_not_bookable', 'This trip is not open for booking');
      if (trip.driver_id === user.id)
        throw new AppError(400, 'cannot_book_own_trip', 'You cannot book your own trip');
      if (
        new Date(trip.boarding_at).getTime() <
        Date.now() + (s.min_booking_lead_minutes as number) * 60_000
      ) {
        throw conflict('booking_closed', 'Booking for this departure is closed');
      }
      assertCapacity(segments, input.seats);

      await holdSeats(c, tripId, from.seq, to.seq, input.seats);
      const status = initialStatus(trip.booking_mode, s.payments_enabled === true);
      const priceTotal = segments.reduce((sum, g) => sum + g.price_minor, 0) * input.seats;
      const expiresMinutes =
        status === 'pending_approval'
          ? (s.booking_approval_timeout_minutes as number)
          : status === 'awaiting_payment'
            ? (s.payment_hold_minutes as number)
            : null;

      let booking: BookingRow;
      try {
        booking = (
          await c.query(
            `INSERT INTO bookings(trip_id, passenger_id, from_stop_seq, to_stop_seq, seats, status, price_total_minor, currency, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::int IS NULL THEN NULL ELSE now() + make_interval(mins => $9::int) END)
           RETURNING *`,
            [
              tripId,
              user.id,
              from.seq,
              to.seq,
              input.seats,
              status,
              priceTotal,
              trip.currency,
              expiresMinutes,
            ],
          )
        ).rows[0];
      } catch (e: any) {
        if (e?.code === '23505')
          throw conflict('duplicate_booking', 'You already have an active booking on this trip');
        throw e;
      }
      await this.recordHistory(c, booking.id, null, status, user.id, 'created');
      const dto = toDto(booking);
      await c.query(
        `UPDATE idempotency_records SET status_code = 201, response = $4 WHERE user_id = $1 AND scope = $2 AND key = $3`,
        [user.id, SCOPE_CREATE, idempotencyKey, JSON.stringify(dto)],
      );
      return { replayed: false, booking: dto };
    });
  }

  // ---------------------------------------------------------------- driver decision
  async decide(user: AuthUser, bookingId: string, decision: 'confirm' | 'reject', reason?: string) {
    return this.db.tx(async (c) => {
      const b0 = await this.peek(c, bookingId);
      if (b0.driver_id !== user.id) throw notFound('Booking');
      await lockSegments(c, b0.trip_id, b0.from_stop_seq, b0.to_stop_seq);
      const b = await this.lockBooking(c, bookingId);
      // Only the driver's approval step may be decided here; awaiting_payment -> confirmed is reserved for verified payments.
      if (b.status !== 'pending_approval') {
        throw new AppError(
          409,
          'invalid_booking_transition',
          `Booking in status ${b.status} is not awaiting driver approval`,
        );
      }

      if (decision === 'confirm') {
        const next = statusAfterApproval(await this.settings.bool('payments_enabled', c));
        assertTransition(b.status, next);
        const mins =
          next === 'awaiting_payment' ? await this.settings.number('payment_hold_minutes', c) : null;
        const upd = await c.query(
          `UPDATE bookings SET status = $2, expires_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [bookingId, next, mins],
        );
        await this.recordHistory(c, bookingId, b.status, next, user.id, 'driver_approved');
        return toDto(upd.rows[0]);
      }
      assertTransition(b.status, 'rejected');
      await releaseSeats(c, b.trip_id, b.from_stop_seq, b.to_stop_seq, b.seats);
      const upd = await c.query(
        `UPDATE bookings SET status = 'rejected', expires_at = NULL, cancellation_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [bookingId, reason ?? null],
      );
      await this.recordHistory(c, bookingId, b.status, 'rejected', user.id, reason ?? 'driver_rejected');
      return toDto(upd.rows[0]);
    });
  }

  // ---------------------------------------------------------------- cancel
  async cancel(user: AuthUser, bookingId: string, reason?: string) {
    return this.db.tx(async (c) => {
      const b0 = await this.peek(c, bookingId);
      if (b0.passenger_id !== user.id && b0.driver_id !== user.id) throw notFound('Booking');
      await lockSegments(c, b0.trip_id, b0.from_stop_seq, b0.to_stop_seq);
      const b = await this.lockBooking(c, bookingId);
      assertTransition(b.status, 'cancelled');
      const boarding = (
        await c.query(
          `SELECT t.departure_at + st.offset_minutes * interval '1 minute' AS boarding_at
           FROM trips t JOIN trip_stops st ON st.trip_id = t.id AND st.seq = $2 WHERE t.id = $1`,
          [b.trip_id, b.from_stop_seq],
        )
      ).rows[0];
      if (new Date(boarding.boarding_at).getTime() <= Date.now())
        throw conflict('trip_departed', 'The trip has already departed');
      await releaseSeats(c, b.trip_id, b.from_stop_seq, b.to_stop_seq, b.seats);
      const upd = await c.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_by = $2, cancellation_reason = $3, expires_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [bookingId, user.id, reason ?? null],
      );
      await this.recordHistory(c, bookingId, b.status, 'cancelled', user.id, reason ?? 'cancelled_by_user');
      return toDto(upd.rows[0]);
    });
  }

  // ---------------------------------------------------------------- expiry (called by a scheduler/worker; idempotent)
  /** Expires unconfirmed bookings past `expires_at` and frees their seats. Safe to run concurrently and repeatedly. */
  async expireStale(limit = 200): Promise<number> {
    const cand = await this.db.query(
      `SELECT id FROM bookings WHERE status IN ('pending_approval','awaiting_payment') AND expires_at < now() ORDER BY expires_at LIMIT $1`,
      [limit],
    );
    let expired = 0;
    for (const { id } of cand.rows) {
      const done = await this.db.tx(async (c) => {
        const b0 = (
          await c.query('SELECT trip_id, from_stop_seq, to_stop_seq FROM bookings WHERE id = $1', [id])
        ).rows[0];
        await lockSegments(c, b0.trip_id, b0.from_stop_seq, b0.to_stop_seq);
        const b = await this.lockBooking(c, id);
        if (
          !['pending_approval', 'awaiting_payment'].includes(b.status) ||
          !b.expires_at ||
          b.expires_at > new Date()
        )
          return false;
        assertTransition(b.status, 'expired');
        await releaseSeats(c, b.trip_id, b.from_stop_seq, b.to_stop_seq, b.seats);
        await c.query(
          `UPDATE bookings SET status = 'expired', expires_at = NULL, updated_at = now() WHERE id = $1`,
          [id],
        );
        await this.recordHistory(c, id, b.status, 'expired', null, 'expired');
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  // ---------------------------------------------------------------- reads
  async get(user: AuthUser, bookingId: string) {
    const { rows } = await this.db.query(
      `SELECT b.*, t.driver_id, t.departure_at, fs.name AS from_name, ts.name AS to_name,
              (SELECT json_agg(json_build_object('from', h.from_status, 'to', h.to_status, 'at', h.created_at, 'reason', h.reason) ORDER BY h.id)
                 FROM booking_status_history h WHERE h.booking_id = b.id) AS history
         FROM bookings b JOIN trips t ON t.id = b.trip_id
         JOIN trip_stops fs ON fs.trip_id = b.trip_id AND fs.seq = b.from_stop_seq
         JOIN trip_stops ts ON ts.trip_id = b.trip_id AND ts.seq = b.to_stop_seq
        WHERE b.id = $1`,
      [bookingId],
    );
    const r = rows[0];
    const allowed =
      r &&
      (r.passenger_id === user.id || r.driver_id === user.id || hasPermission(user, 'bookings:read:any'));
    if (!allowed) throw notFound('Booking'); // 404 (not 403) so booking ids cannot be probed
    return {
      ...toDto(r),
      driverId: r.driver_id,
      from: r.from_name,
      to: r.to_name,
      tripDepartureAt: r.departure_at,
      history: r.history,
    };
  }

  async listMine(user: AuthUser, limit: number, offset: number) {
    const { rows } = await this.db.query(
      `SELECT b.*, count(*) OVER() AS total_count FROM bookings b WHERE b.passenger_id = $1
        ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
      [user.id, limit, offset],
    );
    return { total: rows[0] ? Number(rows[0].total_count) : 0, items: rows.map(toDto) };
  }

  async listForTrip(user: AuthUser, tripId: string, limit: number, offset: number) {
    const t = (await this.db.query('SELECT driver_id FROM trips WHERE id = $1', [tripId])).rows[0];
    if (!t || (t.driver_id !== user.id && !hasPermission(user, 'bookings:read:any'))) throw notFound('Trip');
    const { rows } = await this.db.query(
      `SELECT b.*, p.full_name, count(*) OVER() AS total_count FROM bookings b JOIN user_profiles p ON p.user_id = b.passenger_id
        WHERE b.trip_id = $1 ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
      [tripId, limit, offset],
    );
    return {
      total: rows[0] ? Number(rows[0].total_count) : 0,
      items: rows.map((r: any) => ({ ...toDto(r), passengerName: r.full_name })),
    };
  }

  // ---------------------------------------------------------------- helpers
  private async peek(c: PoolClient, id: string) {
    const { rows } = await c.query(
      `SELECT b.trip_id, b.passenger_id, b.from_stop_seq, b.to_stop_seq, t.driver_id
         FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Booking');
    return rows[0] as {
      trip_id: string;
      passenger_id: string;
      from_stop_seq: number;
      to_stop_seq: number;
      driver_id: string;
    };
  }

  private async lockBooking(c: PoolClient, id: string): Promise<BookingRow> {
    return (await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0] as BookingRow;
  }

  private async recordHistory(
    c: PoolClient,
    id: string,
    from: string | null,
    to: string,
    actor: string | null,
    reason: string,
  ) {
    await c.query(
      `INSERT INTO booking_status_history(booking_id, from_status, to_status, actor_id, reason) VALUES ($1,$2,$3,$4,$5)`,
      [id, from, to, actor, reason],
    );
  }
}
