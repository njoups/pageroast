import { Inject, Injectable, Optional } from '@nestjs/common';
import { AnalysisEnqueuer } from '../analysis/analysis-queue';
import type { PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { ConnectorError, type FetchResult, type RawRecord } from './connectors/connector';
import { getConnector } from './connectors/registry';
import { contentHash, decideDuplicate, normalizeTitle, type DedupCandidate } from './dedup';
import { computeHealth } from './health';
import { logEvent } from './log';
import { compileQuery, MatchDocument, type CompiledQuery } from './query';
import type { SafeHttpClient } from './safe-http';
import type { CredentialCipher } from './secrets';
import { canonicalizeUrl, publisherDomain, redactUrl } from './url';
import { isSocialKind } from '../social/providers';
import { derivedAnalysisAllowed, type SourceRights } from '../social/rights';
import { budgetPeriodEnd, checkBudgets, pauseConnector, providerDay, quotaShortfall, quotaState, recordProviderUsage } from '../social/quota';

export const SAFE_HTTP = Symbol('SAFE_HTTP');
export const CREDENTIAL_CIPHER = Symbol('CREDENTIAL_CIPHER');

export type Trigger = 'schedule' | 'manual' | 'retry';
export interface CollectJob { tenantId: string; sourceId: string; trigger: Trigger; idempotencyKey: string; requestedBy?: string | null }

export interface RunCounts { seen: number; new: number; known: number; duplicate: number; rejected: number; matches: number }
export type RunOutcome =
  | { status: 'succeeded'; runId: string; counts: RunCounts; notModified: boolean; skippedForCache: boolean }
  | { status: 'already_succeeded' | 'skipped_disabled' | 'skipped_paused'; runId: string | null };

interface SourceRow {
  id: string; name: string; enabled: boolean; authorization_status: string; authorization_basis: string | null;
  feed_url: string | null; collection_method: string; permitted_fields: string[]; permits_full_text: boolean;
  refresh_interval_seconds: number; retention_days: number | null; license_terms: string | null;
  usage_restrictions: string | null; redistribution_restrictions: string | null; attribution_requirement: string | null;
  last_success_at: Date | null; consecutive_failures: number; verification_status: string;
  connector_id: string; kind: string; config: unknown; http_etag: string | null; http_last_modified: string | null;
  cache_valid_until: Date | null; ciphertext: string | null;
  rights: SourceRights; paused_until: Date | null; paused_reason: string | null; derived_analysis_approved_at: Date | null;
}

/** Days before the provider's refresh deadline at which a refresh is scheduled (leaves room for retries). */
const REFRESH_MARGIN_DAYS = 5;

const PIPELINE_STAGES = ['fetch', 'validate', 'normalize', 'deduplicate', 'match', 'persist', 'queue_analysis', 'search_index', 'alerts', 'metrics'] as const;

function normLanguage(l: string | null | undefined): string | null {
  if (!l) return null;
  const base = l.toLowerCase().trim().split(/[-_]/)[0] ?? '';
  if (base === 'in') return 'id'; // legacy ISO 639 code for Indonesian
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

/**
 * Fetch → Validate → Normalize → Deduplicate → Match → Persist → Queue analysis → Search index → Alerts → Metrics.
 * Everything that touches tenant data runs inside withTenant(), so RLS applies to the worker exactly as to the API.
 */
@Injectable()
export class IngestionPipeline {
  constructor(
    private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SAFE_HTTP) private readonly http: SafeHttpClient,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher | null,
    @Optional() private readonly analysis?: AnalysisEnqueuer,
  ) {}

  private loadSource(c: PoolClient, sourceId: string) {
    return c.query<SourceRow>(
      `SELECT s.*, k.id AS connector_id, k.kind, k.config, k.http_etag, k.http_last_modified, k.cache_valid_until, cc.ciphertext,
              k.rights, k.paused_until, k.paused_reason, k.derived_analysis_approved_at
       FROM sources s JOIN connectors k ON k.source_id = s.id LEFT JOIN connector_credentials cc ON cc.connector_id = k.id
       WHERE s.id = $1`, [sourceId]).then((r) => r.rows[0]);
  }

  /**
   * @param attempt 1-based attempt number; @param isFinalAttempt whether a failure now ends retries (decides
   * retrying vs dead_lettered). Throws ConnectorError on failure after recording it.
   */
  async run(job: CollectJob, attempt: number, isFinalAttempt: boolean): Promise<RunOutcome> {
    const started = Date.now();
    const sys = '00000000-0000-0000-0000-000000000000';
    const prep = await this.db.withTenant(job.tenantId, job.requestedBy ?? sys, async (c) => {
      const src = await this.loadSource(c, job.sourceId);
      if (!src) return { kind: 'missing' as const };
      if (job.trigger === 'schedule' && !src.enabled) return { kind: 'disabled' as const };
      // Paused social connectors (provider quota exhausted, budget limit) skip scheduled runs without recording a failure.
      if (job.trigger === 'schedule' && src.paused_until && src.paused_until.getTime() > Date.now()) return { kind: 'paused' as const };
      const r = await c.query<{ id: string }>(
        `INSERT INTO connector_runs (tenant_id, connector_id, source_id, idempotency_key, status, attempt, trigger, requested_by, started_at)
         VALUES ($1,$2,$3,$4,'running',$5,$6,$7, now())
         ON CONFLICT (tenant_id, connector_id, idempotency_key) DO UPDATE
           SET status = 'running', attempt = EXCLUDED.attempt, started_at = now(), error = NULL
           WHERE connector_runs.status <> 'succeeded'
         RETURNING id`,
        [job.tenantId, src.connector_id, src.id, job.idempotencyKey, attempt, job.trigger, job.requestedBy ?? null]);
      return r.rows[0] ? { kind: 'ok' as const, src, runId: r.rows[0].id } : { kind: 'done' as const };
    });
    if (prep.kind === 'missing') throw new ConnectorError('not_found', 'Source no longer exists');
    if (prep.kind === 'disabled') return { status: 'skipped_disabled', runId: null };
    if (prep.kind === 'paused') return { status: 'skipped_paused', runId: null };
    if (prep.kind === 'done') return { status: 'already_succeeded', runId: null };
    const { src, runId } = prep;
    const log = { tenantId: job.tenantId, sourceId: src.id, runId, attempt, trigger: job.trigger, kind: src.kind };

    let fetched: FetchResult;
    let skippedForCache = false;
    try {
      if (src.authorization_status !== 'authorized') throw new ConnectorError('unconfigured', 'Source is not authorized for collection');
      const connector = getConnector(src.kind);
      if (!connector) throw new ConnectorError('unconfigured', `Unknown connector kind "${src.kind}"`);
      const cfg = connector.validateConfig(src.config);
      let credentials: string | null = null;
      if (connector.requiresCredentials) {
        if (!src.ciphertext) throw new ConnectorError('unconfigured', 'Connector credentials are not configured');
        if (!this.cipher) throw new ConnectorError('unconfigured', 'Credential storage key (CREDENTIALS_KEY) is not configured on this worker');
        try { credentials = this.cipher.decrypt(src.ciphertext, src.connector_id); }
        catch { throw new ConnectorError('auth', 'Stored credentials could not be decrypted (key rotated?)'); }
      }
      if (isSocialKind(src.kind)) await this.socialPreflight(job, src, cfg);
      if (job.trigger === 'schedule' && src.cache_valid_until && src.cache_valid_until.getTime() > Date.now()) {
        skippedForCache = true;
        fetched = { status: 'not_modified', httpStatus: 0, records: [], rejected: [], cache: { etag: src.http_etag, lastModified: src.http_last_modified, validUntil: src.cache_valid_until }, meta: { title: null, language: null, format: 'cached' } };
      } else {
        fetched = await connector.fetch({ config: cfg, url: src.feed_url, http: this.http, cache: { etag: src.http_etag, lastModified: src.http_last_modified }, credentials });
      }
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError('network', (e as Error).message);
      await this.recordFailure(job, src, runId, err, isFinalAttempt, Date.now() - started);
      if (isSocialKind(src.kind)) await this.socialAfterFailure(job, src, err);
      logEvent(err.retryable && !isFinalAttempt ? 'warn' : 'error', 'ingestion.run_failed', { ...log, errorKind: err.kind, httpStatus: err.opts.httpStatus, message: err.message, final: isFinalAttempt || !err.retryable });
      throw err;
    }

    const { counts, newOriginals } = await this.persist(job, src, runId, fetched, Date.now() - started, skippedForCache);
    // Hand new originals to the AI pipeline after commit. An AI/queue problem never fails the collection run.
    // Social records go only where the provider's terms permit derived analysis (recorded approval where required).
    if (newOriginals.length && this.analysis?.available && derivedAnalysisAllowed(src)) {
      await this.analysis.enqueueMentions(job.tenantId, newOriginals, 'ingestion').catch((e) => logEvent('error', 'ingestion.analysis_enqueue_failed', { ...log, message: (e as Error).message }));
    }
    logEvent('info', 'ingestion.run_succeeded', { ...log, ...counts, notModified: fetched.status === 'not_modified', skippedForCache, durationMs: Date.now() - started });
    return { status: 'succeeded', runId, counts, notModified: fetched.status === 'not_modified', skippedForCache };
  }

  /**
   * Social gates before any provider request: an active pause (provider quota, hard budget; soft budget blocks
   * scheduled runs only), a hard or soft budget reached now, and whether today's remaining provider quota covers the
   * worst case of this sync. Throws ConnectorError('quota') — not retried — and pauses scheduled collection.
   */
  private async socialPreflight(job: CollectJob, src: SourceRow, cfg: unknown) {
    const connector = getConnector(src.kind)!;
    type Pause = Parameters<typeof pauseConnector>[1];
    // Decide in one transaction (budget notices are recorded and committed), then pause in another and throw:
    // throwing inside the first transaction would roll the notices and the pause back.
    const decision = await this.db.withTenant(job.tenantId, job.requestedBy ?? '00000000-0000-0000-0000-000000000000', async (c): Promise<{ err: ConnectorError; pause?: Pause } | null> => {
      const now = new Date();
      if (src.paused_until && src.paused_until > now && (src.paused_reason !== 'budget_soft_limit' || job.trigger === 'schedule')) {
        return { err: new ConnectorError('quota', `Collection is paused until ${src.paused_until.toISOString()} (${src.paused_reason ?? 'paused'})`, { resumeAt: src.paused_until }) };
      }
      const budget = await checkBudgets(c, { tenantId: job.tenantId, connectorId: src.connector_id, kind: src.kind, now });
      const hit = budget.items.find((i) => i.level === 'hard') ?? (job.trigger === 'schedule' ? budget.items.find((i) => i.level === 'soft') : undefined);
      if (hit) {
        const until = budgetPeriodEnd(src.kind, hit.period as 'day' | 'month', now);
        return { err: new ConnectorError('quota', `Budget ${hit.level} limit reached for ${hit.metric} (${hit.value} this ${hit.period}); collection paused until ${until.toISOString()}`, { resumeAt: until }),
          pause: { tenantId: job.tenantId, connectorId: src.connector_id, sourceId: src.id, until, reason: hit.level === 'hard' ? 'budget_hard_limit' : 'budget_soft_limit' } };
      }
      const need = connector.estimateSyncUsage?.(cfg) ?? {};
      const q = await quotaState(c, src.connector_id, src.kind, cfg, now);
      const short = quotaShortfall(q, need);
      if (short.length) {
        const until = q.resetsAt ? new Date(q.resetsAt) : budgetPeriodEnd(src.kind, 'day', now);
        const b = q.buckets.find((x) => x.key === short[0]!.bucket);
        return { err: new ConnectorError('quota', `Not enough provider quota left today for this sync (${short.map((x) => `${x.bucket}: needs up to ${x.need}, ${x.remaining} left`).join('; ')}); resumes after the quota resets`, { resumeAt: until }),
          pause: { tenantId: job.tenantId, connectorId: src.connector_id, sourceId: src.id, until, reason: 'provider_quota', metric: short[0]!.bucket, value: b?.used ?? 0, threshold: b?.limit ?? 0, periodKey: q.day } };
      }
      return null;
    });
    if (!decision) return;
    if (decision.pause) await this.db.withTenant(job.tenantId, job.requestedBy ?? '00000000-0000-0000-0000-000000000000', (c) => pauseConnector(c, decision.pause!));
    throw decision.err;
  }

  /** Records provider usage of a failed sync and pauses on provider quota exhaustion. */
  private async socialAfterFailure(job: CollectJob, src: SourceRow, err: ConnectorError) {
    await this.db.withTenant(job.tenantId, job.requestedBy ?? '00000000-0000-0000-0000-000000000000', async (c) => {
      if (err.opts.usage) await recordProviderUsage(c, { tenantId: job.tenantId, connectorId: src.connector_id, kind: src.kind, usage: err.opts.usage });
      if (err.kind === 'quota' && err.opts.resumeAt && err.opts.httpStatus) {   // reported by the provider (not our own gate)
        await pauseConnector(c, { tenantId: job.tenantId, connectorId: src.connector_id, sourceId: src.id, until: err.opts.resumeAt, reason: 'provider_quota', periodKey: providerDay(src.kind).day });
      }
    });
  }

  private async recordFailure(job: CollectJob, src: SourceRow, runId: string, err: ConnectorError, isFinal: boolean, durationMs: number) {
    const final = isFinal || !err.retryable;
    const status = !final ? 'retrying' : err.retryable ? 'dead_lettered' : 'failed';
    const failures = src.consecutive_failures + 1;
    const health = computeHealth({ enabled: src.enabled, lastAttemptAt: new Date(), lastSuccessAt: src.last_success_at, consecutiveFailures: failures, lastErrorKind: err.kind, refreshIntervalSeconds: src.refresh_interval_seconds });
    const errorJson = { kind: err.kind, message: err.message.slice(0, 500), httpStatus: err.opts.httpStatus ?? null, retryable: err.retryable };
    await this.db.withTenant(job.tenantId, job.requestedBy ?? '00000000-0000-0000-0000-000000000000', async (c) => {
      await c.query(
        `UPDATE connector_runs SET status = $2, error = $3, finished_at = now(), duration_ms = $4, http_status = $5, rate_limited = $6,
           stages = jsonb_build_object('fetch', 'failed') WHERE id = $1`,
        [runId, status, JSON.stringify(errorJson), durationMs, err.opts.httpStatus ?? null, err.kind === 'rate_limited']);
      await c.query(
        `UPDATE sources SET last_attempt_at = now(), consecutive_failures = $2, last_error = $3, health_status = $4 WHERE id = $1`,
        [src.id, failures, JSON.stringify({ ...errorJson, at: new Date().toISOString(), runId }), health]);
      if (err.kind === 'rate_limited') await this.recordUsage(c, job.tenantId, 'rate_limit_responses', 1, src.id);
      await this.recordUsage(c, job.tenantId, 'connector_requests', 1, src.id);
    });
  }

  private recordUsage(c: PoolClient, tenantId: string, metric: string, qty: number, sourceId: string) {
    return c.query(`INSERT INTO usage_records (tenant_id, metric, quantity, period_start, metadata) VALUES ($1,$2,$3,current_date,$4)`,
      [tenantId, metric, qty, JSON.stringify({ sourceId })]);
  }

  private async persist(job: CollectJob, src: SourceRow, runId: string, fetched: FetchResult, fetchMs: number, skippedForCache: boolean): Promise<{ counts: RunCounts; newOriginals: string[] }> {
    const permitted = new Set(src.permitted_fields);
    const social = isSocialKind(src.kind);
    const now = new Date();
    // Provider deadlines (e.g. YouTube: refresh or delete within 30 days of retrieval).
    const deleteBy = social && src.rights?.storageMaxDays ? new Date(now.getTime() + src.rights.storageMaxDays * 86_400_000) : null;
    const refreshDue = social && src.rights?.refreshWithinDays
      ? new Date(now.getTime() + Math.max(src.rights.refreshWithinDays - REFRESH_MARGIN_DAYS, 1) * 86_400_000) : null;
    const socialCols = (rec: RawRecord) => {
      const sf = rec.social!;
      const excerpt = permitted.has('excerpt') ? rec.summary : null;
      return {
        platform: sf.platform, contentType: sf.contentType, externalId: sf.externalId, parentExternalId: sf.parentExternalId,
        authorRef: permitted.has('author') ? sf.authorRef : null,
        // Hashtags only from text we are allowed to store; metrics only when the source permits storing them.
        hashtags: sf.hashtags.filter((h) => `${rec.title}\n${excerpt ?? ''}`.toLowerCase().includes(`#${h}`)),
        engagement: permitted.has('metrics') ? sf.engagement : {},
      };
    };
    const counts: RunCounts = { seen: fetched.records.length, new: 0, known: 0, duplicate: 0, rejected: fetched.rejected.length, matches: 0 };
    const rejections: Array<{ reason: string; index?: number; url?: string }> = fetched.rejected.slice(0, 20).map((r) => ({ ...r }));
    const stages: Record<string, string> = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 'pending']));
    stages.fetch = skippedForCache ? 'skipped:cache-control' : fetched.status === 'not_modified' ? 'not_modified' : 'ok';

    // Validate + normalise (pure, before opening the transaction).
    const seenCanonical = new Set<string>();
    const valid: Array<{ rec: RawRecord; canonical: string; domain: string; nTitle: string; excerpt: string | null; hash: string }> = [];
    fetched.records.forEach((rec, index) => {
      let canonical: string;
      try { canonical = canonicalizeUrl(rec.url); } catch { counts.rejected++; rejections.push({ index, reason: 'invalid_url' }); return; }
      if (!rec.title || rec.title.length > 1000) { counts.rejected++; rejections.push({ index, reason: 'invalid_title' }); return; }
      if (seenCanonical.has(canonical)) { counts.known++; return; } // repeated within the same feed
      seenCanonical.add(canonical);
      const excerpt = permitted.has('excerpt') ? rec.summary?.slice(0, 1000) ?? null : null;
      valid.push({ rec, canonical, domain: publisherDomain(canonical), nTitle: normalizeTitle(rec.title), excerpt, hash: contentHash(rec.title, excerpt) });
    });
    stages.validate = 'ok'; stages.normalize = 'ok';

    const sys = job.requestedBy ?? '00000000-0000-0000-0000-000000000000';
    const newOriginals: string[] = [];
    return this.db.withTenant(job.tenantId, sys, async (c) => {
      // Deduplicate: known canonical URLs first.
      const existing = valid.length
        ? (await c.query<{ id: string; canonical_url: string; source_id: string }>('SELECT id, canonical_url, source_id FROM mentions WHERE canonical_url = ANY($1::text[])', [valid.map((v) => v.canonical)])).rows
        : [];
      // A social record seen again is a refresh: current text and metrics replace the stored ones and the provider
      // deadlines restart (the record was just retrieved again).
      if (social && existing.length) {
        const byCanon = new Map(valid.map((v) => [v.canonical, v]));
        for (const e of existing) {
          const v = byCanon.get(e.canonical_url); if (!v?.rec.social) continue;
          const sc = socialCols(v.rec);
          await c.query(
            `UPDATE mentions SET title = $2, excerpt = $3, hashtags = $4, engagement = $5, engagement_observed_at = now(), last_verified_at = now(),
               refresh_due_at = $6, provider_delete_by = $7, normalized_title = $8, content_hash = $9 WHERE id = $1`,
            [e.id, v.rec.title, v.excerpt, sc.hashtags, JSON.stringify(sc.engagement), refreshDue, deleteBy, v.nTitle, v.hash]);
        }
      }
      const byUrl = new Map(existing.map((e) => [e.canonical_url, e]));
      const fresh = valid.filter((v) => !byUrl.has(v.canonical));
      counts.known += valid.length - fresh.length;
      if (existing.length) {
        await c.query('UPDATE mentions SET last_seen_at = now() WHERE id = ANY($1::uuid[])', [existing.map((e) => e.id)]);
        const otherSource = existing.filter((e) => e.source_id !== src.id).map((e) => e.id);
        if (otherSource.length) {
          await c.query(
            `UPDATE mentions SET provenance = jsonb_set(provenance, '{alsoSeenIn}', coalesce(provenance->'alsoSeenIn', '[]'::jsonb) || to_jsonb($2::text))
             WHERE id = ANY($1::uuid[]) AND NOT coalesce(provenance->'alsoSeenIn', '[]'::jsonb) ? $2`, [otherSource, src.id]);
        }
      }
      const candidates: DedupCandidate[] = fresh.length
        ? (await c.query<{ id: string; publisher_domain: string; normalized_title: string; content_hash: string }>(
            `SELECT id, publisher_domain, normalized_title, content_hash FROM mentions
             WHERE publisher_domain = ANY($1::text[]) AND duplicate_status = 'original' AND discovered_at > now() - interval '7 days'
             ORDER BY discovered_at DESC LIMIT 5000`, [[...new Set(fresh.map((f) => f.domain))]])).rows
            .map((r) => ({ id: r.id, publisherDomain: r.publisher_domain, normalizedTitle: r.normalized_title, contentHash: r.content_hash }))
        : [];
      stages.deduplicate = 'ok';

      // Matching: active queries of active projects in this tenant.
      const queries = (await c.query<{ id: string; project_id: string; keywords: string[]; aliases: string[]; exclusions: string[]; boolean_expression: string | null; languages: string[] }>(
        `SELECT q.id, q.project_id, q.keywords, q.aliases, q.exclusions, q.boolean_expression, q.languages
         FROM monitoring_queries q JOIN projects p ON p.id = q.project_id WHERE q.is_active AND p.status = 'active'`)).rows;
      const compiled: Array<{ id: string; projectId: string; q: CompiledQuery }> = [];
      for (const q of queries) {
        try { compiled.push({ id: q.id, projectId: q.project_id, q: compileQuery({ keywords: q.keywords, aliases: q.aliases, exclusions: q.exclusions, booleanExpression: q.boolean_expression, languages: q.languages }) }); }
        catch (e) { logEvent('warn', 'ingestion.query_skipped', { tenantId: job.tenantId, queryId: q.id, reason: (e as Error).message }); }
      }

      const provenanceBase = {
        connector: src.kind, connectorVersion: getConnector(src.kind)?.version ?? null, runId, sourceId: src.id,
        feedUrl: src.feed_url ? redactUrl(src.feed_url) : null, feedTitle: fetched.meta.title, feedFormat: fetched.meta.format,
        licence: {
          authorizationBasis: src.authorization_basis, licenseTerms: src.license_terms, usageRestrictions: src.usage_restrictions,
          redistributionRestrictions: src.redistribution_restrictions, attribution: src.attribution_requirement,
          retentionDays: src.retention_days, permitsFullText: src.permits_full_text, permittedFields: src.permitted_fields,
        },
      };

      for (const f of fresh) {
        // Social records are deduplicated by provider id only: different posts often share a title.
        const decision = social ? { status: 'original' as const, duplicateOf: null, reason: null }
          : decideDuplicate({ publisherDomain: f.domain, normalizedTitle: f.nTitle, contentHash: f.hash }, candidates,
            { similarityThreshold: this.config.ingestion.dedupSimilarity, minTokens: 5 });
        const sc = social && f.rec.social ? socialCols(f.rec) : null;
        const body = src.permits_full_text ? f.rec.content : null;
        const language = normLanguage(f.rec.language ?? fetched.meta.language);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO mentions (tenant_id, source_id, url, canonical_url, title, excerpt, body, content_hash, language, publisher,
             publisher_domain, normalized_title, published_at, author, categories, guid, source_type, duplicate_status, duplicate_of,
             duplicate_reason, retention_expires_at, license_ref, provenance, first_run_id, last_verified_at,
             platform, content_type, external_id, parent_external_id, author_ref, hashtags, engagement, engagement_observed_at,
             refresh_due_at, provider_delete_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             CASE WHEN $21::int IS NULL THEN NULL ELSE now() + make_interval(days => $21::int) END, $22, $23, $24, now(),
             $25, $26, $27, $28, $29, coalesce($30::text[], '{}'), coalesce($31::jsonb, '{}'::jsonb), CASE WHEN $25::text IS NULL THEN NULL ELSE now() END, $32, $33)
           ON CONFLICT DO NOTHING RETURNING id`,
          [job.tenantId, src.id, f.rec.url, f.canonical, f.rec.title, f.excerpt, body, f.hash, language,
            f.rec.publisher ?? fetched.meta.title ?? src.name, f.domain, f.nTitle,
            permitted.has('published_at') ? f.rec.publishedAt : null,
            permitted.has('author') ? f.rec.author : null, permitted.has('categories') ? f.rec.categories : [],
            f.rec.guid, src.collection_method, decision.status, decision.duplicateOf, decision.reason, src.retention_days,
            src.id, JSON.stringify({ ...provenanceBase, guid: f.rec.guid, publishedRaw: f.rec.publishedRaw, ...(f.rec.extra ?? {}) }), runId,
            sc?.platform ?? null, sc?.contentType ?? null, sc?.externalId ?? null, sc?.parentExternalId ?? null, sc?.authorRef ?? null,
            sc?.hashtags ?? null, sc ? JSON.stringify(sc.engagement) : null, sc ? refreshDue : null, sc ? deleteBy : null]);
        const id = ins.rows[0]?.id;
        if (!id) { counts.known++; continue; } // inserted concurrently by another source's run
        counts.new++;
        if (decision.status !== 'original') { counts.duplicate++; continue; } // duplicates are linked, not re-matched
        candidates.push({ id, publisherDomain: f.domain, normalizedTitle: f.nTitle, contentHash: f.hash });
        newOriginals.push(id);
        if (compiled.length) {
          const doc = new MatchDocument([f.rec.title, f.excerpt ?? '', body ?? '', ...(sc?.hashtags.map((h) => `#${h}`) ?? [])].join('\n'));
          for (const q of compiled) {
            const m = q.q.match(doc, language);
            if (!m.matched) continue;
            await c.query(
              `INSERT INTO mention_matches (tenant_id, mention_id, project_id, query_id, matched_terms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [job.tenantId, id, q.projectId, q.id, m.terms]);
            counts.matches++;
          }
        }
      }
      stages.match = compiled.length ? 'ok' : 'no_active_queries';
      stages.persist = 'ok';
      stages.queue_analysis = this.analysis?.available ? `queued_after_commit:${newOriginals.length}` : 'queue_unavailable';
      stages.search_index = 'ok:generated_column';             // mentions.search_tsv is maintained by PostgreSQL
      stages.alerts = 'after_analysis';   // issues are evaluated by the alerts worker once records are analysed

      const health = computeHealth({ enabled: src.enabled, lastAttemptAt: new Date(), lastSuccessAt: new Date(), consecutiveFailures: 0, lastErrorKind: null, refreshIntervalSeconds: src.refresh_interval_seconds });
      const verifiedNow = src.verification_status !== 'verified' && counts.seen > 0;
      await c.query(
        `UPDATE sources SET last_attempt_at = now(), last_success_at = now(), consecutive_failures = 0, last_error = NULL,
           health_status = $2, records_collected = records_collected + $3,
           verification_status = CASE WHEN $4 THEN 'verified' ELSE verification_status END WHERE id = $1`,
        [src.id, health, counts.new, verifiedNow]);
      await c.query(
        `UPDATE connectors SET http_etag = $2, http_last_modified = $3, cache_valid_until = $4,
           status = 'configured', verified_at = CASE WHEN $5 THEN now() ELSE verified_at END WHERE id = $1`,
        [src.connector_id, fetched.cache.etag, fetched.cache.lastModified, fetched.cache.validUntil, verifiedNow]);
      if (!skippedForCache) await this.recordUsage(c, job.tenantId, 'connector_requests', 1, src.id);
      if (social) await recordProviderUsage(c, { tenantId: job.tenantId, connectorId: src.connector_id, kind: src.kind, usage: fetched.usage, retrieved: fetched.records.length, rejected: fetched.rejected.length });
      // A successful sync ends an expired pause.
      if (social && src.paused_until && src.paused_until <= new Date()) await c.query('UPDATE connectors SET paused_until = NULL, paused_reason = NULL WHERE id = $1', [src.connector_id]);
      if (counts.new) await this.recordUsage(c, job.tenantId, 'records_collected', counts.new, src.id);
      stages.metrics = 'ok';
      await c.query(
        `UPDATE connector_runs SET status = 'succeeded', finished_at = now(), duration_ms = $2, http_status = $3, not_modified = $4,
           records_seen = $5, records_new = $6, records_known = $7, records_duplicate = $8, records_rejected = $9, matches = $10,
           stages = $11, rejections = $12, error = NULL WHERE id = $1`,
        [runId, fetchMs, fetched.httpStatus || null, fetched.status === 'not_modified', counts.seen, counts.new, counts.known,
          counts.duplicate, counts.rejected, counts.matches, JSON.stringify(stages), JSON.stringify(rejections.slice(0, 20))]);
      return { counts, newOriginals };
    });
  }

  /**
   * Re-evaluates one monitoring query over the tenant's most recent originals (bounded) after it is created or changed.
   * Runs in the caller's tenant transaction.
   */
  async rematchQuery(c: PoolClient, tenantId: string, queryId: string, limit = 5000): Promise<number> {
    const q = (await c.query<{ id: string; project_id: string; keywords: string[]; aliases: string[]; exclusions: string[]; boolean_expression: string | null; languages: string[]; is_active: boolean }>(
      'SELECT * FROM monitoring_queries WHERE id = $1', [queryId])).rows[0];
    await c.query('DELETE FROM mention_matches WHERE query_id = $1', [queryId]);
    if (!q || !q.is_active) return 0;
    const compiled = compileQuery({ keywords: q.keywords, aliases: q.aliases, exclusions: q.exclusions, booleanExpression: q.boolean_expression, languages: q.languages });
    const rows = (await c.query<{ id: string; title: string; excerpt: string | null; body: string | null; language: string | null }>(
      `SELECT id, title, excerpt, body, language FROM mentions WHERE duplicate_status = 'original' ORDER BY discovered_at DESC LIMIT $1`, [limit])).rows;
    let n = 0;
    for (const r of rows) {
      const m = compiled.match(new MatchDocument([r.title, r.excerpt ?? '', r.body ?? ''].join('\n')), r.language);
      if (!m.matched) continue;
      await c.query(`INSERT INTO mention_matches (tenant_id, mention_id, project_id, query_id, matched_terms) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, r.id, q.project_id, q.id, m.terms]);
      n++;
    }
    return n;
  }
}
