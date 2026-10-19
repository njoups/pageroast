import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RequestMeta } from '../common/request';

export interface AuditInput {
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
}

/** Writes inside the caller's transaction so the audit row commits or rolls back with the change. */
@Injectable()
export class AuditService {
  async record(c: PoolClient, e: AuditInput): Promise<void> {
    await c.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, ip, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.tenantId, e.actorUserId, e.action, e.targetType ?? null, e.targetId ?? null,
        JSON.stringify(e.metadata ?? {}), e.meta?.ip ?? null, e.meta?.requestId ?? null]);
  }
}
