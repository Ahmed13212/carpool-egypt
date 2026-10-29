import { Pool } from 'pg';
import { loadDotEnv, loadEnv } from '../config/env';
import { runSeedFile } from '../database/migrator';

/** Seeds reference cities. With --dev also enables booking/publishing flags for LOCAL development only. */
async function main() {
  loadDotEnv();
  const env = loadEnv();
  await runSeedFile(env.DATABASE_URL, 'cities.sql');
  console.log('Seeded cities');
  if (process.argv.includes('--dev')) {
    if (env.NODE_ENV === 'production') throw new Error('Refusing --dev seed in production');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
    await pool.query(
      `UPDATE platform_settings SET value='true', updated_at=now() WHERE key IN ('trip_publishing_enabled','booking_enabled')`,
    );
    await pool.end();
    console.log('Enabled trip_publishing_enabled and booking_enabled (dev only)');
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
