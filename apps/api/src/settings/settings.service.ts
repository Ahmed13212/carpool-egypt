import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../database/database.service';

/** Database-backed platform settings. Read on every use (no cache) so admin changes apply immediately. */
@Injectable()
export class SettingsService {
  constructor(private readonly db: DatabaseService) {}

  async getAll(q: Queryable = this.db.pool): Promise<Record<string, unknown>> {
    const { rows } = await q.query('SELECT key, value FROM platform_settings');
    return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
  }
  async bool(key: string, q?: Queryable): Promise<boolean> {
    return (await this.getAll(q))[key] === true;
  }
  async number(key: string, q?: Queryable): Promise<number> {
    const v = (await this.getAll(q))[key];
    if (typeof v !== 'number') throw new Error(`Setting ${key} missing or not a number`);
    return v;
  }
}
