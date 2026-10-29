import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../common/app-error';
import { DatabaseService } from '../database/database.service';

export const updateMeSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z
      .string()
      .regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number')
      .nullable()
      .optional(),
    locale: z.enum(['ar', 'en']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  async getMe(userId: string) {
    const { rows } = await this.db.query(
      `SELECT u.id, u.email, u.locale, u.email_verified_at, p.full_name, p.phone,
              COALESCE(array_agg(ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles
         FROM users u JOIN user_profiles p ON p.user_id = u.id
         LEFT JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.id = $1 GROUP BY u.id, p.user_id`,
      [userId],
    );
    const r = rows[0];
    if (!r) throw notFound('User');
    return {
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      phone: r.phone,
      locale: r.locale,
      emailVerified: !!r.email_verified_at,
      roles: r.roles as string[],
    };
  }

  async updateMe(userId: string, input: z.infer<typeof updateMeSchema>) {
    await this.db.tx(async (c) => {
      if (input.locale)
        await c.query('UPDATE users SET locale = $2, updated_at = now() WHERE id = $1', [
          userId,
          input.locale,
        ]);
      if (input.fullName !== undefined || input.phone !== undefined) {
        await c.query(
          `UPDATE user_profiles SET full_name = COALESCE($2, full_name),
             phone = CASE WHEN $3::boolean THEN $4 ELSE phone END, updated_at = now() WHERE user_id = $1`,
          [userId, input.fullName ?? null, input.phone !== undefined, input.phone ?? null],
        );
      }
    });
    return this.getMe(userId);
  }
}
