import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/app-error';
import { DatabaseService } from '../database/database.service';
import { IS_PUBLIC, PERMISSIONS } from './auth.decorators';
import type { AuthUser } from './auth.types';

/**
 * Global guard. Authenticates the bearer JWT, then re-reads session + account state from the database on
 * every request, so suspension and session revocation take effect immediately. Then enforces @RequirePermissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'unauthorized', 'Authentication required');

    let payload: { sub: string; sid: string };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7), { algorithms: ['HS256'] });
    } catch {
      throw new AppError(401, 'invalid_token', 'Invalid or expired token');
    }
    if (!payload?.sub || !payload?.sid) throw new AppError(401, 'invalid_token', 'Invalid or expired token');

    const { rows } = await this.db.query(
      `SELECT u.id, u.email, u.status, u.email_verified_at, s.revoked_at, s.expires_at,
              COALESCE(array_agg(DISTINCT ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles,
              COALESCE(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS perms
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN role_permissions rp ON rp.role_key = ur.role_key
        WHERE s.id = $1 AND u.id = $2
        GROUP BY u.id, s.id`,
      [payload.sid, payload.sub],
    );
    const row = rows[0];
    if (!row || row.revoked_at || row.expires_at < new Date() || row.status !== 'active') {
      throw new AppError(401, 'invalid_token', 'Session is no longer valid');
    }
    const user: AuthUser = {
      id: row.id,
      email: row.email,
      sessionId: payload.sid,
      roles: row.roles,
      permissions: row.perms,
      emailVerified: !!row.email_verified_at,
    };
    req.user = user;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS, targets) ?? [];
    if (required.some((p) => !user.permissions.includes(p))) {
      throw new AppError(403, 'forbidden', 'You do not have permission to perform this action');
    }
    return true;
  }
}
