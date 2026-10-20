import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CLOCK, type Clock } from '../alerts/clock';
import { EmailChannel } from '../alerts/channels/email';
import { DeliveryError } from '../alerts/channels/errors';
import { ANALYSIS_PROVIDER } from '../analysis/providers';
import type { AnalysisProvider } from '../analysis/providers/provider';
import { sanitizeMultiSummary } from '../analysis/schemas';
import { quotaState, recordAiUsage } from '../analysis/usage';
import * as E from '../analytics/engine';
import { note, noteText, texts } from '../analytics/notes';
import { AuditService } from '../audit/audit.service';
import { hasPermission, seesAllProjects, type Role } from '../authz/permissions';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { validateCommentary, type CommentaryClaim } from './claims';
import { ARTICLE_COLUMNS, excerptAllowed, safeFilename, toCsv, type Cell } from './csv';
import { renderPdf } from './pdf';
import { ReportParamsSchema, type ReportParams, type TemplateKey } from './report-config';
import { buildModel, checkConsistency, metricRegistry, TEMPLATE_VERSION, type Article, type ReportData, type ReportModel } from './templates';

export const SYS = '00000000-0000-0000-0000-000000000000';

/** A failure that retrying cannot fix (invalid definition, consistency or reference check failed). */
export class ReportFailure extends Error { constructor(message: string, readonly retryable = false) { super(message); } }
class Cancelled extends Error {}

interface RunRow {
  id: string; tenant_id: string; definition_id: string; schedule_id: string | null; status: string; period_start: Date; period_end: Date; timezone: string;
  trigger: string; requested_by: string | null; attempts: number; heartbeat_at: Date | null;
  template: TemplateKey; name: string; project_id: string; project_name: string; language: 'id' | 'en'; ai_commentary: boolean; params: unknown;
  def_created_by: string | null; def_updated_at: Date; org_name: string; brand: string | null;
}

/**
 * Report generation, following the evidence workflow (docs/REPORT_TEMPLATES.md):
 *  1 resolve scope → 2 retrieve records → 3 deterministic metrics → 4 select supporting articles → 5 optional AI
 *  commentary from that evidence → 6 validate references → 7 validate metric consistency → 8 render PDF/CSV →
 *  9 record status, cited sources, artifacts, deliveries and audit.
 * Metrics never come from the language model. A run that fails validation fails visibly; it is never rendered partially.
 */
@Injectable()
export class ReportGenerator {
  readonly email: EmailChannel;
  constructor(private readonly db: Database, private readonly audit: AuditService, @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock, @Inject(ANALYSIS_PROVIDER) private readonly provider: AnalysisProvider) {
    this.email = new EmailChannel(config.email);
  }
  private emailOverride: EmailChannel | null = null;
  overrideEmail(e: EmailChannel) { this.emailOverride = e; }
  private get mailer() { return this.emailOverride ?? this.email; }

