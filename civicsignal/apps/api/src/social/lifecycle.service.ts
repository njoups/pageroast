import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { Database } from '../database/database.service';
import { purgeMentions } from '../governance/purge';
import { ConnectorError, type RawRecord } from '../ingestion/connectors/connector';
import { getConnector } from '../ingestion/connectors/registry';
import { logEvent } from '../ingestion/log';
import { CREDENTIAL_CIPHER, SAFE_HTTP } from '../ingestion/pipeline.service';
import type { SafeHttpClient } from '../ingestion/safe-http';
import type { CredentialCipher } from '../ingestion/secrets';
import { normalizeTitle, contentHash } from '../ingestion/dedup';
import { SOCIAL_KINDS } from './providers';
import { pauseConnector, providerDay, quotaState, recordProviderUsage } from './quota';

const SYS = '00000000-0000-0000-0000-000000000000';
const REFRESH_MARGIN_DAYS = 5;

interface ConnRow {
  connector_id: string; source_id: string; kind: string; config: unknown; rights: { storageMaxDays?: number; refreshWithinDays?: number };
  authorization_status: string; permitted_fields: string[]; ciphertext: string | null; paused_until: Date | null; paused_reason: string | null;
}
export interface LifecycleSummary { connectorId: string; checked: number; refreshed: number; removedAtProvider: number; expired: number; blockedByLegalHold: number; refreshError: string | null }

/**
 * Provider data lifecycle (refresh-or-delete obligations, e.g. YouTube Developer Policies III.E.4: stored API data must
 * be refreshed or deleted within 30 days). For each social connector of a tenant:
 *  1. records whose refresh is due are re-read from the provider: still available → text, metrics and deadlines are
 *     updated; no longer returned (deleted, private, removed) → purged with everything derived from them;
 *  2. records past their deletion deadline (refresh impossible: credentials removed, authorization revoked, quota) are purged;
 *  3. under a legal hold nothing is deleted; the blocked obligations are counted, audited and shown on the connector.
 */
