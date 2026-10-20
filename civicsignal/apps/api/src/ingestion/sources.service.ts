import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import type { Queue } from 'bullmq';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { Database } from '../database/database.service';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import type { AuthContext, RequestMeta, TenantContext } from '../common/request';
import { ConnectorError } from './connectors/connector';
import { getConnector } from './connectors/registry';
import { computeHealth } from './health';
import { INGESTION_QUEUE, REDIS } from './ingestion-core.module';
import { CREDENTIAL_CIPHER, type CollectJob } from './pipeline.service';
import { enqueueCollect, jobIds, workerHeartbeats, type Redis } from './queue';
import type { CredentialCipher } from './secrets';
import type { CreateSourceDto, UpdateSourceDto } from './sources.dto';
import { assertFetchableUrl, UnsafeUrlError } from './url';
import { isSocialKind } from '../social/providers';
import { collectionGate, commercialError, loadEntitlements, requireCapacity } from '../commercial/quota';

const SOURCE_COLS = `s.id, s.name, s.domain, s.category, s.collection_method, s.feed_url, s.enabled, s.authorization_status,
  s.authorization_basis, s.verification_status, s.permitted_fields, s.permits_full_text, s.refresh_interval_seconds,
  s.rate_limit_per_minute, s.quota_per_day, s.license_terms, s.usage_restrictions, s.redistribution_restrictions,
  s.retention_days, s.attribution_requirement, s.last_success_at, s.last_attempt_at, s.last_error, s.records_collected,
  s.consecutive_failures, s.health_status, s.created_at, s.updated_at,
  k.id AS connector_id, k.kind, k.config, k.status AS connector_status, k.verified_at,
  (cc.connector_id IS NOT NULL) AS has_credentials, cc.hint AS credentials_hint, cc.updated_at AS credentials_updated_at,
  sch.next_due_at, sch.active AS schedule_active`;
const FROM = `FROM sources s JOIN connectors k ON k.source_id = s.id
  LEFT JOIN connector_credentials cc ON cc.connector_id = k.id LEFT JOIN ingestion_schedule sch ON sch.source_id = s.id`;

type Row = Record<string, unknown> & { last_error: { kind?: string } | null; enabled: boolean; last_attempt_at: Date | null; last_success_at: Date | null; consecutive_failures: number; refresh_interval_seconds: number };

