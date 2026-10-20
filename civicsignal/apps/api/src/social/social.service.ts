import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import { CounterStore } from '../common/rate-limit';
import type { AuthContext, RequestMeta, TenantContext } from '../common/request';
import { Database } from '../database/database.service';
import { ConnectorError } from '../ingestion/connectors/connector';
import { getConnector } from '../ingestion/connectors/registry';
import { computeHealth } from '../ingestion/health';
import { MentionsService, type MentionsQuery } from '../ingestion/mentions';
import { CREDENTIAL_CIPHER, SAFE_HTTP } from '../ingestion/pipeline.service';
import type { SafeHttpClient } from '../ingestion/safe-http';
import type { CredentialCipher } from '../ingestion/secrets';
import { SourcesService } from '../ingestion/sources.service';
import { getProvider, OPERATION_LABELS, PROVIDERS, providerForKind, SOCIAL_KINDS, type ProviderDescriptor } from './providers';
import { checkBudgets, estimateCost, quotaState, recordProviderUsage } from './quota';
import { derivedAnalysisAllowed } from './rights';
import { ApprovalSchema, BudgetSchema, CreateSocialConnectorSchema, UpdateSocialConnectorSchema } from './social.dto';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest('validation_failed', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
};

const COLS = `s.id, s.name, s.enabled, s.authorization_status, s.authorization_basis, s.permitted_fields, s.refresh_interval_seconds,
  s.retention_days, s.license_terms, s.usage_restrictions, s.redistribution_restrictions, s.attribution_requirement,
  s.last_success_at, s.last_attempt_at, s.last_error, s.records_collected, s.consecutive_failures, s.health_status, s.verification_status,
  s.created_at, s.updated_at,
  k.id AS connector_id, k.kind, k.config, k.status AS connector_status, k.verified_at, k.rights, k.paused_until, k.paused_reason,
  k.derived_analysis_approved_at, k.derived_analysis_reference, k.derived_analysis_approved_by,
  (cc.connector_id IS NOT NULL) AS has_credentials, cc.hint AS credentials_hint, cc.updated_at AS credentials_updated_at,
  sch.next_due_at, sch.active AS schedule_active`;
const FROM = `FROM sources s JOIN connectors k ON k.source_id = s.id LEFT JOIN connector_credentials cc ON cc.connector_id = k.id
  LEFT JOIN ingestion_schedule sch ON sch.source_id = s.id`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows of the fixed query above
type Row = Record<string, any>;

function publicDescriptor(d: ProviderDescriptor) {
  return {
    ...d,
    operationsDetail: (Object.keys(OPERATION_LABELS) as Array<keyof typeof OPERATION_LABELS>).map((op) => ({
      operation: op, label: OPERATION_LABELS[op], supported: d.operations.includes(op), reason: d.operations.includes(op) ? null : d.unsupported[op] ?? 'Not offered by this provider or connector',
    })),
  };
}

