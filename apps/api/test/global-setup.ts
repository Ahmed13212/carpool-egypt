import { Pool } from 'pg';
import { migrate, runSeedFile } from '../src/database/migrator';

/** Resets the TEST database (drops only tables owned by the app role), applies migrations and reference seeds. */
export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      'Set TEST_DATABASE_URL to a DISPOSABLE Postgres+PostGIS database (app tables are dropped on every run).',
    );
  const pool = new Pool({ connectionString: url, max: 1 });
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
  );
  for (const r of rows) await pool.query(`DROP TABLE IF EXISTS public."${r.tablename}" CASCADE`);
  const applied = await migrate(url);
  await runSeedFile(url, 'cities.sql');
  // Tests need the (default OFF) operational flags enabled.
  await pool.query(
    `UPDATE platform_settings SET value = 'true' WHERE key IN ('trip_publishing_enabled','booking_enabled')`,
  );
  await pool.end();
  if (!applied.length) throw new Error('Expected migrations to be applied on a clean database');
}