  private tx<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) { return this.db.withTenant(tenantId, SYS, fn); }

  private async heartbeat(tenantId: string, runId: string) {
    const r = await this.tx(tenantId, async (c) => (await c.query<{ status: string }>(`UPDATE report_runs SET heartbeat_at = $2 WHERE id = $1 RETURNING status`, [runId, this.clock.now()])).rows[0]);
    if (!r || r.status === 'cancelled') throw new Cancelled('cancelled');
  }

  /** Generates one run. Returns the final status; throws only for retryable failures (the queue retries them). */
  async generate(tenantId: string, runId: string, final: boolean): Promise<{ status: string; error?: string }> {
    const run = await this.tx(tenantId, async (c) => {
      const r = (await c.query<RunRow>(`SELECT r.*, d.template, d.name, d.project_id, p.name AS project_name, d.language, d.ai_commentary, d.params, d.created_by AS def_created_by,
          d.updated_at AS def_updated_at, t.name AS org_name, t.settings->>'brandColor' AS brand
        FROM report_runs r JOIN report_definitions d ON d.id = r.definition_id JOIN projects p ON p.id = d.project_id JOIN tenants t ON t.id = r.tenant_id
        WHERE r.id = $1 FOR UPDATE OF r`, [runId])).rows[0];
      if (!r || r.status === 'cancelled' || r.status === 'succeeded' || r.status === 'failed') return null;
      // Another attempt is live (fresh heartbeat): never run the same report twice concurrently.
      if (r.status === 'running' && r.heartbeat_at && this.clock.now().getTime() - new Date(r.heartbeat_at).getTime() < this.config.reports.staleRunMinutes * 60_000) return null;
      await c.query(`UPDATE report_runs SET status = 'running', started_at = coalesce(started_at, $2), heartbeat_at = $2, attempts = attempts + 1, error = NULL WHERE id = $1`, [runId, this.clock.now()]);
      return r;
    });
    if (!run) return { status: 'skipped' };
    try {
      const out = await this.build(run);
      return { status: 'succeeded', ...out };
    } catch (e) {
      if (e instanceof Cancelled) return { status: 'cancelled' };
      const retryable = !(e instanceof ReportFailure) || e.retryable;
      const message = (e as Error).message.slice(0, 500);
      if (retryable && !final) {
        await this.tx(tenantId, (c) => c.query(`UPDATE report_runs SET status = 'queued', error = $2 WHERE id = $1 AND status = 'running'`, [runId, `retrying: ${message}`]));
        throw e;
      }
      await this.fail(run, message);
      return { status: 'failed', error: message };
    }
  }

  async fail(run: Pick<RunRow, 'id' | 'tenant_id' | 'schedule_id' | 'requested_by' | 'def_created_by'>, message: string) {
    const recipients = [...new Set([run.requested_by, run.def_created_by].filter((x): x is string => !!x))];
    await this.tx(run.tenant_id, async (c) => {
      const u = await c.query(`UPDATE report_runs SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1 AND status IN ('queued','running') RETURNING id`, [run.id, message, this.clock.now()]);
      if (!u.rowCount) return;
      if (run.schedule_id) await c.query('UPDATE report_schedules SET consecutive_failures = consecutive_failures + 1 WHERE id = $1', [run.schedule_id]);
      for (const uid of recipients) {
        await c.query(`INSERT INTO report_deliveries (tenant_id, run_id, user_id, channel, kind, status, sent_at) VALUES ($1,$2,$3,'in_app','failed','delivered',$4) ON CONFLICT DO NOTHING`,
          [run.tenant_id, run.id, uid, this.clock.now()]);
      }
      await this.audit.record(c, { tenantId: run.tenant_id, actorUserId: null, action: 'report.failed', targetType: 'report_run', targetId: run.id, metadata: { error: message.slice(0, 200) } });
    });
    logEvent('warn', 'reports.run_failed', { tenantId: run.tenant_id, runId: run.id, error: message.slice(0, 200) });
  }

  private async build(run: RunRow) {
    const parsed = ReportParamsSchema.safeParse(run.params ?? {});
    if (!parsed.success) throw new ReportFailure(`Invalid report parameters: ${parsed.error.issues[0]?.message}`);
    const params = parsed.data;
    const now = this.clock.now();
    const o: E.EngineOptions = { now, maxPeriodDays: this.config.analytics.maxPeriodDays, cacheTtlSeconds: this.config.analytics.cacheTtlSeconds, staleHours: this.config.alerts.collectionStaleHours };
    const span = (run.period_end.getTime() - run.period_start.getTime()) / 86_400_000;
    if (span > Math.min(this.config.analytics.maxPeriodDays, 366)) throw new ReportFailure('Report period exceeds the maximum');

    // 1. Scope: the definition's project, the run's period and time zone. Access is enforced when the report is read.
    const scope: E.Scope = {
      viewer: { tenantId: run.tenant_id, userId: SYS, role: 'owner' }, projects: [run.project_id], from: run.period_start, to: run.period_end, tz: run.timezone,
      granularity: span > 35 ? 'week' : 'day',
      q: { projectId: run.project_id, topic: params.topic ?? undefined, sourceId: params.sourceId ?? undefined, language: params.language ?? undefined,
        entityIds: params.entityIds.length ? params.entityIds : undefined, issueStatus: 'all', limit: 25 },
    };
    // 2–3. Deterministic metrics (one transaction, so they describe the same snapshot).
    const { data, freshness } = await this.tx(run.tenant_id, async (c) => {
      const data: ReportData = {
        coverage: await E.coverage(c, scope), sentiment: await E.sentiment(c, scope), sov: await E.shareOfVoiceMetric(c, scope),
        topics: await E.topics(c, scope), entities: await E.entities(c, scope), sources: await E.sources(c, { ...scope, q: { ...scope.q, limit: 100 } }),
        issues: await E.issues(c, scope, 15), focusIssue: null, notable: [], negative: [], policy: [],
      };
      // 4. Supporting records, chosen by deterministic rules.
      data.notable = await this.notable(c, scope, params.maxSources);
      data.negative = run.template === 'daily_briefing' ? [] : await this.negative(c, scope, Math.min(5, params.maxSources));
      if (run.template === 'issue_report') data.focusIssue = await this.focusIssue(c, run, params, scope);
      if (run.template === 'policy_monitoring') {
        for (const e of data.sov.entities) data.policy.push({ entity: e, articles: await this.entityArticles(c, scope, e.id, Math.min(5, params.maxSources)) });
      }
      return { data, freshness: await E.freshness(c, scope, o) };
    });
    await this.heartbeat(run.tenant_id, run.id);

    // 7 (first, cheap): consistency of independently computed metrics.
    const inconsistent = checkConsistency(data);
    if (inconsistent.length) throw new ReportFailure(`Metric consistency check failed: ${inconsistent.join('; ')}`);

    // 5. Optional AI commentary from the selected evidence only.
    const ai = await this.commentary(run, data);
    await this.heartbeat(run.tenant_id, run.id);

    const analystNote = params.analystNote ? { text: params.analystNote, author: await this.userName(run.tenant_id, run.def_created_by), at: run.def_updated_at.toISOString() } : null;
    const { model, cited } = buildModel({
      template: run.template, language: run.language, organization: run.org_name, project: run.project_name, brandColor: run.brand ?? '#2a78d6',
      generatedAt: now, from: run.period_start, to: run.period_end, timezone: run.timezone, name: run.name, analystNote,
    }, data, { claims: ai.claims, ai: ai.info });
    model.limitations.push(...texts(freshness.noteKeys, run.language));

    // 6. Reference validation: every cited record exists, belongs to this tenant and project, and every model ref resolves.
    await this.validateReferences(run, model, cited);

    // 8. Render.
    const pdf = await renderPdf(model);
    let csv: { data: Buffer; rows: number; total: number } | null = null;
    if (params.includeCsv) csv = await this.csv(run, scope, cited);
    if (csv && csv.total > csv.rows) model.limitations.push(noteText(note('csv_truncated', { rows: csv.rows, total: csv.total }), run.language));
    await this.heartbeat(run.tenant_id, run.id);

    // 9. Persist atomically.
    const base = `${run.name}-${run.period_start.toISOString().slice(0, 10)}`;
    const expires = new Date(now.getTime() + this.config.reports.artifactTtlDays * 86_400_000);
    const deliveries = await this.tx(run.tenant_id, async (c) => {
      const st = (await c.query<{ status: string }>('SELECT status FROM report_runs WHERE id = $1 FOR UPDATE', [run.id])).rows[0];
      if (!st || st.status !== 'running') throw new Cancelled('cancelled');
      const files: Array<{ format: 'pdf' | 'csv'; data: Buffer; type: string; rows: number | null }> = [{ format: 'pdf', data: pdf, type: 'application/pdf', rows: null }];
      if (csv) files.push({ format: 'csv', data: csv.data, type: 'text/csv; charset=utf-8', rows: csv.rows });
      for (const f of files) {
        await c.query(`INSERT INTO report_artifacts (tenant_id, run_id, format, filename, content_type, size_bytes, sha256, data, row_count, created_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (run_id, format) DO UPDATE SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256,
            row_count = EXCLUDED.row_count, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, expired_at = NULL`,
          [run.tenant_id, run.id, f.format, safeFilename(base, f.format), f.type, f.data.length, createHash('sha256').update(f.data).digest('hex'), f.data, f.rows, now, expires]);
      }
      for (const [id, sections] of cited) for (const s of sections) {
        await c.query(`INSERT INTO report_run_sources (tenant_id, run_id, mention_id, section) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [run.tenant_id, run.id, id, s]);
      }
      await c.query(`UPDATE report_runs SET status = 'succeeded', finished_at = $2, model = $3, metrics = $4, freshness = $5, limitations = $6, ai_method = $7,
          ai_tokens_in = $8, ai_tokens_out = $9, template_version = $10, error = NULL WHERE id = $1`,
        [run.id, now, JSON.stringify(model), JSON.stringify(model.metrics), JSON.stringify(freshness), model.limitations, ai.info.method, ai.tokensIn, ai.tokensOut, TEMPLATE_VERSION]);
      if (run.schedule_id) await c.query('UPDATE report_schedules SET consecutive_failures = 0 WHERE id = $1', [run.schedule_id]);
      const out = await this.createDeliveries(c, run);
      await this.audit.record(c, { tenantId: run.tenant_id, actorUserId: null, action: 'report.generated', targetType: 'report_run', targetId: run.id,
        metadata: { template: run.template, trigger: run.trigger, pdfBytes: pdf.length, csvRows: csv?.rows ?? null, sources: cited.size, ai: ai.info.method, aiDropped: ai.info.dropped.length } });
      return out;
    });
    await this.sendEmails(run, deliveries);
    return {};
  }

  // ── Evidence selection ──
  private async articles(c: PoolClient, sql: string, values: unknown[]): Promise<Article[]> {
    return (await c.query(sql, values)).rows.map((r) => ({ id: r.id, title: r.title, publisher: r.publisher ?? r.publisher_domain, domain: r.publisher_domain, url: r.url,
      publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null, sentiment: r.label ?? 'unanalysed', clusterSize: Number(r.n ?? 1), attribution: r.attribution_requirement }));
  }
  private readonly COLS = `m.id, m.title, m.publisher, m.publisher_domain, m.url, m.published_at, s.attribution_requirement`;
  private where(s: E.Scope) {
    return { sql: `${E.T_EXPR} >= $1 AND ${E.T_EXPR} < $2 AND m.duplicate_status = 'original'
      AND EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = $3)
      AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM mention_topics mt WHERE mt.mention_id = m.id AND mt.analysis_id = m.analysis_id AND mt.topic_key = $4))
      AND ($5::uuid IS NULL OR m.source_id = $5) AND ($6::text IS NULL OR ${E.LANG_EXPR} = $6)`,
      values: [s.from, s.to, s.projects[0], s.q.topic ?? null, s.q.sourceId ?? null, s.q.language ?? null] };
  }
  /** One article per story cluster (the earliest), largest clusters first; unclustered articles count as clusters of one. */
  private notable(c: PoolClient, s: E.Scope, limit: number) {
    const w = this.where(s);
    return this.articles(c, `WITH a AS (SELECT ${this.COLS}, coalesce(m.cluster_id::text, m.id::text) AS k, ${E.T_EXPR} AS t FROM mentions m JOIN sources s ON s.id = m.source_id WHERE ${w.sql}),
      k AS (SELECT k, count(*) AS n FROM a GROUP BY k), rep AS (SELECT DISTINCT ON (a.k) a.*, k.n FROM a JOIN k USING (k) ORDER BY a.k, a.t, a.id)
      SELECT * FROM rep ORDER BY n DESC, t DESC, id LIMIT $7`, [...w.values, limit]);
  }
  private negative(c: PoolClient, s: E.Scope, limit: number) {
    const w = this.where(s);
    return this.articles(c, `SELECT ${this.COLS}, 'negative' AS label FROM mentions m JOIN sources s ON s.id = m.source_id
      JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article' AND sr.label = 'negative' AND NOT sr.uncertain
      WHERE ${w.sql} ORDER BY ${E.T_EXPR} DESC, m.id LIMIT $7`, [...w.values, limit]);
  }
  private entityArticles(c: PoolClient, s: E.Scope, entityId: string, limit: number) {
    const w = this.where(s);
    return this.articles(c, `SELECT ${this.COLS} FROM mentions m JOIN sources s ON s.id = m.source_id
      WHERE ${w.sql} AND EXISTS (SELECT 1 FROM mention_entities me WHERE me.mention_id = m.id AND me.analysis_id = m.analysis_id AND me.entity_id = $7)
      ORDER BY ${E.T_EXPR} DESC, m.id LIMIT $8`, [...w.values, entityId, limit]);
  }
  private async focusIssue(c: PoolClient, run: RunRow, params: ReportParams, s: E.Scope) {
    if (!params.issueId) return null;
    const issue = (await c.query(`SELECT * FROM detected_issues WHERE id = $1 AND project_id = $2`, [params.issueId, run.project_id])).rows[0];
    if (!issue) throw new ReportFailure('The issue selected for this report no longer exists in the project');
    const evidence = await this.articles(c, `SELECT ${this.COLS} FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id JOIN sources s ON s.id = m.source_id
      WHERE e.issue_id = $1 ORDER BY e.is_syndicated, ${E.T_EXPR} DESC, m.id LIMIT $2`, [issue.id, Math.max(params.maxSources, 10)]);
    const events = (await c.query(`SELECT event, at FROM alert_events WHERE issue_id = $1 ORDER BY at`, [issue.id])).rows;
    const byDay = (await c.query(`SELECT to_char((${E.T_EXPR} AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id
      WHERE e.issue_id = $1 GROUP BY 1 ORDER BY 1`, [issue.id, s.tz])).rows;
    return { issue, evidence, events, byDay };
  }

  // ── AI commentary ──
  private async commentary(run: RunRow, d: ReportData): Promise<{ claims: CommentaryClaim[]; info: ReportModel['ai']; tokensIn: number; tokensOut: number }> {
    const info: ReportModel['ai'] = { requested: run.ai_commentary, method: 'none', kept: 0, dropped: [] };
    if (!run.ai_commentary) return { claims: [], info, tokensIn: 0, tokensOut: 0 };
    if (this.provider.method === 'baseline') return { claims: [], info: { ...info, method: 'unavailable' }, tokensIn: 0, tokensOut: 0 };
    const records = [...d.notable, ...d.negative, ...(d.focusIssue?.evidence ?? [])].filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i).slice(0, 15);
    if (!records.length) return { claims: [], info: { ...info, method: 'unavailable' }, tokensIn: 0, tokensOut: 0 };
    const quota = await this.tx(run.tenant_id, (c) => quotaState(c));
    if (quota.tokensThisMonth >= quota.monthlyTokenLimit) {
      logEvent('info', 'reports.ai_quota_reached', { tenantId: run.tenant_id, runId: run.id });
      return { claims: [], info: { ...info, method: 'unavailable', dropped: [{ text: '', reason: 'monthly_token_limit_reached' }] }, tokensIn: 0, tokensOut: 0 };
    }
    const excerpts = await this.tx(run.tenant_id, async (c) => new Map((await c.query<{ id: string; excerpt: string | null }>(
      'SELECT id, excerpt FROM mentions WHERE id = ANY($1::uuid[])', [records.map((r) => r.id)])).rows.map((r) => [r.id, r.excerpt])));
    try {
      const refs = new Map(records.map((r, i) => [`R${i + 1}`, r.id]));
      const res = await this.provider.summarize({ scope: 'period', language: run.language,
        records: records.map((r, i) => ({ ref: `R${i + 1}`, publisher: r.publisher, published: r.publishedAt, title: r.title, excerpt: excerpts.get(r.id) ?? null, syndicated: false })) });
      if (!res) return { claims: [], info: { ...info, method: 'unavailable' }, tokensIn: 0, tokensOut: 0 };
      await this.tx(run.tenant_id, (c) => recordAiUsage(c, run.tenant_id, this.provider.name, res.model, 'report-commentary', res.usage, {}));
      const s = sanitizeMultiSummary(res.output, refs);
      const texts = new Map(records.map((r) => [r.id, `${r.title} ${excerpts.get(r.id) ?? ''}`]));
      const check = validateCommentary(s.claims, { citedIds: new Set(records.map((r) => r.id)), metrics: metricRegistry(d), recordTexts: texts });
      const dropped = [...check.dropped, ...Array.from({ length: s.droppedClaims }, () => ({ text: '', reason: 'no_valid_reference' }))];
      return { claims: check.kept, info: { requested: true, method: check.kept.length ? 'llm' : 'unavailable', kept: check.kept.length, dropped, model: res.model },
        tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens };
    } catch (e) {
      logEvent('warn', 'reports.ai_commentary_failed', { tenantId: run.tenant_id, runId: run.id, message: (e as Error).message.slice(0, 200) });
      return { claims: [], info: { ...info, method: 'unavailable' }, tokensIn: 0, tokensOut: 0 };
    }
  }

  private async validateReferences(run: RunRow, model: ReportModel, cited: Map<string, string[]>) {
    const ids = [...cited.keys()];
    const refs = new Set<string>();
    for (const s of model.sections) for (const b of s.blocks) if (b.type === 'sources') for (const it of b.items) refs.add(it.ref);
    for (const s of model.sections) for (const b of s.blocks) if (b.type === 'paragraph') for (const r of b.refs ?? []) if (!refs.has(r)) throw new ReportFailure(`Reference validation failed: ${r} does not resolve to a listed source`);
    if (!ids.length) return;
    const ok = await this.tx(run.tenant_id, async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM mentions m WHERE m.id = ANY($1::uuid[])
      AND EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = $2)`, [ids, run.project_id])).rows[0]!.n);
    if (ok !== ids.length) throw new ReportFailure(`Reference validation failed: ${ids.length - ok} cited record(s) are not in the report's project`);
  }

  /** Article export. Title and URL always; the excerpt only where the source licence permits redistribution; bodies never. */
  private async csv(run: RunRow, s: E.Scope, cited: Map<string, string[]>) {
    const limit = this.config.reports.csvRowLimit;
    const w = this.where(s);
    return this.tx(run.tenant_id, async (c) => {
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM mentions m WHERE ${w.sql}`, w.values)).rows[0]!.n;
      const rows = (await c.query(`SELECT m.id, m.published_at, m.discovered_at, m.publisher, m.publisher_domain, m.title, m.url, ${E.LANG_EXPR} AS lang, m.excerpt, m.cluster_id,
          s.permitted_fields, s.redistribution_restrictions, sr.label, sr.uncertain, a.method,
          (SELECT string_agg(DISTINCT mt.topic_key, ';' ORDER BY mt.topic_key) FROM mention_topics mt WHERE mt.mention_id = m.id AND mt.analysis_id = m.analysis_id) AS topics,
          (SELECT string_agg(DISTINCT e.display_name, ';' ORDER BY e.display_name) FROM mention_entities me JOIN entities e ON e.id = me.entity_id WHERE me.mention_id = m.id AND me.analysis_id = m.analysis_id) AS entities
        FROM mentions m JOIN sources s ON s.id = m.source_id LEFT JOIN mention_analyses a ON a.id = m.analysis_id
        LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'
        WHERE ${w.sql} ORDER BY ${E.T_EXPR}, m.id LIMIT $7`, [...w.values, limit])).rows;
      const out: Cell[][] = rows.map((r) => {
        const lic = excerptAllowed(r.permitted_fields, r.redistribution_restrictions);
        return [run.id, run.period_start, run.period_end, run.timezone, run.project_name, r.id, r.published_at, r.discovered_at, r.publisher ?? '', r.publisher_domain, r.title, r.url, r.lang,
          r.label ?? (r.method ? 'unknown' : 'unanalysed'), r.uncertain ?? '', r.method ?? '', r.topics ?? '', r.entities ?? '', r.cluster_id ?? '', (cited.get(r.id) ?? []).join(';'),
          lic.ok ? (r.excerpt ?? '') : '', lic.ok ? '' : lic.reason];
      });
      return { data: toCsv(ARTICLE_COLUMNS, out), rows: out.length, total };
    });
  }

  // ── Delivery ──
  private async userName(tenantId: string, id: string | null) {
    if (!id) return 'Analyst';
    return this.tx(tenantId, async (c) => (await c.query<{ display_name: string }>('SELECT u.display_name FROM memberships ms JOIN users u ON u.id = ms.user_id WHERE ms.user_id = $1', [id])).rows[0]?.display_name ?? 'Analyst');
  }

  /** Recipients still authorised now: active member, role with reports:read, and access to the report's project. */
  static async authorisedRecipients(c: PoolClient, projectId: string, userIds: string[]) {
    if (!userIds.length) return [];
    const rows = (await c.query<{ id: string; email: string; role: Role; assigned: boolean }>(`SELECT u.id, u.email, ms.role,
        EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $2 AND pm.user_id = u.id) AS assigned
      FROM memberships ms JOIN users u ON u.id = ms.user_id WHERE ms.user_id = ANY($1::uuid[]) AND u.disabled_at IS NULL`, [userIds, projectId])).rows;
    return rows.filter((r) => hasPermission(r.role, 'reports:read') && (seesAllProjects(r.role) || r.assigned));
  }

  private async createDeliveries(c: PoolClient, run: RunRow) {
    const now = this.clock.now();
    let users: string[] = []; let channels: string[] = ['in_app'];
    if (run.schedule_id) {
      const s = (await c.query<{ recipient_user_ids: string[]; channels: string[] }>('SELECT recipient_user_ids, channels FROM report_schedules WHERE id = $1', [run.schedule_id])).rows[0];
      users = s?.recipient_user_ids ?? []; channels = s?.channels ?? ['in_app'];
    } else if (run.requested_by) users = [run.requested_by];
    const ok = await ReportGenerator.authorisedRecipients(c, run.project_id, users);
    const okIds = new Set(ok.map((u) => u.id));
    const emails: Array<{ id: string; email: string }> = [];
    for (const uid of users) {
      for (const ch of channels) {
        const allowed = okIds.has(uid);
        const status = !allowed ? 'suppressed' : ch === 'in_app' ? 'delivered' : 'pending';
        const r = await c.query<{ id: string }>(`INSERT INTO report_deliveries (tenant_id, run_id, user_id, channel, kind, status, error, sent_at) VALUES ($1,$2,$3,$4,'ready',$5,$6,$7)
          ON CONFLICT (run_id, user_id, channel, kind) DO NOTHING RETURNING id`,
          [run.tenant_id, run.id, uid, ch, status, allowed ? null : 'Recipient is no longer authorised for this project', status === 'delivered' ? now : null]);
        if (r.rows[0] && allowed && ch === 'email') emails.push({ id: r.rows[0].id, email: ok.find((u) => u.id === uid)!.email });
      }
    }
    return emails;
  }

  /** Email carries no report content: only the report name, period and a link to the authenticated app. */
  async sendEmails(run: Pick<RunRow, 'id' | 'tenant_id' | 'name' | 'period_start' | 'period_end' | 'timezone' | 'language'>, list: Array<{ id: string; email: string }>) {
    for (const d of list) {
      let status = 'delivered'; let error: string | null = null;
      if (!this.mailer.configured) { status = 'unconfigured'; error = 'Email is not configured (SMTP_URL / EMAIL_FROM)'; }
      else {
        const link = `${this.config.appBaseUrl}/o/${run.tenant_id}/reports/runs/${run.id}`;
        const period = `${run.period_start.toISOString().slice(0, 10)} – ${new Date(run.period_end.getTime() - 1).toISOString().slice(0, 10)}`;
        const subject = run.language === 'id' ? `Laporan siap: ${run.name} (${period})` : `Report ready: ${run.name} (${period})`;
        const text = `${subject}\n\n${run.language === 'id' ? 'Buka laporan (perlu masuk):' : 'Open the report (sign-in required):'} ${link}\n`;
        const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
        try { await this.mailer.send({ to: d.email, subject, text, html: `<p>${esc(subject)}</p><p><a href="${esc(link)}">${run.language === 'id' ? 'Buka laporan' : 'Open the report'}</a></p>` }); }
        catch (e) { status = 'failed'; error = (e instanceof DeliveryError ? e.message : (e as Error).message).slice(0, 300); }
      }
      await this.tx(run.tenant_id, (c) => c.query(`UPDATE report_deliveries SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'delivered' THEN $4::timestamptz ELSE NULL END WHERE id = $1`,
        [d.id, status, error, this.clock.now()]));
    }
  }
}
