import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../database/database.service';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /** Pass a transaction client so the audit row commits atomically with the change it describes. */
  async log(entry: AuditEntry, q: Queryable = this.db.pool): Promise<void> {
    await q.query(
      `INSERT INTO audit_logs(actor_id, action, target_type, target_id, metadata, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        entry.actorId ?? null,
        entry.action,
        entry.targetType,
        entry.targetId ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.ip ?? null,
      ],
    );
  }
}
