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
  /** success (default), failure (attempt failed, e.g. wrong password) or denied (authorization refused). */
  outcome?: 'success' | 'failure' | 'denied';
}

/** Keys that must never reach audit metadata, at any depth. */
const SENSITIVE = /password|passwd|secret|api_?key|authorization|cookie|ciphertext|credential|token$/i;
export function scrubMetadata(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubMetadata(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE.test(k.replace(/-/g, '_')) ? '[redacted]' : scrubMetadata(x, depth + 1)]));
}

/**
 * Writes inside the caller's transaction so the audit row commits or rolls back with the change. Rows are append-only and
 * hash-chained per tenant by the database (migration 0010); metadata keys that look like credentials are redacted.
 */
@Injectable()
export class AuditService {
  async record(c: PoolClient, e: AuditInput): Promise<void> {
    await c.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata, ip, request_id, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.tenantId, e.actorUserId, e.action, e.targetType ?? null, e.targetId ?? null,
        JSON.stringify(scrubMetadata(e.metadata ?? {})), e.meta?.ip ?? null, e.meta?.requestId ?? null, e.outcome ?? 'success']);
  }
}
