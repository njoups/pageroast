import { readdirSync } from 'node:fs';
import { Controller, Get, Header, HttpException, Inject, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Queue } from 'bullmq';
import { ALERTS_QUEUE, queueHealth } from '../alerts/alerts-queue';
import { ANALYSIS_QUEUE } from '../analysis/analysis-queue';
import { AppConfig, CONFIG } from '../config';
import { notFound } from '../common/errors';
import type { AppRequest } from '../common/request';
import { MIGRATIONS_DIR } from '../database/migrate';
import { Database } from '../database/database.service';
import { INGESTION_QUEUE, REDIS } from '../ingestion/ingestion-core.module';
import { workerHeartbeats, type Redis } from '../ingestion/queue';
import { REPORTS_QUEUE } from '../reports/reports-queue';
import { httpMetricsText, metricsAuthorized } from './metrics';

const SYS = '00000000-0000-0000-0000-000000000000';
const expectedMigrations = (() => { try { return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort(); } catch { return null; } })();

/**
 * Liveness: the process is up (no dependencies, so a database outage does not restart every pod).
 * Readiness: database reachable, Redis reachable when configured, and the schema has every migration this build expects.
 * Responses carry status words only: no hostnames, versions, error messages or tenant data.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  private gaugeCache: { at: number; text: string } | null = null;
  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig, @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(INGESTION_QUEUE) private readonly ingestion: Queue | null, @Inject(ANALYSIS_QUEUE) private readonly analysis: Queue | null,
    @Inject(ALERTS_QUEUE) private readonly alerts: Queue | null, @Inject(REPORTS_QUEUE) private readonly reports: Queue | null) {}

  @Get('health/live') live() { return { status: 'ok' }; }

  @Get('health/ready')
  async ready() {
    const checks: Record<string, string> = {};
    try { await this.db.ping(); checks.database = 'up'; } catch { checks.database = 'down'; }
    if (this.redis) { try { await this.redis.ping(); checks.redis = 'up'; } catch { checks.redis = 'down'; } } else checks.redis = 'not_configured';
    if (checks.database === 'up' && expectedMigrations) {
      try {
        const applied = new Set(await this.db.withSystem(async (c) => (await c.query<{ v: string }>('SELECT app_schema_versions() AS v')).rows.map((r) => r.v)));
        checks.migrations = expectedMigrations.every((f) => applied.has(f)) ? 'current' : 'pending';
      } catch { checks.migrations = 'unknown'; }
    }
    const ok = checks.database === 'up' && checks.redis !== 'down' && checks.migrations !== 'pending' && checks.migrations !== 'unknown';
    if (!ok) throw new HttpException({ status: 'unavailable', checks }, 503);
    return { status: 'ok', checks };
  }

  /**
   * Prometheus metrics (bearer METRICS_TOKEN; 404 when disabled). Operational gauges are aggregated across tenants as
   * counts and ages only, and cached for 15 s so scrapes stay cheap.
   */
  @Get('metrics') @ApiExcludeEndpoint() @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics(@Req() req: AppRequest) {
    if (!this.config.metricsToken) throw notFound();
    if (!metricsAuthorized(req.get('authorization'), this.config.metricsToken)) throw new HttpException({ error: { code: 'unauthenticated', message: 'Metrics token required' } }, 401);
    if (!this.gaugeCache || Date.now() - this.gaugeCache.at > 15_000) this.gaugeCache = { at: Date.now(), text: await this.gauges() };
    return `${httpMetricsText()}\n${this.gaugeCache.text}\n`;
  }

  private async gauges(): Promise<string> {
    const out: string[] = [];
    const g = (name: string, help: string, rows: Array<[Record<string, string>, number]>) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [l, v] of rows) out.push(`${name}${Object.keys(l).length ? `{${Object.entries(l).map(([k, x]) => `${k}="${x}"`).join(',')}}` : ''} ${v}`);
    };
    const queues = { ingestion: this.ingestion, analysis: this.analysis, alerts: this.alerts, reports: this.reports };
    const depth: Array<[Record<string, string>, number]> = []; const lag: Array<[Record<string, string>, number]> = [];
    for (const [name, q] of Object.entries(queues)) {
      const h = await queueHealth(q).catch(() => null);
      if (!h) continue;
      for (const [state, n] of Object.entries(h.counts)) depth.push([{ queue: name, state }, n]);
      lag.push([{ queue: name }, h.lagSeconds]);
    }
    const pool = this.db.poolStats();
    g('civicsignal_db_pool_connections', 'API database pool connections by state (max is the configured limit).',
      [[{ state: 'total' }, pool.total], [{ state: 'idle' }, pool.idle], [{ state: 'waiting' }, pool.waiting], [{ state: 'max' }, pool.max]]);
    g('civicsignal_queue_jobs', 'Jobs per queue and state.', depth);
    g('civicsignal_queue_lag_seconds', 'Age of the oldest waiting job.', lag);
    if (this.redis) {
      const beats = await workerHeartbeats(this.redis).catch(() => []);
      g('civicsignal_workers', 'Workers with a heartbeat in the last 60 s.', [[{}, beats.length]]);
    }
    const sys = await this.db.withSystem(async (c) => ({
      lag: Number((await c.query(`SELECT coalesce(extract(epoch FROM now() - min(next_due_at)), 0)::int AS s FROM ingestion_schedule WHERE active AND next_due_at < now()`)).rows[0]?.s ?? 0),
      reports: (await c.query(`SELECT status, count(*)::int AS n FROM report_runs WHERE queued_at > now() - interval '1 hour' GROUP BY 1`)).rows,
      deliveries: (await c.query(`SELECT channel, status, count(*)::int AS n FROM notification_deliveries WHERE created_at > now() - interval '1 hour' AND status IN ('failed','dead','unconfigured') GROUP BY 1, 2`)).rows,
      webhooks: Number((await c.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE created_at > now() - interval '1 hour' AND status IN ('failed','dead')`)).rows[0]?.n ?? 0),
      artifacts: (await c.query(`SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::bigint AS b FROM report_artifacts WHERE data IS NOT NULL`)).rows[0],
      dbBytes: Number((await c.query(`SELECT pg_database_size(current_database())::bigint AS b`)).rows[0].b),
      tenants: (await c.query<{ id: string }>('SELECT id FROM tenants WHERE archived_at IS NULL')).rows.map((r) => r.id),
      // Aggregated across tenants, never labelled by tenant. Each query degrades to "no series" on its own.
      runs: (await c.query(`SELECT status, count(*)::int AS n FROM connector_runs WHERE finished_at > now() - interval '1 hour' GROUP BY 1`).catch(() => ({ rows: [] }))).rows,
      billingHooks: (await c.query(`SELECT status, count(*)::int AS n FROM billing_webhook_events WHERE received_at > now() - interval '1 hour' AND status IN ('failed','rejected') GROUP BY 1`).catch(() => ({ rows: [] }))).rows,
      socialQuota: (await c.query(`SELECT level, count(*)::int AS n FROM social_budget_events WHERE created_at > now() - interval '24 hours' AND level IN ('hard','provider_quota') GROUP BY 1`).catch(() => ({ rows: [] }))).rows,
    })).catch(() => null);
    if (sys) {
      g('civicsignal_ingestion_overdue_seconds', 'How long the most overdue source collection has been waiting.', [[{}, sys.lag]]);
      g('civicsignal_report_runs_last_hour', 'Report runs queued in the last hour by status.', sys.reports.map((r) => [{ status: r.status }, r.n]));
      g('civicsignal_notification_failures_last_hour', 'Failed, dead or unconfigured notification deliveries in the last hour.', sys.deliveries.map((r) => [{ channel: r.channel, status: r.status }, r.n]));
      g('civicsignal_webhook_failures_last_hour', 'Failed or dead webhook deliveries in the last hour.', [[{}, sys.webhooks]]);
      g('civicsignal_report_artifact_bytes', 'Bytes of stored report files.', [[{}, Number(sys.artifacts.b)]]);
      g('civicsignal_database_bytes', 'Database size.', [[{}, sys.dbBytes]]);
      g('civicsignal_ingestion_runs_last_hour', 'Collection runs finished in the last hour by status.', sys.runs.map((r) => [{ status: r.status }, r.n]));
      g('civicsignal_billing_webhook_failures_last_hour', 'Billing provider webhooks that failed or were rejected in the last hour.', sys.billingHooks.map((r) => [{ status: r.status }, r.n]));
      g('civicsignal_social_quota_events_last_day', 'Social connectors paused by a hard budget or provider quota in the last 24 h.', sys.socialQuota.map((r) => [{ level: r.level }, r.n]));
      // Per-tenant counters that RLS keeps tenant-scoped: summed across tenants, never labelled by tenant.
      let failed = 0; let exhausted = 0;
      for (const t of sys.tenants.slice(0, 500)) {
        await this.db.withTenant(t, SYS, async (c) => {
          failed += Number((await c.query(`SELECT count(*)::int AS n FROM mention_analyses WHERE status = 'failed' AND finished_at > now() - interval '1 hour'`)).rows[0].n);
          const q = (await c.query(`SELECT (SELECT coalesce(sum(tokens_in + tokens_out), 0) FROM ai_usage_records WHERE recorded_at >= date_trunc('month', now())) >=
              coalesce((SELECT monthly_token_limit FROM ai_tenant_settings), 2000000) AS exhausted`)).rows[0];
          if (q.exhausted) exhausted++;
        }).catch(() => undefined);
      }
      g('civicsignal_analysis_failures_last_hour', 'Analyses that failed in the last hour (all tenants).', [[{}, failed]]);
      g('civicsignal_tenants_ai_quota_exhausted', 'Tenants that reached their monthly AI token limit.', [[{}, exhausted]]);
    }
    return out.join('\n');
  }
}
