import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { hasPermission } from '../auth/auth.types';
import { AppError, conflict, forbidden, notFound } from '../common/app-error';
import { DatabaseService } from '../database/database.service';

export const GRANTABLE_ROLES = [
  'support_agent',
  'verification_reviewer',
  'finance_operator',
  'administrator',
] as const;
const PRIVILEGED = [
  'administrator',
  'super_administrator',
  'finance_operator',
  'verification_reviewer',
  'support_agent',
];

export const settingSchemas: Record<string, z.ZodType> = {
  trip_publishing_enabled: z.boolean(),
  booking_enabled: z.boolean(),
  payments_enabled: z.boolean(),
  require_driver_approval: z.boolean(),
  booking_approval_timeout_minutes: z.number().int().min(5).max(10080),
  payment_hold_minutes: z.number().int().min(1).max(1440),
  max_segment_price_minor: z.number().int().min(100).max(10_000_000),
  min_booking_lead_minutes: z.number().int().min(0).max(1440),
};

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listUsers(q: string | undefined, limit: number, offset: number) {
    const { rows } = await this.db.query(
      `SELECT u.id, u.email, u.status, u.email_verified_at, u.created_at, p.full_name,
              COALESCE(array_agg(ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles,
              count(*) OVER() AS total_count
         FROM users u JOIN user_profiles p ON p.user_id = u.id LEFT JOIN user_roles ur ON ur.user_id = u.id
        WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR p.full_name ILIKE '%' || $1 || '%')
        GROUP BY u.id, p.user_id ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [q ? q.replace(/[%_\\]/g, '\\$&') : null, limit, offset],
    );
    return {
      total: rows[0] ? Number(rows[0].total_count) : 0,
      items: rows.map((r: any) => ({
        id: r.id,
        email: r.email,
        fullName: r.full_name,
        status: r.status,
        roles: r.roles,
        emailVerified: !!r.email_verified_at,
        createdAt: r.created_at,
      })),
    };
  }

  async suspend(actor: AuthUser, targetId: string, reason: string, ip?: string) {
    if (actor.id === targetId) throw forbidden('You cannot suspend your own account');
    await this.db.tx(async (c) => {
      const t = await this.targetWithRoles(c, targetId);
      this.assertCanManage(actor, t.roles);
      if (t.status === 'suspended') throw conflict('already_suspended', 'Account is already suspended');
      await c.query(
        `UPDATE users SET status = 'suspended', suspended_reason = $2, updated_at = now() WHERE id = $1`,
        [targetId, reason],
      );
      await c.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
        targetId,
      ]);
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'user.suspended',
          targetType: 'user',
          targetId,
          metadata: { reason },
          ip,
        },
        c,
      );
    });
  }

  async reinstate(actor: AuthUser, targetId: string, ip?: string) {
    await this.db.tx(async (c) => {
      const t = await this.targetWithRoles(c, targetId);
      this.assertCanManage(actor, t.roles);
      if (t.status !== 'suspended') throw conflict('not_suspended', 'Account is not suspended');
      await c.query(
        `UPDATE users SET status = 'active', suspended_reason = NULL, updated_at = now() WHERE id = $1`,
        [targetId],
      );
      await this.audit.log(
        { actorId: actor.id, action: 'user.reinstated', targetType: 'user', targetId, ip },
        c,
      );
    });
  }

  async grantRole(actor: AuthUser, targetId: string, role: string, ip?: string) {
    await this.db.tx(async (c) => {
      await this.targetWithRoles(c, targetId);
      await c.query(
        `INSERT INTO user_roles(user_id, role_key, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [targetId, role, actor.id],
      );
      await this.audit.log(
        { actorId: actor.id, action: 'role.granted', targetType: 'user', targetId, metadata: { role }, ip },
        c,
      );
    });
  }

  async reviewDriver(
    actor: AuthUser,
    userId: string,
    decision: 'approve' | 'reject',
    reason: string | undefined,
    ip?: string,
  ) {
    await this.db.tx(async (c) => {
      const d = await c.query(
        'SELECT verification_status FROM driver_profiles WHERE user_id = $1 FOR UPDATE',
        [userId],
      );
      if (!d.rows[0]) throw notFound('Driver application');
      if (d.rows[0].verification_status !== 'pending_review')
        throw conflict('not_pending', 'Application is not pending review');
      const status = decision === 'approve' ? 'approved' : 'rejected';
      await c.query(
        `UPDATE driver_profiles SET verification_status = $2, reviewed_by = $3, reviewed_at = now(), rejection_reason = $4 WHERE user_id = $1`,
        [userId, status, actor.id, decision === 'reject' ? reason : null],
      );
      if (decision === 'approve') {
        await c.query(
          `INSERT INTO user_roles(user_id, role_key, granted_by) VALUES ($1,'verified_driver',$2) ON CONFLICT DO NOTHING`,
          [userId, actor.id],
        );
      } else {
        await c.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_key = 'verified_driver'`, [userId]);
      }
      await this.audit.log(
        {
          actorId: actor.id,
          action: `driver.${status}`,
          targetType: 'user',
          targetId: userId,
          metadata: { reason },
          ip,
        },
        c,
      );
    });
  }

  async reviewVehicle(actor: AuthUser, vehicleId: string, decision: 'approve' | 'reject', ip?: string) {
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await this.db.tx(async (c) => {
      const r = await c.query(`UPDATE vehicles SET verification_status = $2 WHERE id = $1 RETURNING id`, [
        vehicleId,
        status,
      ]);
      if (!r.rows[0]) throw notFound('Vehicle');
      await this.audit.log(
        { actorId: actor.id, action: `vehicle.${status}`, targetType: 'vehicle', targetId: vehicleId, ip },
        c,
      );
    });
  }

  async auditLogs(limit: number, offset: number, action?: string) {
    const { rows } = await this.db.query(
      `SELECT id, actor_id, action, target_type, target_id, metadata, created_at, count(*) OVER() AS total_count
         FROM audit_logs WHERE ($1::text IS NULL OR action = $1) ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [action ?? null, limit, offset],
    );
    return {
      total: rows[0] ? Number(rows[0].total_count) : 0,
      items: rows.map((r: any) => ({
        id: Number(r.id),
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    };
  }

  async getSettings() {
    const { rows } = await this.db.query('SELECT key, value FROM platform_settings ORDER BY key');
    return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
  }

  async updateSetting(actor: AuthUser, key: string, value: unknown, ip?: string) {
    const schema = settingSchemas[key];
    if (!schema) throw new AppError(404, 'unknown_setting', `Unknown setting ${key}`);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AppError(400, 'invalid_setting', 'Invalid value for setting');
    await this.db.tx(async (c) => {
      const old = await c.query('SELECT value FROM platform_settings WHERE key = $1 FOR UPDATE', [key]);
      await c.query(
        `UPDATE platform_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1`,
        [key, JSON.stringify(parsed.data), actor.id],
      );
      await this.audit.log(
        {
          actorId: actor.id,
          action: 'setting.changed',
          targetType: 'setting',
          targetId: key,
          metadata: { from: old.rows[0]?.value, to: parsed.data },
          ip,
        },
        c,
      );
    });
  }

  private async targetWithRoles(c: { query: any }, id: string) {
    // FOR UPDATE cannot be combined with GROUP BY, so lock the user row first, then read roles.
    const u = await c.query('SELECT status FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!u.rows[0]) throw notFound('User');
    const r = await c.query('SELECT role_key FROM user_roles WHERE user_id = $1', [id]);
    return { status: u.rows[0].status as string, roles: r.rows.map((x: any) => x.role_key as string) };
  }

  /** Only holders of roles:assign (super administrators) may act on staff accounts. */
  private assertCanManage(actor: AuthUser, targetRoles: string[]) {
    if (targetRoles.some((r) => PRIVILEGED.includes(r)) && !hasPermission(actor, 'roles:assign')) {
      throw forbidden('Only a super administrator can manage staff accounts');
    }
  }
}
