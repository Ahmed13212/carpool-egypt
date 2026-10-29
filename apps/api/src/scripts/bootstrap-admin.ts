import type { Pool } from 'pg';
import { PasswordService } from '../auth/password.service';

/** Creates (or promotes) a verified staff account. Password comes from the caller, never from source code. */
export async function createPrivilegedUser(
  pool: Pool,
  opts: { email: string; password: string; fullName: string; role: string; scryptN?: number },
): Promise<string> {
  const hash = await new PasswordService({ PASSWORD_SCRYPT_N: opts.scryptN ?? 32768 }).hash(opts.password);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = await c.query(
      `INSERT INTO users(email, password_hash, email_verified_at) VALUES ($1,$2,now()) RETURNING id`,
      [opts.email, hash],
    );
    const id = u.rows[0].id as string;
    await c.query(`INSERT INTO user_profiles(user_id, full_name) VALUES ($1,$2)`, [id, opts.fullName]);
    await c.query(`INSERT INTO user_roles(user_id, role_key) VALUES ($1,'passenger'), ($1,$2)`, [
      id,
      opts.role,
    ]);
    await c.query(
      `INSERT INTO audit_logs(action, target_type, target_id, metadata) VALUES ('user.bootstrapped','user',$1,$2)`,
      [id, JSON.stringify({ role: opts.role })],
    );
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