/** API shape. Credentials are reduced to configured/hint; ciphertext never leaves the database layer. */
export function presentSource(r: Row) {
  const connector = getConnector(String(r.kind));
  return {
    id: r.id, name: r.name, domain: r.domain, category: r.category, collectionMethod: r.collection_method, feedUrl: r.feed_url,
    enabled: r.enabled, authorizationStatus: r.authorization_status, authorizationBasis: r.authorization_basis,
    verificationStatus: r.verification_status, permittedFields: r.permitted_fields, permitsFullText: r.permits_full_text,
    refreshIntervalSeconds: r.refresh_interval_seconds, rateLimitPerMinute: r.rate_limit_per_minute, quotaPerDay: r.quota_per_day,
    licenseTerms: r.license_terms, usageRestrictions: r.usage_restrictions, redistributionRestrictions: r.redistribution_restrictions,
    retentionDays: r.retention_days, attributionRequirement: r.attribution_requirement,
    lastSuccessAt: r.last_success_at, lastAttemptAt: r.last_attempt_at, lastError: r.last_error, recordsCollected: Number(r.records_collected),
    consecutiveFailures: r.consecutive_failures,
    // Recomputed at read time so collection lag shows up even when no run has happened since.
    health: computeHealth({ enabled: r.enabled, lastAttemptAt: r.last_attempt_at, lastSuccessAt: r.last_success_at, consecutiveFailures: r.consecutive_failures, lastErrorKind: r.last_error?.kind ?? null, refreshIntervalSeconds: r.refresh_interval_seconds }),
    schedule: { active: r.schedule_active ?? false, nextDueAt: r.next_due_at ?? null },
    connector: {
      id: r.connector_id, kind: r.kind, config: r.config, status: r.connector_status, verifiedAt: r.verified_at, version: connector?.version ?? null,
      requiresCredentials: connector?.requiresCredentials ?? false,
      credentials: { configured: r.has_credentials, hint: r.credentials_hint ?? null, updatedAt: r.credentials_updated_at ?? null },
    },
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

@Injectable()
export class SourcesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(INGESTION_QUEUE) private readonly queue: Queue<CollectJob> | null,
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher | null,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private async loadRow(c: PoolClient, id: string): Promise<Row> {
    const r = await c.query<Row>(`SELECT ${SOURCE_COLS} ${FROM} WHERE s.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Source');
    return r.rows[0];
  }

  private validateUrl(url: string): string {
    try { return assertFetchableUrl(url, { allowPrivateHosts: this.config.ingestion.allowPrivateHosts }).toString(); }
    catch (e) { throw badRequest('validation_failed', e instanceof UnsafeUrlError ? `feedUrl: ${e.message}` : 'feedUrl is invalid'); }
  }

  private validateConnectorConfig(kind: string, cfg: unknown) {
    const connector = getConnector(kind)!;
    try { return connector.validateConfig(kind === 'feed' ? cfg ?? {} : cfg); }
    catch (e) { throw badRequest('validation_failed', e instanceof ConnectorError ? e.message : 'Invalid connector configuration'); }
  }

  private checkRules(next: { authorizationStatus: string; authorizationBasis: string | null; enabled: boolean; permittedFields: string[] }) {
    if (next.authorizationStatus === 'authorized' && !next.authorizationBasis?.trim()) {
      throw badRequest('authorization_basis_required', 'Record the legal or contractual basis before marking a source authorized');
    }
    if (next.enabled && next.authorizationStatus !== 'authorized') {
      throw conflict('source_not_authorized', 'Only authorized sources can be enabled for collection');
    }
    if (!next.permittedFields.includes('title') || !next.permittedFields.includes('url')) {
      throw badRequest('validation_failed', 'permittedFields must include title and url (attribution requires them)');
    }
  }

  list(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) =>
      (await c.query<Row>(`SELECT ${SOURCE_COLS} ${FROM} ORDER BY s.name`)).rows.map(presentSource));
  }

  get(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => presentSource(await this.loadRow(c, id)));
  }

  create(auth: AuthContext, t: TenantContext, dto: CreateSourceDto, meta: RequestMeta) {
    const kind = dto.kind;
    let feedUrl: string | null = null; let domain: string;
    const config = this.validateConnectorConfig(kind, dto.connectorConfig);
    if (kind === 'feed') {
      if (!dto.feedUrl) throw badRequest('validation_failed', 'feedUrl is required for feed sources');
      feedUrl = this.validateUrl(dto.feedUrl);
      domain = new URL(feedUrl).hostname.replace(/^www\./, '');
    } else {
      if (dto.feedUrl) throw badRequest('validation_failed', 'GDELT sources do not take a feedUrl');
      domain = 'gdeltproject.org';
    }
    const permittedFields = dto.permittedFields ?? ['title', 'url', 'published_at'];
    const authorizationStatus = dto.authorizationStatus ?? 'unverified';
    const enabled = false; // sources are created disabled; enabling is an explicit, audited action
    this.checkRules({ authorizationStatus, authorizationBasis: dto.authorizationBasis ?? null, enabled, permittedFields });
    const method = kind === 'gdelt' ? 'licensed_provider' : dto.format ?? 'rss';
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const s = await c.query<{ id: string }>(
        `INSERT INTO sources (tenant_id, name, domain, category, collection_method, feed_url, enabled, authorization_status, authorization_basis,
           permitted_fields, permits_full_text, refresh_interval_seconds, rate_limit_per_minute, quota_per_day, license_terms, usage_restrictions,
           redistribution_restrictions, retention_days, attribution_requirement, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [t.orgId, dto.name, domain, dto.category ?? 'news', method, feedUrl, enabled, authorizationStatus, dto.authorizationBasis ?? null,
          permittedFields, dto.permitsFullText ?? false, dto.refreshIntervalSeconds ?? 3600, dto.rateLimitPerMinute ?? null, dto.quotaPerDay ?? null,
          dto.licenseTerms ?? null, dto.usageRestrictions ?? null, dto.redistributionRestrictions ?? null, dto.retentionDays ?? null,
          dto.attributionRequirement ?? null, auth.userId])
        .catch((e: { code?: string }) => { throw e.code === '23505' ? conflict('source_exists', 'This feed URL is already registered') : e; });
      const id = s.rows[0]!.id;
      await c.query(`INSERT INTO connectors (tenant_id, source_id, kind, config, status) VALUES ($1,$2,$3,$4,$5)`,
        [t.orgId, id, kind, JSON.stringify(config), getConnector(kind)!.requiresCredentials ? 'unconfigured' : 'configured']);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'source.created', targetType: 'source', targetId: id,
        metadata: { name: dto.name, kind, authorizationStatus }, meta });
      return presentSource(await this.loadRow(c, id));
    });
  }

  update(auth: AuthContext, t: TenantContext, id: string, dto: UpdateSourceDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.loadRow(c, id);
      const kind = String(cur.kind);
      if (isSocialKind(kind)) throw badRequest('use_social_api', 'Social connectors are configured through /social/connectors (provider limits apply there)');
      if (dto.feedUrl !== undefined && kind !== 'feed') throw badRequest('validation_failed', 'Only feed sources have a feedUrl');
      const feedUrl = dto.feedUrl !== undefined ? this.validateUrl(dto.feedUrl) : (cur.feed_url as string | null);
      const config = dto.connectorConfig !== undefined ? this.validateConnectorConfig(kind, dto.connectorConfig) : cur.config;
      // The authorization basis was recorded for one publisher. Moving the feed to another host needs a fresh, explicit
      // authorization in the same request; otherwise the source drops back to 'unverified' (and stops collecting).
      const host = (u: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : null; } catch { return null; } };
      const hostChanged = dto.feedUrl !== undefined && host(cur.feed_url as string | null) !== host(feedUrl);
      const reauthorized = dto.authorizationStatus === 'authorized' && !!dto.authorizationBasis?.trim();
      const authorizationStatus = hostChanged && !reauthorized ? 'unverified' : dto.authorizationStatus ?? String(cur.authorization_status);
      // Leaving 'authorized' always stops collection.
      const enabled = authorizationStatus === 'authorized' ? cur.enabled : false;
      const authorizationBasis = dto.authorizationBasis !== undefined ? dto.authorizationBasis : (cur.authorization_basis as string | null);
      const permittedFields = dto.permittedFields ?? (cur.permitted_fields as string[]);
      this.checkRules({ authorizationStatus, authorizationBasis, enabled, permittedFields });
      await c.query(
        `UPDATE sources SET name = coalesce($2, name), feed_url = $3, domain = CASE WHEN $3::text IS NULL THEN domain ELSE regexp_replace(substring($3 from '^[a-z]+://([^/:?#]+)'), '^www\\.', '') END,
           category = coalesce($4, category), collection_method = CASE WHEN $5::text IS NULL THEN collection_method ELSE $5 END,
           authorization_status = $6, authorization_basis = $7, enabled = $8, permitted_fields = $9,
           permits_full_text = coalesce($10, permits_full_text), refresh_interval_seconds = coalesce($11, refresh_interval_seconds),
           rate_limit_per_minute = CASE WHEN $12 THEN $13::int ELSE rate_limit_per_minute END,
           quota_per_day = CASE WHEN $14 THEN $15::int ELSE quota_per_day END,
           license_terms = coalesce($16, license_terms), usage_restrictions = coalesce($17, usage_restrictions),
           redistribution_restrictions = coalesce($18, redistribution_restrictions),
           retention_days = CASE WHEN $19 THEN $20::int ELSE retention_days END, attribution_requirement = coalesce($21, attribution_requirement)
         WHERE id = $1`,
        [id, dto.name ?? null, feedUrl, dto.category ?? null, kind === 'feed' ? dto.format ?? null : null, authorizationStatus, authorizationBasis,
          enabled, permittedFields, dto.permitsFullText ?? null, dto.refreshIntervalSeconds ?? null,
          dto.rateLimitPerMinute !== undefined, dto.rateLimitPerMinute ?? null, dto.quotaPerDay !== undefined, dto.quotaPerDay ?? null,
          dto.licenseTerms ?? null, dto.usageRestrictions ?? null, dto.redistributionRestrictions ?? null,
          dto.retentionDays !== undefined, dto.retentionDays ?? null, dto.attributionRequirement ?? null])
        .catch((e: { code?: string }) => { throw e.code === '23505' ? conflict('source_exists', 'This feed URL is already registered') : e; });
      if (dto.connectorConfig !== undefined || dto.feedUrl !== undefined) {
        // A different endpoint invalidates HTTP cache validators and earlier verification.
        await c.query(`UPDATE connectors SET config = $2, http_etag = NULL, http_last_modified = NULL, cache_valid_until = NULL, verified_at = NULL WHERE id = $1`, [cur.connector_id, JSON.stringify(config)]);
        await c.query(`UPDATE sources SET verification_status = 'unverified' WHERE id = $1`, [id]);
      }
      const changed = Object.keys(dto);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'source.updated', targetType: 'source', targetId: id,
        metadata: { fields: changed, ...(hostChanged ? { feedHost: { from: host(cur.feed_url as string | null), to: host(feedUrl) }, authorizationReset: !reauthorized } : {}), ...(dto.authorizationStatus && dto.authorizationStatus !== cur.authorization_status ? { authorization: { from: cur.authorization_status, to: dto.authorizationStatus } } : {}) }, meta });
      return presentSource(await this.loadRow(c, id));
    });
  }

  setEnabled(auth: AuthContext, t: TenantContext, id: string, enabled: boolean, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.loadRow(c, id);
      if (enabled && cur.authorization_status !== 'authorized') throw conflict('source_not_authorized', 'Only authorized sources can be enabled for collection');
      if (enabled && cur.connector_status === 'unconfigured') throw conflict('connector_unconfigured', 'Configure the connector credentials before enabling');
      if (enabled && !cur.enabled) await requireCapacity(c, t.orgId, 'active_connectors', 1, isSocialKind(String(cur.kind)) ? 'social_listening' : undefined);
      await c.query(`UPDATE sources SET enabled = $2, health_status = CASE WHEN $2 THEN health_status ELSE 'disabled' END WHERE id = $1`, [id, enabled]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: enabled ? 'source.enabled' : 'source.disabled', targetType: 'source', targetId: id, meta });
      return presentSource(await this.loadRow(c, id));
    });
  }

  remove(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.loadRow(c, id);
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM mentions WHERE source_id = $1', [id])).rows[0]!.n;
      if (n > 0) throw conflict('source_has_mentions', `This source has ${n} collected records whose provenance depends on it; disable it instead`);
      await c.query('DELETE FROM sources WHERE id = $1', [id]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'source.deleted', targetType: 'source', targetId: id, metadata: { name: cur.name }, meta });
    });
  }

  private requireQueue(): Queue<CollectJob> {
    if (!this.queue) throw new AppError(503, 'queue_unavailable', 'The ingestion queue (Redis) is not configured on this server');
    return this.queue;
  }

  /** Queues an immediate collection. Works for authorized sources even while disabled, so admins can test before enabling. */
  collectNow(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    const queue = this.requireQueue();
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.loadRow(c, id);
      if (cur.authorization_status !== 'authorized') throw conflict('source_not_authorized', 'Only authorized sources can be collected');
      const gate = await collectionGate(c, await loadEntitlements(c, t.orgId), isSocialKind(String(cur.kind)));
      if (gate) throw commercialError('quota_exceeded', gate);
      const key = jobIds.manual(id);
      const r = await c.query<{ id: string }>(
        `INSERT INTO connector_runs (tenant_id, connector_id, source_id, idempotency_key, status, trigger, requested_by) VALUES ($1,$2,$3,$4,'queued','manual',$5) RETURNING id`,
        [t.orgId, cur.connector_id, id, key, auth.userId]);
      await enqueueCollect(queue, { tenantId: t.orgId, sourceId: id, trigger: 'manual', idempotencyKey: key, requestedBy: auth.userId });
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'source.collect_requested', targetType: 'source', targetId: id, metadata: { runId: r.rows[0]!.id }, meta });
      return { runId: r.rows[0]!.id, status: 'queued' };
    });
  }

  /** Re-queues a failed or dead-lettered run once (idempotent: a second request for the same run is rejected). */
  retryRun(auth: AuthContext, t: TenantContext, id: string, runId: string, meta: RequestMeta) {
    const queue = this.requireQueue();
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.loadRow(c, id);
      const run = (await c.query<{ status: string }>('SELECT status FROM connector_runs WHERE id = $1 AND source_id = $2', [runId, id])).rows[0];
      if (!run) throw notFound('Run');
      if (!['failed', 'dead_lettered'].includes(run.status)) throw conflict('run_not_retryable', `Only failed or dead-lettered runs can be retried (this run is ${run.status})`);
      if (cur.authorization_status !== 'authorized') throw conflict('source_not_authorized', 'Only authorized sources can be collected');
      const gate = await collectionGate(c, await loadEntitlements(c, t.orgId), isSocialKind(String(cur.kind)));
      if (gate) throw commercialError('quota_exceeded', gate);
      const key = jobIds.retry(runId);
      const r = await c.query<{ id: string }>(
        `INSERT INTO connector_runs (tenant_id, connector_id, source_id, idempotency_key, status, trigger, requested_by) VALUES ($1,$2,$3,$4,'queued','retry',$5)
         ON CONFLICT (tenant_id, connector_id, idempotency_key) DO NOTHING RETURNING id`, [t.orgId, cur.connector_id, id, key, auth.userId]);
      if (!r.rows[0]) throw conflict('retry_already_requested', 'A retry for this run was already requested');
      await enqueueCollect(queue, { tenantId: t.orgId, sourceId: id, trigger: 'retry', idempotencyKey: key, requestedBy: auth.userId });
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'source.run_retried', targetType: 'source', targetId: id, metadata: { runId, newRunId: r.rows[0].id }, meta });
      return { runId: r.rows[0].id, status: 'queued' };
    });
  }

  runs(auth: AuthContext, t: TenantContext, id: string, limit = 50) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.loadRow(c, id);
      return (await c.query(
        `SELECT r.id, r.status, r.trigger, r.attempt, r.records_seen, r.records_new, r.records_known, r.records_duplicate, r.records_rejected,
                r.matches, r.http_status, r.not_modified, r.rate_limited, r.duration_ms, r.error, r.stages, r.rejections,
                r.created_at, r.started_at, r.finished_at, u.display_name AS requested_by_name
         FROM connector_runs r LEFT JOIN users u ON u.id = r.requested_by
         WHERE r.source_id = $1 ORDER BY r.created_at DESC LIMIT $2`, [id, limit])).rows;
    });
  }

  setCredentials(auth: AuthContext, t: TenantContext, id: string, secret: string | null, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.loadRow(c, id);
      const connector = getConnector(String(cur.kind))!;
      if (!connector.requiresCredentials) throw badRequest('credentials_not_supported', `${connector.kind} connectors do not use credentials`);
      if (secret === null) {
        await c.query('DELETE FROM connector_credentials WHERE connector_id = $1', [cur.connector_id]);
        await c.query(`UPDATE connectors SET status = 'unconfigured' WHERE id = $1`, [cur.connector_id]);
        await c.query(`UPDATE sources SET enabled = false WHERE id = $1`, [id]);
      } else {
        if (!this.cipher) throw new AppError(503, 'credentials_storage_unconfigured', 'CREDENTIALS_KEY is not configured on this server');
        const blob = this.cipher.encrypt(secret, String(cur.connector_id));
        await c.query(
          `INSERT INTO connector_credentials (connector_id, tenant_id, ciphertext, key_id, hint, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (connector_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id, hint = EXCLUDED.hint, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [cur.connector_id, t.orgId, blob, this.cipher.keyId, `…${secret.slice(-4)}`, auth.userId]);
        await c.query(`UPDATE connectors SET status = 'configured' WHERE id = $1`, [cur.connector_id]);
      }
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: secret === null ? 'source.credentials_removed' : 'source.credentials_set', targetType: 'source', targetId: id, meta });
    });
  }

  /** Tenant-scoped operational metrics over a window, derived from the run ledger (never from configuration). */
  metrics(auth: AuthContext, t: TenantContext, hours: number) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const agg = (await c.query(
        `SELECT count(*)::int AS attempts,
           count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
           count(*) FILTER (WHERE status IN ('failed','dead_lettered','retrying'))::int AS failed,
           count(*) FILTER (WHERE status = 'dead_lettered')::int AS dead_lettered,
           count(*) FILTER (WHERE status IN ('queued','running'))::int AS in_progress,
           coalesce(sum(records_seen),0)::int AS discovered, coalesce(sum(records_new),0)::int AS new_records,
           coalesce(sum(records_rejected),0)::int AS rejected, coalesce(sum(records_duplicate),0)::int AS duplicates,
           coalesce(sum(records_known),0)::int AS already_known, coalesce(sum(matches),0)::int AS matches,
           coalesce(sum(greatest(attempt - 1, 0)),0)::int AS retries,
           count(*) FILTER (WHERE rate_limited)::int AS rate_limited_responses,
           count(*) FILTER (WHERE not_modified)::int AS not_modified,
           round(avg(duration_ms))::int AS avg_latency_ms,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_latency_ms
         FROM connector_runs WHERE created_at > now() - make_interval(hours => $1)`, [hours])).rows[0];
      const sources = (await c.query(
        `SELECT s.id, s.name, s.enabled, s.health_status, s.last_success_at, s.last_attempt_at, s.refresh_interval_seconds,
           s.consecutive_failures, s.last_error, extract(epoch FROM now() - s.last_success_at)::int AS lag_seconds
         FROM sources s ORDER BY s.name`)).rows;
      let worker: { online: boolean; instances: number } = { online: false, instances: 0 };
      if (this.redis) {
        const beats = await workerHeartbeats(this.redis).catch(() => []);
        worker = { online: beats.some((b) => b.consumer), instances: beats.length };
      }
      return {
        windowHours: hours, generatedAt: new Date().toISOString(), runs: agg, sources, worker, queueConfigured: !!this.queue,
        definitions: {
          attempts: 'Runs created in the window (scheduled, manual and retries); each retry attempt of one run counts once in retries',
          discovered: 'Items returned by connectors before validation', rejected: 'Items failing validation (no title, invalid link, …)',
          duplicates: 'New records flagged as duplicates of an earlier record from the same publisher', already_known: 'Items whose canonical URL was already stored',
          lag_seconds: 'Seconds since the last successful collection of the source',
        },
      };
    });
  }
}
