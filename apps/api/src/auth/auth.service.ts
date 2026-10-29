import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, conflict } from '../common/app-error';
import { ENV, Env } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { DevMailer } from './mailer';
import { PasswordService } from './password.service';
import type { RegisterInput } from './auth.schemas';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}
export interface Tokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = '';
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly mailer: DevMailer,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit() {
    // Used to equalise timing when the e-mail does not exist (reduces account enumeration via timing).
    this.dummyHash = await this.passwords.hash(randomBytes(12).toString('hex'));
  }

  async register(input: RegisterInput) {
    const hash = await this.passwords.hash(input.password);
    let userId: string;
    let verificationToken: string;
    try {
      ({ userId, verificationToken } = await this.db.tx(async (c) => {
        const u = await c.query(
          `INSERT INTO users(email, password_hash, locale) VALUES ($1,$2,$3) RETURNING id`,
          [input.email, hash, input.locale],
        );
        const id = u.rows[0].id as string;
        await c.query(`INSERT INTO user_profiles(user_id, full_name) VALUES ($1,$2)`, [id, input.fullName]);
        await c.query(`INSERT INTO user_roles(user_id, role_key) VALUES ($1,'passenger')`, [id]);
        const token = await this.createAuthToken(c, id, 'email_verification', 24 * 60);
        return { userId: id, verificationToken: token };
      }));
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('email_taken', 'An account with this email already exists');
      throw e;
    }
    await this.mailer.send({ to: input.email, kind: 'email_verification', token: verificationToken });
    return { id: userId, email: input.email };
  }

  async login(email: string, password: string, meta: ClientMeta) {
    const { rows } = await this.db.query('SELECT id, password_hash, status FROM users WHERE email = $1', [
      email,
    ]);
    const user = rows[0];
    const ok = await this.passwords.verify(password, user?.password_hash ?? this.dummyHash);
    if (!user || !ok) throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
    if (user.status !== 'active') throw new AppError(403, 'account_suspended', 'This account is not active');
    const tokens = await this.issueSession(user.id, meta, randomUUID());
    return { tokens, userId: user.id as string };
  }

  async refresh(refreshToken: string, meta: ClientMeta) {
    const outcome = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT s.*, u.status FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_token_hash = $1 FOR UPDATE OF s`,
        [sha256(refreshToken)],
      );
      const s = rows[0];
      if (!s) return { kind: 'invalid' as const };
      if (s.revoked_at) {
        // A rotated/revoked token was replayed: assume theft and kill every session of this user.
        await c.query(
          `UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [s.user_id],
        );
        await this.audit.log(
          {
            actorId: s.user_id,
            action: 'auth.refresh_token_reuse_detected',
            targetType: 'user',
            targetId: s.user_id,
            ip: meta.ip,
          },
          c,
        );
        return { kind: 'reuse' as const };
      }
      if (s.expires_at < new Date() || s.status !== 'active') return { kind: 'invalid' as const };
      await c.query(`UPDATE user_sessions SET revoked_at = now() WHERE id = $1`, [s.id]);
      const tokens = await this.issueSession(s.user_id, meta, s.family_id, c);
      return { kind: 'ok' as const, tokens };
    });
    if (outcome.kind !== 'ok') throw new AppError(401, 'invalid_refresh_token', 'Invalid refresh token');
    return outcome.tokens;
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) return;
    await this.db.query(
      `UPDATE user_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [sha256(refreshToken)],
    );
  }

  async verifyEmail(token: string) {
    await this.db.tx(async (c) => {
      const t = await this.consumeAuthToken(c, token, 'email_verification');
      await c.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`,
        [t.user_id],
      );
    });
  }

  async requestPasswordReset(email: string) {
    const { rows } = await this.db.query(`SELECT id FROM users WHERE email = $1 AND status = 'active'`, [
      email,
    ]);
    if (!rows[0]) return; // identical response either way: no account enumeration
    const token = await this.createAuthToken(this.db.pool, rows[0].id, 'password_reset', 60);
    await this.mailer.send({ to: email, kind: 'password_reset', token });
  }

  async resetPassword(token: string, newPassword: string) {
    const hash = await this.passwords.hash(newPassword);
    await this.db.tx(async (c) => {
      const t = await this.consumeAuthToken(c, token, 'password_reset');
      await c.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [
        t.user_id,
        hash,
      ]);
      await c.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
        t.user_id,
      ]);
      await this.audit.log(
        { actorId: t.user_id, action: 'auth.password_reset', targetType: 'user', targetId: t.user_id },
        c,
      );
    });
  }

  async changePassword(userId: string, current: string, next: string) {
    const { rows } = await this.db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !(await this.passwords.verify(current, rows[0].password_hash))) {
      throw new AppError(403, 'invalid_credentials', 'Current password is incorrect');
    }
    const hash = await this.passwords.hash(next);
    await this.db.tx(async (c) => {
      await c.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [userId, hash]);
      await c.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
        userId,
      ]);
      await this.audit.log(
        { actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId },
        c,
      );
    });
  }

  private async issueSession(
    userId: string,
    meta: ClientMeta,
    familyId: string,
    q: { query: any } = this.db.pool,
  ): Promise<Tokens> {
    const refreshToken = newToken();
    const refreshExpiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
    const { rows } = await q.query(
      `INSERT INTO user_sessions(user_id, family_id, refresh_token_hash, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        userId,
        familyId,
        sha256(refreshToken),
        meta.userAgent?.slice(0, 300) ?? null,
        meta.ip ?? null,
        refreshExpiresAt,
      ],
    );
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: rows[0].id });
    return { accessToken, expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS, refreshToken, refreshExpiresAt };
  }

  private async createAuthToken(
    q: { query: any },
    userId: string,
    type: string,
    ttlMinutes: number,
  ): Promise<string> {
    const token = newToken();
    await q.query(
      `INSERT INTO auth_tokens(user_id, type, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
      [userId, type, sha256(token), ttlMinutes],
    );
    return token;
  }

  private async consumeAuthToken(c: { query: any }, token: string, type: string) {
    const { rows } = await c.query(
      `UPDATE auth_tokens SET used_at = now()
        WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(token), type],
    );
    if (!rows[0]) throw new AppError(400, 'invalid_token', 'Token is invalid, used or expired');
    return rows[0] as { user_id: string };
  }
}