@Injectable()
export class SocialService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly sources: SourcesService,
    private readonly mentions: MentionsService,
    private readonly counters: CounterStore,
    @Inject(SAFE_HTTP) private readonly http: SafeHttpClient,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher | null,
  ) {}

  providers(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const counts = new Map((await c.query<{ kind: string; n: number }>(
        `SELECT k.kind, count(*)::int AS n FROM connectors k WHERE k.kind = ANY($1::text[]) GROUP BY 1`, [SOCIAL_KINDS])).rows.map((r) => [r.kind, r.n]));
      return {
        providers: PROVIDERS.map((p) => ({ ...publicDescriptor(p), connectors: p.kind ? counts.get(p.kind) ?? 0 : 0 })),
        definitions: {
          implementation: '"implemented" means a connector exists and passes contract tests against a simulated API; it does not mean it was verified live.',
          liveVerified: 'true only after a collection against the real provider with real credentials succeeded.',
          verifiedAt: 'Date the provider documentation cited in docs was read.',
        },
      };
    });
  }

  private async loadRow(c: PoolClient, id: string): Promise<Row> {
    const r = (await c.query<Row>(`SELECT ${COLS} ${FROM} WHERE s.id = $1 AND k.kind = ANY($2::text[])`, [id, SOCIAL_KINDS])).rows[0];
    if (!r) throw notFound('Social connector');
    return r;
  }

  private async present(c: PoolClient, r: Row) {
    const d = providerForKind(r.kind)!;
    const quota = await quotaState(c, r.connector_id, r.kind, r.config);
    const lifecycle = (await c.query('SELECT started_at, finished_at, checked, refreshed, removed_at_provider, expired, blocked_by_legal_hold, refresh_error FROM provider_lifecycle_runs WHERE connector_id = $1 ORDER BY started_at DESC LIMIT 1', [r.connector_id])).rows[0] ?? null;
    const records = (await c.query<{ n: number; due: number; overdue: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE refresh_due_at <= now())::int AS due, count(*) FILTER (WHERE provider_delete_by <= now())::int AS overdue
       FROM mentions WHERE source_id = $1`, [r.id])).rows[0]!;
    const notices = (await c.query(`SELECT id, level, metric, period_key, value, threshold, created_at FROM social_budget_events
      WHERE connector_id = $1 AND acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 10`, [r.connector_id])).rows;
    const paused = r.paused_until && new Date(r.paused_until) > new Date() ? { until: r.paused_until, reason: r.paused_reason } : null;
    return {
      id: r.id, name: r.name, provider: d.provider, providerName: d.displayName, kind: r.kind,
      enabled: r.enabled, authorizationStatus: r.authorization_status, authorizationBasis: r.authorization_basis,
      config: r.config, permittedFields: r.permitted_fields, refreshIntervalSeconds: r.refresh_interval_seconds, retentionDays: r.retention_days,
      credentials: { required: true, label: d.auth.credentialLabel, configured: r.has_credentials, hint: r.credentials_hint ?? null, updatedAt: r.credentials_updated_at ?? null },
      connectionStatus: r.connector_status, connectionVerifiedAt: r.verified_at,
      health: computeHealth({ enabled: r.enabled, lastAttemptAt: r.last_attempt_at, lastSuccessAt: r.last_success_at, consecutiveFailures: r.consecutive_failures, lastErrorKind: r.last_error?.kind ?? null, refreshIntervalSeconds: r.refresh_interval_seconds }),
      lastSuccessAt: r.last_success_at, lastAttemptAt: r.last_attempt_at, lastError: r.last_error, consecutiveFailures: r.consecutive_failures,
      recordsCollected: Number(r.records_collected), recordsStored: records.n, verificationStatus: r.verification_status,
      schedule: { active: r.schedule_active ?? false, nextDueAt: r.next_due_at ?? null },
      paused,
      quota,
      rights: {
        ...r.rights,
        derivedAnalysisAllowed: derivedAnalysisAllowed({ rights: r.rights, derived_analysis_approved_at: r.derived_analysis_approved_at }),
        approval: r.derived_analysis_approved_at ? { approvedAt: r.derived_analysis_approved_at, reference: r.derived_analysis_reference } : null,
        attribution: r.attribution_requirement, redistribution: r.redistribution_restrictions, licenseTerms: r.license_terms, usageRestrictions: r.usage_restrictions,
      },
      lifecycle: { lastRun: lifecycle, refreshDue: records.due, pastDeletionDeadline: records.overdue },
      notices,
      capabilities: publicDescriptor(d).operationsDetail,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  listConnectors(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const rows = (await c.query<Row>(`SELECT ${COLS} ${FROM} WHERE k.kind = ANY($1::text[]) ORDER BY s.name`, [SOCIAL_KINDS])).rows;
      const out = [];
      for (const r of rows) out.push(await this.present(c, r));
      return { connectors: out };
    });
  }

  getConnector(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => this.present(c, await this.loadRow(c, id)));
  }

  private validateConfig(kind: string, cfg: unknown) {
    try { return getConnector(kind)!.validateConfig(cfg); }
    catch (e) { throw badRequest('validation_failed', e instanceof ConnectorError ? e.message : 'Invalid connector configuration'); }
  }

  createConnector(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(CreateSocialConnectorSchema, body);
    const d = getProvider(dto.provider);
    if (!d) throw badRequest('unknown_provider', `Unknown provider "${dto.provider}"`);
    if (d.implementation !== 'implemented' || !d.kind) {
      throw conflict('provider_not_available', `${d.displayName} has no connector in this release (${d.access}). See the provider capability matrix.`);
    }
    const config = this.validateConfig(d.kind, dto.config);
    if (dto.authorizationStatus === 'authorized' && !dto.authorizationBasis?.trim()) {
      throw badRequest('authorization_basis_required', 'Record the basis (API terms accepted, contract, account owner consent) before marking the connector authorized');
    }
    const max = d.rights.storageMaxDays;
    if (max && dto.retentionDays && dto.retentionDays > max) throw badRequest('retention_exceeds_provider_limit', `${d.displayName} allows storing records for at most ${max} days`);
    const refresh = dto.refreshIntervalSeconds ?? Math.max(d.limits.minRefreshIntervalSeconds, 3600);
    if (refresh < d.limits.minRefreshIntervalSeconds) throw badRequest('validation_failed', `refreshIntervalSeconds must be at least ${d.limits.minRefreshIntervalSeconds} for ${d.displayName}`);
    const permitted = dto.permittedFields ?? ['title', 'url', 'published_at', 'excerpt', 'metrics'];
    const rights = { storageMaxDays: d.rights.storageMaxDays, refreshWithinDays: d.rights.refreshWithinDays, deletionOnRequestDays: d.rights.deletionOnRequestDays,
      derivedAnalysis: d.rights.derivedAnalysis, metricAggregation: d.rights.metricAggregation, provider: d.provider, verifiedAt: d.verifiedAt };
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const s = await c.query<{ id: string }>(
        `INSERT INTO sources (tenant_id, name, domain, category, collection_method, feed_url, enabled, authorization_status, authorization_basis,
           permitted_fields, permits_full_text, refresh_interval_seconds, license_terms, usage_restrictions, redistribution_restrictions,
           retention_days, attribution_requirement, created_by)
         VALUES ($1,$2,$3,'social','social_api',NULL,false,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [t.orgId, dto.name, d.provider === 'youtube' ? 'youtube.com' : d.provider, dto.authorizationStatus, dto.authorizationBasis ?? null, permitted, refresh,
          `${d.displayName}: ${d.rights.commercialUse}`, d.rights.derivedAnalysisNote, d.rights.redistribution, dto.retentionDays ?? max ?? null, d.rights.attribution, auth.userId]);
      const id = s.rows[0]!.id;
      await c.query(`INSERT INTO connectors (tenant_id, source_id, kind, config, status, rights) VALUES ($1,$2,$3,$4,'unconfigured',$5)`,
        [t.orgId, id, d.kind, JSON.stringify(config), JSON.stringify(rights)]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'social.connector_created', targetType: 'source', targetId: id,
        metadata: { provider: d.provider, mode: (config as { mode?: string }).mode ?? null, authorizationStatus: dto.authorizationStatus }, meta });
      return this.present(c, await this.loadRow(c, id));
    });
  }

  updateConnector(auth: AuthContext, t: TenantContext, id: string, body: unknown, meta: RequestMeta) {
    const dto = parse(UpdateSocialConnectorSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const cur = await this.loadRow(c, id);
      const d = providerForKind(cur.kind)!;
      const config = dto.config !== undefined ? this.validateConfig(cur.kind, dto.config) : cur.config;
      const authorizationStatus = dto.authorizationStatus ?? cur.authorization_status;
      const basis = dto.authorizationBasis !== undefined ? dto.authorizationBasis : cur.authorization_basis;
      if (authorizationStatus === 'authorized' && !basis?.trim()) throw badRequest('authorization_basis_required', 'Record the authorization basis before marking the connector authorized');
      const max = d.rights.storageMaxDays;
      if (max && dto.retentionDays && dto.retentionDays > max) throw badRequest('retention_exceeds_provider_limit', `${d.displayName} allows storing records for at most ${max} days`);
      if (dto.refreshIntervalSeconds !== undefined && dto.refreshIntervalSeconds < d.limits.minRefreshIntervalSeconds) {
        throw badRequest('validation_failed', `refreshIntervalSeconds must be at least ${d.limits.minRefreshIntervalSeconds} for ${d.displayName}`);
      }
      const enabled = authorizationStatus === 'authorized' ? cur.enabled : false;     // leaving 'authorized' stops collection
      await c.query(`UPDATE sources SET name = coalesce($2, name), authorization_status = $3, authorization_basis = $4, enabled = $5,
          permitted_fields = coalesce($6, permitted_fields), refresh_interval_seconds = coalesce($7, refresh_interval_seconds), retention_days = coalesce($8, retention_days)
        WHERE id = $1`, [id, dto.name ?? null, authorizationStatus, basis, enabled, dto.permittedFields ?? null, dto.refreshIntervalSeconds ?? null, dto.retentionDays ?? null]);
      if (dto.config !== undefined) {
        await c.query(`UPDATE connectors SET config = $2, verified_at = NULL WHERE id = $1`, [cur.connector_id, JSON.stringify(config)]);
        await c.query(`UPDATE sources SET verification_status = 'unverified' WHERE id = $1`, [id]);
      }
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'social.connector_updated', targetType: 'source', targetId: id,
        metadata: { fields: Object.keys(dto), ...(dto.authorizationStatus && dto.authorizationStatus !== cur.authorization_status ? { authorization: { from: cur.authorization_status, to: dto.authorizationStatus } } : {}) }, meta });
      return this.present(c, await this.loadRow(c, id));
    });
  }

  private async ensureSocial(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, (c) => this.loadRow(c, id));
  }

  async setCredentials(auth: AuthContext, t: TenantContext, id: string, secret: string | null, meta: RequestMeta) {
    const row = await this.ensureSocial(auth, t, id);
    await this.sources.setCredentials(auth, t, id, secret, meta);
    // New credentials invalidate the earlier connection check.
    await this.db.withTenant(t.orgId, auth.userId, (c) => c.query('UPDATE connectors SET verified_at = NULL WHERE id = $1', [row.connector_id]));
  }

  async setEnabled(auth: AuthContext, t: TenantContext, id: string, enabled: boolean, meta: RequestMeta) {
    await this.ensureSocial(auth, t, id);
    await this.sources.setEnabled(auth, t, id, enabled, meta);
    return this.getConnector(auth, t, id);
  }

  /**
   * Makes the provider's cheapest authorized call with the stored credentials (YouTube: videos.list, 1 unit) and
   * records the result and the quota used. Limited to 5 tests per connector per 10 minutes.
   */
  async test(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    const lim = await this.counters.hit(`social:test:${id}`, 600_000);
    if (lim.count > 5) throw new AppError(429, 'rate_limited', 'Connection tests are limited to 5 per connector every 10 minutes');
    const row: Row = await this.db.withTenant(t.orgId, auth.userId, async (c): Promise<Row> => {
      const r = await this.loadRow(c, id);
      const ct = (await c.query<{ ciphertext: string }>('SELECT ciphertext FROM connector_credentials WHERE connector_id = $1', [r.connector_id])).rows[0];
      return { ...r, ciphertext: ct?.ciphertext ?? null };
    });
    const connector = getConnector(row.kind)!;
    let result: { ok: true; detail: string } | { ok: false; error: { kind: string; message: string } };
    let usage;
    try {
      if (!row.ciphertext) throw new ConnectorError('unconfigured', `No ${providerForKind(row.kind)!.auth.credentialLabel ?? 'credential'} is configured`);
      if (!this.cipher) throw new ConnectorError('unconfigured', 'Credential storage key (CREDENTIALS_KEY) is not configured on this server');
      let credentials: string;
      try { credentials = this.cipher.decrypt(row.ciphertext, row.connector_id); } catch { throw new ConnectorError('auth', 'Stored credentials could not be decrypted (key rotated?)'); }
      const cfg = this.validateConfig(row.kind, row.config);
      const r = await connector.testConnection!({ config: cfg, url: null, http: this.http, cache: { etag: null, lastModified: null }, credentials });
      usage = r.usage; result = { ok: true, detail: r.detail };
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError('network', 'The connection test failed');
      usage = err.opts.usage; result = { ok: false, error: { kind: err.kind, message: err.message } };
    }
    await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      if (usage) await recordProviderUsage(c, { tenantId: t.orgId, connectorId: row.connector_id, kind: row.kind, usage });
      await c.query(`UPDATE connectors SET status = $2, verified_at = CASE WHEN $3 THEN now() ELSE verified_at END WHERE id = $1`,
        [row.connector_id, result.ok ? 'configured' : row.has_credentials ? 'failing' : 'unconfigured', result.ok]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'social.connection_tested', targetType: 'source', targetId: id,
        outcome: result.ok ? 'success' : 'failure', metadata: result.ok ? {} : { errorKind: result.error.kind }, meta });
    });
    return { ...result, testedAt: new Date().toISOString() };
  }

  async sync(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    const row = await this.ensureSocial(auth, t, id);
    if (row.paused_until && new Date(row.paused_until) > new Date() && row.paused_reason !== 'budget_soft_limit') {
      throw conflict('connector_paused', `Collection is paused until ${new Date(row.paused_until).toISOString()} (${row.paused_reason})`);
    }
    if (!row.has_credentials) throw conflict('connector_unconfigured', 'Configure the connector credentials before syncing');
    return this.sources.collectNow(auth, t, id, meta);
  }

  health(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await this.loadRow(c, id);
      const runs = (await c.query(`SELECT id, status, trigger, attempt, records_seen, records_new, records_known, records_rejected, matches, http_status,
          rate_limited, duration_ms, error, created_at, finished_at FROM connector_runs WHERE source_id = $1 ORDER BY created_at DESC LIMIT 20`, [id])).rows;
      const lifecycle = (await c.query(`SELECT * FROM provider_lifecycle_runs WHERE connector_id = $1 ORDER BY started_at DESC LIMIT 10`, [r.connector_id])).rows;
      return { connector: await this.present(c, r), runs, lifecycle };
    });
  }

  usage(auth: AuthContext, t: TenantContext, id: string, days: number) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await this.loadRow(c, id);
      const d = providerForKind(r.kind)!;
      const rows = (await c.query<{ day: Date; bucket: string; requests: number; units: string; records_retrieved: number; records_rejected: number; rate_limited: number }>(
        `SELECT day, bucket, requests, units, records_retrieved, records_rejected, rate_limited FROM provider_usage
         WHERE connector_id = $1 AND day > current_date - $2::int ORDER BY day DESC, bucket`, [r.connector_id, days])).rows;
      const totals = rows.reduce((a, x) => ({ requests: a.requests + x.requests, units: a.units + Number(x.units), recordsRetrieved: a.recordsRetrieved + x.records_retrieved,
        recordsRejected: a.recordsRejected + x.records_rejected, rateLimited: a.rateLimited + x.rate_limited }), { requests: 0, units: 0, recordsRetrieved: 0, recordsRejected: 0, rateLimited: 0 });
      const storage = (await c.query<{ n: number; bytes: string }>(
        `SELECT count(*)::int AS n, coalesce(sum(pg_column_size(m.*)),0) AS bytes FROM mentions m WHERE m.source_id = $1`, [id])).rows[0]!;
      const processing = (await c.query<{ n: number; tokens: string }>(
        `SELECT count(*)::int AS n, coalesce(sum(coalesce(a.tokens_in,0) + coalesce(a.tokens_out,0)),0) AS tokens FROM mention_analyses a JOIN mentions m ON m.id = a.mention_id
         WHERE m.source_id = $1 AND a.status IN ('succeeded','partial') AND a.finished_at > now() - make_interval(days => $2)`, [id, days])).rows[0]!;
      return {
        windowDays: days, provider: d.provider, quotaModel: d.pricing.model,
        days: rows.map((x) => ({ day: x.day.toISOString().slice(0, 10), bucket: x.bucket, requests: x.requests, units: Number(x.units), recordsRetrieved: x.records_retrieved, recordsRejected: x.records_rejected, rateLimited: x.rate_limited })),
        totals,
        quotaToday: await quotaState(c, r.connector_id, r.kind, r.config),
        storage: { records: storage.n, approxBytes: Number(storage.bytes) },
        processing: { analyses: processing.n, tokens: Number(processing.tokens) },
        cost: await estimateCost(c, d.provider, { requests: totals.requests, recordsRetrieved: totals.recordsRetrieved }),
        definitions: {
          day: `Provider quota day${d.quota.resetTimeZone ? ` (${d.quota.resetTimeZone})` : ' (UTC)'}`,
          units: 'Quota units charged by the provider for the calls this connector made, per bucket',
          recordsRetrieved: 'Items returned by the provider before validation and deduplication',
          approxBytes: 'Approximate stored size of this connector’s records (PostgreSQL row size, excluding indexes)',
          cost: 'Only from configured pricing rows with a verification date; "not_priced" means no figure can be given',
        },
      };
    });
  }

  setApproval(auth: AuthContext, t: TenantContext, id: string, body: unknown, meta: RequestMeta) {
    const dto = parse(ApprovalSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await this.loadRow(c, id);
      if (r.rights?.derivedAnalysis !== 'requires_approval') throw conflict('approval_not_applicable', 'This provider does not use a derived-analysis approval');
      await c.query(`UPDATE connectors SET derived_analysis_approved_at = $2, derived_analysis_approved_by = $3, derived_analysis_reference = $4 WHERE id = $1`,
        [r.connector_id, dto.approved ? new Date() : null, dto.approved ? auth.userId : null, dto.approved ? dto.reference : null]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: dto.approved ? 'social.derived_analysis_approved' : 'social.derived_analysis_revoked',
        targetType: 'source', targetId: id, metadata: { reference: dto.reference ?? null, note: dto.note ?? null }, meta });
      return this.present(c, await this.loadRow(c, id));
    });
  }

  // ── Budgets ──────────────────────────────────────────────────────────────────────────────────────

  budgets(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const budgets = (await c.query(`SELECT id, connector_id, metric, period, warn_at, soft_limit, hard_limit, updated_at FROM social_budgets ORDER BY metric, period`)).rows;
      const events = (await c.query(`SELECT id, connector_id, budget_id, level, metric, period_key, value, threshold, created_at, acknowledged_at FROM social_budget_events ORDER BY created_at DESC LIMIT 50`)).rows;
      const states = [];
      for (const k of (await c.query<{ id: string; kind: string; source_id: string }>(`SELECT id, kind, source_id FROM connectors WHERE kind = ANY($1::text[])`, [SOCIAL_KINDS])).rows) {
        states.push({ connectorId: k.id, sourceId: k.source_id, ...(await checkBudgets(c, { tenantId: t.orgId, connectorId: k.id, kind: k.kind })) });
      }
      return { budgets, events, states, levels: { warn: 'notice only', soft: 'scheduled syncs pause; manual syncs still run', hard: 'all syncs stop until the period resets' } };
    });
  }

  putBudget(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(BudgetSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      if (dto.connectorId) {
        const k = (await c.query(`SELECT 1 FROM connectors WHERE id = $1 AND kind = ANY($2::text[])`, [dto.connectorId, SOCIAL_KINDS])).rows[0];
        if (!k) throw notFound('Social connector');
      }
      const r = (await c.query(
        `INSERT INTO social_budgets (tenant_id, connector_id, metric, period, warn_at, soft_limit, hard_limit, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, coalesce(connector_id, '00000000-0000-0000-0000-000000000000'::uuid), metric, period)
         DO UPDATE SET warn_at = EXCLUDED.warn_at, soft_limit = EXCLUDED.soft_limit, hard_limit = EXCLUDED.hard_limit, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING id, connector_id, metric, period, warn_at, soft_limit, hard_limit`,
        [t.orgId, dto.connectorId, dto.metric, dto.period, dto.warnAt, dto.softLimit, dto.hardLimit, auth.userId])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'social.budget_set', targetType: 'social_budget', targetId: r.id, metadata: dto, meta });
      return r;
    });
  }

  deleteBudget(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('DELETE FROM social_budgets WHERE id = $1 RETURNING id', [id]);
      if (!r.rowCount) throw notFound('Budget');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'social.budget_removed', targetType: 'social_budget', targetId: id, meta });
    });
  }

  acknowledgeNotice(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('UPDATE social_budget_events SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL RETURNING id', [id, auth.userId]);
      if (!r.rowCount) throw notFound('Notice');
      return { id, acknowledged: true };
    });
  }

  /** Social records only, with the same project visibility rules as mention search. */
  socialMentions(auth: AuthContext, t: TenantContext, q: MentionsQuery) {
    return this.mentions.search(auth, t, { ...q, channel: 'social' });
  }
}
