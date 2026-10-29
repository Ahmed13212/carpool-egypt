import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { hasPermission } from '../auth/auth.types';
import { AppError, conflict, notFound } from '../common/app-error';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../settings/settings.service';
import { lockSegments } from './segment-inventory';
import { CreateTripInput, validateTripPlan } from './trip.domain';
import { SearchParams, TripsRepository } from './trips.repository';
import { SEAT_HOLDING } from '../bookings/booking-state-machine';

@Injectable()
export class TripsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: TripsRepository,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  search(params: SearchParams) {
    return this.repo.search(params);
  }
  listForDriver(driverId: string, limit: number, offset: number) {
    return this.repo.listForDriver(driverId, limit, offset);
  }

  async get(id: string) {
    const trip = await this.repo.getPublic(id);
    if (!trip) throw notFound('Trip');
    return trip;
  }

  async create(user: AuthUser, input: CreateTripInput) {
    const s = await this.settings.getAll();
    if (s.trip_publishing_enabled !== true) {
      throw new AppError(403, 'feature_disabled', 'Trip publishing is not enabled on this platform yet');
    }
    if (!user.emailVerified) throw new AppError(403, 'email_not_verified', 'Verify your email first');

    const tripId = await this.db.tx(async (c) => {
      // Serialise concurrent publishes by the same driver so the overlap check below cannot race.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`trip-publish:${user.id}`]);

      const v = await c.query(
        `SELECT id, seats, verification_status FROM vehicles WHERE id = $1 AND owner_id = $2`,
        [input.vehicleId, user.id],
      );
      if (!v.rows[0]) throw notFound('Vehicle');
      if (v.rows[0].verification_status !== 'approved')
        throw new AppError(403, 'vehicle_not_verified', 'Vehicle is not verified');
      if (s.require_driver_approval === true) {
        const d = await c.query(`SELECT verification_status FROM driver_profiles WHERE user_id = $1`, [
          user.id,
        ]);
        if (d.rows[0]?.verification_status !== 'approved')
          throw new AppError(403, 'driver_not_verified', 'Driver is not verified');
      }

      const { arrivalAt, departureAt } = validateTripPlan(input, {
        now: new Date(),
        minLeadMinutes: s.min_booking_lead_minutes as number,
        maxSegmentPriceMinor: s.max_segment_price_minor as number,
        vehicleSeats: v.rows[0].seats,
      });

      const cityIds = input.stops.map((st) => st.cityId);
      const cities = await c.query(
        `SELECT count(*)::int AS n FROM cities WHERE id = ANY($1::uuid[]) AND is_active`,
        [cityIds],
      );
      if (cities.rows[0].n !== cityIds.length)
        throw new AppError(400, 'invalid_trip_plan', 'Unknown or inactive city');

      await this.assertNoOverlap(c, user.id, departureAt, arrivalAt, null);

      const t = await c.query(
        `INSERT INTO trips(driver_id, vehicle_id, departure_at, arrival_at, seats_total, booking_mode, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          user.id,
          input.vehicleId,
          departureAt,
          arrivalAt,
          input.seatsTotal,
          input.bookingMode,
          input.notes ?? null,
        ],
      );
      const id = t.rows[0].id as string;
      const stopIds: string[] = [];
      for (let i = 0; i < input.stops.length; i++) {
        const st = input.stops[i];
        const r = await c.query(
          `INSERT INTO trip_stops(trip_id, seq, city_id, name, location, offset_minutes)
           VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5::float8,$6::float8),4326)::geography, $7) RETURNING id`,
          [id, i, st.cityId, st.name, st.lng, st.lat, st.offsetMinutes],
        );
        stopIds.push(r.rows[0].id);
      }
      for (let i = 0; i < input.segmentPricesMinor.length; i++) {
        await c.query(
          `INSERT INTO trip_segments(trip_id, seq, from_stop_id, to_stop_id, price_minor, seats_total) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, i, stopIds[i], stopIds[i + 1], input.segmentPricesMinor[i], input.seatsTotal],
        );
      }
      return id;
    });
    return this.get(tripId);
  }

  /** Limited edit: booking mode / notes any time; departure time only while no seat-holding booking exists. */
  async update(
    user: AuthUser,
    id: string,
    patch: { departureAt?: string; bookingMode?: 'instant' | 'approval'; notes?: string | null },
  ) {
    await this.db.tx(async (c) => {
      const t0 = await c.query('SELECT driver_id FROM trips WHERE id = $1', [id]);
      if (!t0.rows[0]) throw notFound('Trip');
      if (t0.rows[0].driver_id !== user.id) throw notFound('Trip'); // do not reveal other drivers' trips
      await lockSegments(c, id);
      const t = (await c.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (t.status !== 'scheduled') throw conflict('trip_not_editable', 'Only scheduled trips can be edited');
      if (patch.departureAt) {
        const active = await c.query(
          `SELECT 1 FROM bookings WHERE trip_id = $1 AND status = ANY($2) LIMIT 1`,
          [id, SEAT_HOLDING],
        );
        if (active.rowCount)
          throw conflict(
            'trip_has_bookings',
            'Departure time cannot change while bookings exist; cancel the trip instead',
          );
        const minLead = await this.settings.number('min_booking_lead_minutes', c);
        const dep = new Date(patch.departureAt);
        if (dep.getTime() < Date.now() + minLead * 60_000)
          throw new AppError(400, 'invalid_trip_plan', 'Departure is too soon');
        const span = new Date(t.arrival_at).getTime() - new Date(t.departure_at).getTime();
        const arr = new Date(dep.getTime() + span);
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`trip-publish:${user.id}`]);
        await this.assertNoOverlap(c, user.id, dep, arr, id);
        await c.query('UPDATE trips SET departure_at = $2, arrival_at = $3 WHERE id = $1', [id, dep, arr]);
      }
      await c.query(
        `UPDATE trips SET booking_mode = COALESCE($2, booking_mode),
                notes = CASE WHEN $3::boolean THEN $4 ELSE notes END, updated_at = now() WHERE id = $1`,
        [id, patch.bookingMode ?? null, patch.notes !== undefined, patch.notes ?? null],
      );
    });
    return this.get(id);
  }

  /** Cancels a trip and every seat-holding booking on it, atomically. Locks segments first (see segment-inventory). */
  async cancel(user: AuthUser, id: string, reason: string | undefined, ip?: string) {
    await this.db.tx(async (c) => {
      const t0 = await c.query('SELECT driver_id FROM trips WHERE id = $1', [id]);
      if (!t0.rows[0]) throw notFound('Trip');
      const isOwner = t0.rows[0].driver_id === user.id;
      const isAdmin = hasPermission(user, 'trips:cancel:any');
      if (!isOwner && !isAdmin) throw notFound('Trip');
      await lockSegments(c, id);
      const t = (await c.query('SELECT status FROM trips WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (t.status !== 'scheduled')
        throw conflict('trip_not_cancellable', 'Trip cannot be cancelled in its current state');

      const held = await c.query(
        `SELECT id, status FROM bookings WHERE trip_id = $1 AND status = ANY($2) ORDER BY id FOR UPDATE`,
        [id, SEAT_HOLDING],
      );
      if (held.rows.length) {
        const ids = held.rows.map((b: any) => b.id);
        await c.query(
          `UPDATE bookings SET status = 'cancelled', cancelled_by = $2, cancellation_reason = $3, expires_at = NULL, updated_at = now()
            WHERE id = ANY($1::uuid[])`,
          [ids, user.id, reason ?? 'trip_cancelled'],
        );
        await c.query(
          `INSERT INTO booking_status_history(booking_id, from_status, to_status, actor_id, reason)
           SELECT x.id, x.st, 'cancelled', $3, $4 FROM unnest($1::uuid[], $2::text[]) AS x(id, st)`,
          [ids, held.rows.map((b: any) => b.status), user.id, reason ?? 'trip_cancelled'],
        );
      }
      await c.query('UPDATE trip_segments SET seats_booked = 0 WHERE trip_id = $1', [id]);
      await c.query(
        `UPDATE trips SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $2, updated_at = now() WHERE id = $1`,
        [id, reason ?? null],
      );
      if (!isOwner) {
        await this.audit.log(
          {
            actorId: user.id,
            action: 'trip.cancelled_by_admin',
            targetType: 'trip',
            targetId: id,
            metadata: { reason, bookingsCancelled: held.rows.length },
            ip,
          },
          c,
        );
      }
    });
    return this.get(id);
  }

  private async assertNoOverlap(
    c: PoolClient,
    driverId: string,
    dep: Date,
    arr: Date,
    excludeTripId: string | null,
  ) {
    const o = await c.query(
      `SELECT 1 FROM trips WHERE driver_id = $1 AND status IN ('scheduled','in_progress')
          AND ($4::uuid IS NULL OR id <> $4)
          AND tstzrange(departure_at, arrival_at) && tstzrange($2, $3) LIMIT 1`,
      [driverId, dep, arr, excludeTripId],
    );
    if (o.rowCount) throw conflict('trip_overlap', 'You already have a trip scheduled during this time');
  }
}
