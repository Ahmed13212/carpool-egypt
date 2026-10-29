import { Pool } from 'pg';
import { loadDotEnv, loadEnv } from '../config/env';
import { createPrivilegedUser } from './bootstrap-admin';

/** Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run create-admin -w apps/api  (creates a super_administrator) */
async function main() {
  loadDotEnv();
  const env = loadEnv();
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars) in the environment');
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const id = await createPrivilegedUser(pool, {
    email,
    password,
    fullName: 'Super Administrator',
    role: 'super_administrator',
    scryptN: env.PASSWORD_SCRYPT_N,
  });
  await pool.end();
  console.log(
    `Created super administrator ${email} (${id}). Enable MFA before production use (not yet implemented).`,
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
