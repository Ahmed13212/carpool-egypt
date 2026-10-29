import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { AppError, conflict } from '../common/app-error';
import { DatabaseService } from '../database/database.service';

export const createVehicleSchema = z.object({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  color: z.string().trim().min(1).max(30),
  seats: z.number().int().min(2).max(8),
  plateNumber: z.string().trim().min(3).max(20),
});

@Injectable()
export class DriversService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Starts driver verification. NOTE: document upload/review is NOT implemented yet; a reviewer approves manually
   * via the admin API. Real identity/licence/vehicle document checks are required before launch.
   */
  async apply(user: AuthUser) {
    if (!user.emailVerified) throw new AppError(403, 'email_not_verified', 'Verify your email first');
    return this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO driver_profiles(user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET verification_status = 'pending_review', rejection_reason = NULL
           WHERE driver_profiles.verification_status IN ('rejected','requires_resubmission','expired')`,
        [user.id],
      );
      await c.query(`INSERT INTO user_roles(user_id, role_key) VALUES ($1,'driver') ON CONFLICT DO NOTHING`, [
        user.id,
      ]);
      await this.audit.log(
        { actorId: user.id, action: 'driver.applied', targetType: 'user', targetId: user.id },
        c,
      );
      return this.status(user.id, c);
    });
  }

  async status(userId: string, q: { query: any } = this.db.pool) {
    const { rows } = await q.query(
      `SELECT verification_status, rejection_reason FROM driver_profiles WHERE user_id = $1`,
      [userId],
    );
    return {
      verificationStatus: rows[0]?.verification_status ?? 'not_submitted',
      rejectionReason: rows[0]?.rejection_reason ?? null,
    };
  }

  async createVehicle(user: AuthUser, input: z.infer<typeof createVehicleSchema>) {
    try {
      const { rows } = await this.db.query(
        `INSERT INTO vehicles(owner_id, make, model, color, seats, plate_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          user.id,
          input.make,
          input.model,
          input.color,
          input.seats,
          input.plateNumber.toUpperCase().replace(/\s+/g, ' '),
        ],
      );
      return this.vehicleDto(rows[0]);
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('vehicle_exists', 'This vehicle is already registered');
      throw e;
    }
  }

  async listVehicles(user: AuthUser) {
    const { rows } = await this.db.query(`SELECT * FROM vehicles WHERE owner_id = $1 ORDER BY created_at`, [
      user.id,
    ]);
    return rows.map((r: any) => this.vehicleDto(r));
  }

  private vehicleDto(r: any) {
    return {
      id: r.id,
      make: r.make,
      model: r.model,
      color: r.color,
      seats: r.seats,
      plateNumber: r.plate_number,
      verificationStatus: r.verification_status,
    };
  }
}