@Injectable()
export class SocialLifecycleService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(SAFE_HTTP) private readonly http: SafeHttpClient,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher | null,
  ) {}

  async runTenant(tenantId: string, now = new Date(), batch = 500): Promise<LifecycleSummary[]> {
    const { conns, hold } = await this.db.withTenant(tenantId, SYS, async (c) => ({
      conns: (await c.query<ConnRow>(
        `SELECT k.id AS connector_id, s.id AS source_id, k.kind, k.config, k.rights, s.authorization_status, s.permitted_fields, cc.ciphertext,
                k.paused_until, k.paused_reason
         FROM connectors k JOIN sources s ON s.id = k.source_id LEFT JOIN connector_credentials cc ON cc.connector_id = k.id
         WHERE k.kind = ANY($1::text[])`, [SOCIAL_KINDS])).rows,
      hold: !!(await c.query<{ legal_hold: boolean }>('SELECT legal_hold FROM tenant_data_controls WHERE tenant_id = $1', [tenantId])).rows[0]?.legal_hold,
    }));
    const out: LifecycleSummary[] = [];
    for (const k of conns) out.push(await this.runConnector(tenantId, k, hold, now, batch));
    return out;
  }

  private async runConnector(tenantId: string, k: ConnRow, hold: boolean, now: Date, batch: number): Promise<LifecycleSummary> {
    const sum: LifecycleSummary = { connectorId: k.connector_id, checked: 0, refreshed: 0, removedAtProvider: 0, expired: 0, blockedByLegalHold: 0, refreshError: null };
    const due = await this.db.withTenant(tenantId, SYS, async (c) => (await c.query<{ id: string; external_id: string; content_type: string }>(
      `SELECT id, external_id, content_type FROM mentions WHERE source_id = $1 AND refresh_due_at <= $2 AND external_id IS NOT NULL
       ORDER BY refresh_due_at LIMIT $3`, [k.source_id, now, batch])).rows);
    const connector = getConnector(k.kind);

    // 1. Refresh.
    if (due.length && connector?.refresh) {
      const usable = k.authorization_status === 'authorized' && !!k.ciphertext && !!this.cipher
        && !(k.paused_reason === 'provider_quota' && k.paused_until && k.paused_until > now);
      if (!usable) sum.refreshError = k.authorization_status !== 'authorized' ? 'connector not authorized' : !k.ciphertext ? 'no credentials' : !this.cipher ? 'CREDENTIALS_KEY not configured' : 'provider quota paused';
      else {
        try {
          const cfg = connector.validateConfig(k.config);
          const need = Math.ceil(due.length / 50) + 1;
          const q = await this.db.withTenant(tenantId, SYS, (c) => quotaState(c, k.connector_id, k.kind, k.config, now));
          const units = q.buckets.find((b) => b.key === 'units');
          if (units?.remaining !== null && units?.remaining !== undefined && units.remaining < need) throw new ConnectorError('quota', `Not enough provider quota left today to refresh ${due.length} records`);
          const credentials = this.cipher!.decrypt(k.ciphertext!, k.connector_id);
          const r = await connector.refresh({ config: cfg, url: null, http: this.http, cache: { etag: null, lastModified: null }, credentials },
            due.map((d) => ({ externalId: d.external_id, contentType: d.content_type })));
          sum.checked = due.length;
          await this.db.withTenant(tenantId, SYS, async (c) => {
            await recordProviderUsage(c, { tenantId, connectorId: k.connector_id, kind: k.kind, usage: r.usage, retrieved: r.records.length });
            for (const rec of r.records) if (await this.applyRefresh(c, k, rec, now)) sum.refreshed++;
            const gone = due.filter((d) => r.missing.includes(d.external_id)).map((d) => d.id);
            if (gone.length) {
              if (hold) sum.blockedByLegalHold += gone.length;
              else { await purgeMentions(c, gone, now, `no longer available at ${k.kind}`); sum.removedAtProvider = gone.length; }
            }
          });
        } catch (e) {
          const err = e instanceof ConnectorError ? e : new ConnectorError('network', (e as Error).message);
          sum.refreshError = `${err.kind}: ${err.message}`.slice(0, 300);
          await this.db.withTenant(tenantId, SYS, async (c) => {
            if (err.opts.usage) await recordProviderUsage(c, { tenantId, connectorId: k.connector_id, kind: k.kind, usage: err.opts.usage });
            if (err.kind === 'quota' && err.opts.resumeAt) await pauseConnector(c, { tenantId, connectorId: k.connector_id, sourceId: k.source_id, until: err.opts.resumeAt, reason: 'provider_quota', periodKey: providerDay(k.kind, now).day });
          });
          logEvent('warn', 'social.lifecycle_refresh_failed', { tenantId, connectorId: k.connector_id, errorKind: err.kind });
        }
      }
    }

    // 2. Deadline passed without a refresh: delete (or count as blocked under legal hold).
    await this.db.withTenant(tenantId, SYS, async (c) => {
      const overdue = (await c.query<{ id: string }>(`SELECT id FROM mentions WHERE source_id = $1 AND provider_delete_by <= $2 LIMIT $3`, [k.source_id, now, batch])).rows.map((r) => r.id);
      if (overdue.length) {
        if (hold) sum.blockedByLegalHold += overdue.length;
        else { await purgeMentions(c, overdue, now, `${k.kind} storage limit reached without refresh`); sum.expired = overdue.length; }
      }
      if (sum.checked || sum.expired || sum.removedAtProvider || sum.blockedByLegalHold || sum.refreshError) {
        await c.query(`INSERT INTO provider_lifecycle_runs (tenant_id, connector_id, started_at, finished_at, checked, refreshed, removed_at_provider, expired, blocked_by_legal_hold, refresh_error)
          VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9)`, [tenantId, k.connector_id, now, sum.checked, sum.refreshed, sum.removedAtProvider, sum.expired, sum.blockedByLegalHold,
          sum.refreshError ? JSON.stringify({ message: sum.refreshError }) : null]);
      }
      if (sum.expired || sum.removedAtProvider || sum.blockedByLegalHold) {
        await this.audit.record(c, { tenantId, actorUserId: null, action: sum.blockedByLegalHold ? 'social.lifecycle_blocked_by_legal_hold' : 'social.lifecycle_purged',
          targetType: 'source', targetId: k.source_id, outcome: sum.blockedByLegalHold ? 'denied' : 'success',
          metadata: { removedAtProvider: sum.removedAtProvider, expired: sum.expired, blockedByLegalHold: sum.blockedByLegalHold } });
      }
    });
    return sum;
  }

  /** Updates one stored record from a refresh (only fields the source permits) and restarts its provider deadlines. */
  private async applyRefresh(c: PoolClient, k: ConnRow, rec: RawRecord, now: Date): Promise<boolean> {
    const sf = rec.social; if (!sf) return false;
    const permitted = new Set(k.permitted_fields);
    const excerpt = permitted.has('excerpt') ? rec.summary?.slice(0, 1000) ?? null : null;
    const deleteBy = k.rights?.storageMaxDays ? new Date(now.getTime() + k.rights.storageMaxDays * 86_400_000) : null;
    const refreshDue = k.rights?.refreshWithinDays ? new Date(now.getTime() + Math.max(k.rights.refreshWithinDays - REFRESH_MARGIN_DAYS, 1) * 86_400_000) : null;
    const hashtags = sf.hashtags.filter((h) => `${rec.title}\n${excerpt ?? ''}`.toLowerCase().includes(`#${h}`));
    const r = await c.query(
      `UPDATE mentions SET title = $3, excerpt = $4, hashtags = $5, engagement = $6, engagement_observed_at = $7, last_verified_at = $7,
         refresh_due_at = $8, provider_delete_by = $9, normalized_title = $10, content_hash = $11
       WHERE source_id = $1 AND external_id = $2`,
      [k.source_id, sf.externalId, rec.title, excerpt, hashtags, JSON.stringify(permitted.has('metrics') ? sf.engagement : {}), now, refreshDue, deleteBy,
        normalizeTitle(rec.title), contentHash(rec.title, excerpt)]);
    return (r.rowCount ?? 0) > 0;
  }
}

/** Runs the lifecycle for every tenant that has social connectors (worker tick, every 15 minutes). */
export async function socialLifecycleTick(db: Database, svc: SocialLifecycleService, now = new Date()) {
  const tenants = await db.withSystem(async (c) => (await c.query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id));
  let purged = 0; let refreshed = 0;
  for (const t of tenants) {
    const r = await svc.runTenant(t, now).catch((e) => { logEvent('error', 'social.lifecycle_failed', { tenantId: t, message: (e as Error).message }); return []; });
    for (const x of r) { purged += x.expired + x.removedAtProvider; refreshed += x.refreshed; }
  }
  return { tenants: tenants.length, purged, refreshed };
}
