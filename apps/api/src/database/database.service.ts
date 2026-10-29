import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ENV, Env } from '../config/env';

export type Queryable = { query: PoolClient['query'] };

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 30000,
    });
  }

  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params as any[]);
  }

  /** Runs fn in a transaction (READ COMMITTED). Rolls back on any thrown error. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}
