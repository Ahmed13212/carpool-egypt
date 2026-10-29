import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface SearchParams {
  fromCity?: string;
  fromLat?: number;
  fromLng?: number;
  fromRadiusKm?: number;
  toCity?: string;
  toLat?: number;
  toLng?: number;
  toRadiusKm?: number;
  date?: string;
  seats: number;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  sort: 'departure' | 'price';
  limit: number;
  offset: number;
}

@Injectable()
export class TripsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Route-aware search. A trip matches when it has a stop `a` matching the origin and a LATER stop `b` matching the
   * destination, and every segment between them has >= `seats` free. Origin/destination match either a city slug or a
   * PostGIS proximity (ST_DWithin on geography, metres) to the trip's own stops.
   */
  async search(p: SearchParams) {
    const params: unknown[] = [];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const endpoint = (alias: string, city?: string, lat?: number, lng?: number, radiusKm?: number) =>
      city !== undefined
        ? `${alias}.city_id = (SELECT id FROM cities WHERE slug = ${add(city)} AND is_active)`
        : `ST_DWithin(${alias}.location, ST_SetSRID(ST_MakePoint(${add(lng)}::float8, ${add(lat)}::float8), 4326)::geography, ${add((radiusKm ?? 10) * 1000)}::float8)`;

    const where: string[] = [
      `t.status = 'scheduled'`,
      `(t.departure_at + a.offset_minutes * interval '1 minute') > now()`,
      endpoint('a', p.fromCity, p.fromLat, p.fromLng, p.fromRadiusKm),
      endpoint('b', p.toCity, p.toLat, p.toLng, p.toRadiusKm),
      `seg.available >= ${add(p.seats)}::int`,
    ];
    if (p.date) {
      const d = add(p.date);
      where.push(
        `(t.departure_at + a.offset_minutes * interval '1 minute') >= (${d}::date)::timestamp AT TIME ZONE 'Africa/Cairo'`,
        `(t.departure_at + a.offset_minutes * interval '1 minute') < ((${d}::date) + 1)::timestamp AT TIME ZONE 'Africa/Cairo'`,
      );
    }
    if (p.minPriceMinor !== undefined) where.push(`seg.price_minor >= ${add(p.minPriceMinor)}::int`);
    if (p.maxPriceMinor !== undefined) where.push(`seg.price_minor <= ${add(p.maxPriceMinor)}::int`);
    const order =
      p.sort === 'price' ? 'r.price_minor ASC, r.depart_at ASC' : 'r.depart_at ASC, r.price_minor ASC';
    const limit = add(p.limit);
    const offset = add(p.offset);

    const sql = `
      SELECT r.*, count(*) OVER() AS total_count FROM (
        SELECT DISTINCT ON (t.id)
               t.id AS trip_id, t.booking_mode, t.currency,
               a.id AS from_stop_id, a.seq AS from_seq, a.name AS from_name, ac.slug AS from_city, 
               b.id AS to_stop_id, b.seq AS to_seq, b.name AS to_name, bc.slug AS to_city,
               (t.departure_at + a.offset_minutes * interval '1 minute') AS depart_at,
               (t.departure_at + b.offset_minutes * interval '1 minute') AS arrive_at,
               seg.price_minor, seg.available,
               t.driver_id, dp.full_name AS driver_name, v.make, v.model, v.color
          FROM trips t
          JOIN trip_stops a ON a.trip_id = t.id
          JOIN trip_stops b ON b.trip_id = t.id AND b.seq > a.seq
          JOIN cities ac ON ac.id = a.city_id
          JOIN cities bc ON bc.id = b.city_id
          JOIN user_profiles dp ON dp.user_id = t.driver_id
          JOIN vehicles v ON v.id = t.vehicle_id
          CROSS JOIN LATERAL (
            SELECT SUM(s.price_minor)::int AS price_minor, MIN(s.seats_total - s.seats_booked)::int AS available
              FROM trip_segments s WHERE s.trip_id = t.id AND s.seq >= a.seq AND s.seq < b.seq
          ) seg
         WHERE ${where.join(' AND ')}
         ORDER BY t.id, a.seq, b.seq
      ) r
      ORDER BY ${order}, r.trip_id
      LIMIT ${limit} OFFSET ${offset}`;
    const { rows } = await this.db.query(sql, params);
    return {
      total: rows[0] ? Number(rows[0].total_count) : 0,
      items: rows.map((r: any) => ({
        tripId: r.trip_id,
        bookingMode: r.booking_mode,
        currency: r.currency,
        from: {
          stopId: r.from_stop_id,
          seq: r.from_seq,
          name: r.from_name,
          city: r.from_city,
          departAt: r.depart_at,
        },
        to: { stopId: r.to_stop_id, seq: r.to_seq, name: r.to_name, city: r.to_city, arriveAt: r.arrive_at },
        pricePerSeatMinor: r.price_minor,
        totalPriceMinor: r.price_minor * p.seats,
        seatsAvailable: r.available,
        driver: { id: r.driver_id, fullName: r.driver_name },
        vehicle: { make: r.make, model: r.model, color: r.color },
      })),
    };
  }

  /** Public trip view. Excludes plate number, contact data and any passenger information. */
  async getPublic(tripId: string) {
    const { rows } = await this.db.query(
      `SELECT t.id, t.status, t.departure_at, t.arrival_at, t.seats_total, t.booking_mode, t.currency, t.notes,
              t.driver_id, dp.full_name AS driver_name, v.make, v.model, v.color, v.seats AS vehicle_seats,
              (SELECT json_agg(json_build_object(
                  'id', s.id, 'seq', s.seq, 'cityId', s.city_id, 'city', c.slug, 'name', s.name,
                  'lat', ST_Y(s.location::geometry), 'lng', ST_X(s.location::geometry),
                  'offsetMinutes', s.offset_minutes,
                  'estimatedAt', t.departure_at + s.offset_minutes * interval '1 minute') ORDER BY s.seq)
                 FROM trip_stops s JOIN cities c ON c.id = s.city_id WHERE s.trip_id = t.id) AS stops,
              (SELECT json_agg(json_build_object(
                  'seq', g.seq, 'fromStopId', g.from_stop_id, 'toStopId', g.to_stop_id,
                  'priceMinor', g.price_minor, 'seatsAvailable', g.seats_total - g.seats_booked) ORDER BY g.seq)
                 FROM trip_segments g WHERE g.trip_id = t.id) AS segments
         FROM trips t
         JOIN user_profiles dp ON dp.user_id = t.driver_id
         JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.id = $1`,
      [tripId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      status: r.status,
      departureAt: r.departure_at,
      arrivalAt: r.arrival_at,
      seatsTotal: r.seats_total,
      bookingMode: r.booking_mode,
      currency: r.currency,
      notes: r.notes,
      driver: { id: r.driver_id, fullName: r.driver_name, verified: true },
      vehicle: { make: r.make, model: r.model, color: r.color, seats: r.vehicle_seats },
      stops: r.stops,
      segments: r.segments,
    };
  }

  async listForDriver(driverId: string, limit: number, offset: number) {
    const { rows } = await this.db.query(
      `SELECT t.id, t.status, t.departure_at, t.arrival_at, t.seats_total, t.booking_mode,
              (SELECT count(*)::int FROM bookings b WHERE b.trip_id = t.id AND b.status IN ('pending_approval','awaiting_payment','confirmed')) AS active_bookings,
              count(*) OVER() AS total_count
         FROM trips t WHERE t.driver_id = $1 ORDER BY t.departure_at DESC LIMIT $2 OFFSET $3`,
      [driverId, limit, offset],
    );
    return {
      total: rows[0] ? Number(rows[0].total_count) : 0,
      items: rows.map((r: any) => ({
        id: r.id,
        status: r.status,
        departureAt: r.departure_at,
        arrivalAt: r.arrival_at,
        seatsTotal: r.seats_total,
        bookingMode: r.booking_mode,
        activeBookings: r.active_bookings,
      })),
    };
  }
}
