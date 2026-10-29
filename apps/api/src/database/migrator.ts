import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

export const defaultMigrationsDir = () =>
  process.env.MIGRATIONS_DIR ?? resolve(__dirname, '../../../../database/migrations');
export const defaultSeedsDir = () =>
  process.env.SEEDS_DIR ?? resolve(__dirname, '../../../../database/seeds');

const LOCK_KEY = 727401; // arbitrary advisory-lock id so concurrent deploys serialize

/** Applies pending .sql migrations in filename order, each in its own transaction. Returns applied versions. */
export async function migrate(databaseUrl: string, dir = defaultMigrationsDir()): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  } finally {
    client.release();
    await pool.end();
  }
  return applied;
}

export async function runSeedFile(databaseUrl: string, file: string, dir = defaultSeedsDir()): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(readFileSync(join(dir, file), 'utf8'));
  } finally {
    await pool.end();
  }
}
