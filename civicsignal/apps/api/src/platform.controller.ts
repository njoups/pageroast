import { Body, CanActivate, Controller, Delete, ExecutionContext, Get, HttpCode, Inject, Injectable, Param, Put, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import type { Queue } from 'bullmq';
import { ApiTags } from '@nestjs/swagger';
import { ALERTS_DLQ, ALERTS_QUEUE, queueHealth } from './alerts/alerts-queue';
import { AuditService } from './audit/audit.service';
import { SessionGuard } from './auth/session.guard';
import { Database } from './database/database.service';
import { INGESTION_DLQ, INGESTION_QUEUE, REDIS } from './ingestion/ingestion-core.module';
import { workerHeartbeats, type Redis } from './ingestion/queue';
import { forbidden } from './common/errors';
import { ANALYSIS_PROVIDER, type AnalysisProvider } from './analysis/providers';
import { ANALYSIS_QUEUE } from './analysis/analysis-queue';
import { REPORTS_QUEUE } from './reports/reports-queue';
import { Auth, AuthContext, Meta, RequestMeta, AppRequest } from './common/request';

class PricingDto {
  @Type(() => Number) @IsNumber() @Min(0) inputPerMtok: number;
  @Type(() => Number) @IsNumber() @Min(0) outputPerMtok: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) cacheReadPerMtok?: number;
  @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsString() @MinLength(3) @MaxLength(500) source: string;
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (!ctx.switchToHttp().getRequest<AppRequest>().auth?.isPlatformAdmin) throw forbidden();
    return true;
  }
}

/**
 * Platform operations see tenant *metadata* only (no projects, mentions, or other content).
 * Content access requires a time-boxed, reasoned break-glass grant (planned for M6).
 */
@ApiTags('platform')
@Controller('platform')
@UseGuards(SessionGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(private readonly db: Database, private readonly audit: AuditService,
    @Inject(INGESTION_QUEUE) private readonly queue: Queue | null, @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(INGESTION_DLQ) private readonly dlq: Queue | null,
    @Inject(ANALYSIS_QUEUE) private readonly analysisQueue: Queue | null, @Inject(ANALYSIS_PROVIDER) private readonly provider: AnalysisProvider,
    @Inject(ALERTS_QUEUE) private readonly alertsQueue: Queue | null, @Inject(ALERTS_DLQ) private readonly alertsDlq: Queue | null,
    @Inject(REPORTS_QUEUE) private readonly reportsQueue: Queue | null) {}

  /** Alert evaluation/notification queue health: depth, lag and dead letters (no tenant content). */
  @Get('alerts')
  async alerts() {
    if (!this.alertsQueue) return { configured: false };
    return { configured: true, queue: await queueHealth(this.alertsQueue), deadLetter: this.alertsDlq ? await this.alertsDlq.getJobCounts('waiting') : null,
      ingestion: await queueHealth(this.queue), analysis: await queueHealth(this.analysisQueue) };
  }

  /** Report generation and analytics aggregation health across tenants: counts and ages only, no tenant content. */
  @Get('reports')
  async reports() {
    const db = await this.db.withSystem(async (c) => ({
      runs: (await c.query(`SELECT status, count(*)::int AS n FROM report_runs WHERE queued_at > now() - interval '1 day' GROUP BY 1`)).rows,
      oldestQueuedSeconds: Number((await c.query(`SELECT coalesce(extract(epoch FROM now() - min(queued_at)), 0)::int AS s FROM report_runs WHERE status = 'queued'`)).rows[0].s),
      durationP50Seconds: (await c.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at)) AS p FROM report_runs
        WHERE status = 'succeeded' AND finished_at > now() - interval '1 day'`)).rows[0].p,
      failingSchedules: Number((await c.query(`SELECT count(*)::int AS n FROM report_schedules WHERE is_active AND consecutive_failures >= 3`)).rows[0].n),
      artifactsStored: (await c.query(`SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::bigint AS bytes FROM report_artifacts WHERE data IS NOT NULL`)).rows[0],
      analytics: (await c.query(`SELECT count(*)::int AS tenants, min(refreshed_at) AS oldest_refresh, max(refreshed_at) AS newest_refresh FROM analytics_state`)).rows[0],
    }));
    return { configured: !!this.reportsQueue, queue: await queueHealth(this.reportsQueue), ...db };
  }

  /** AI provider configuration (never the key) and analysis queue depth. */
  @Get('ai/status')
  async aiStatus() {
    return {
      provider: { name: this.provider.name, model: this.provider.model, method: this.provider.method },
      queue: this.analysisQueue ? await this.analysisQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed') : null,
    };
  }

  @Get('ai/pricing')
  pricing() {
    return this.db.withSystem(async (c) => (await c.query('SELECT provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, currency, source, updated_at FROM ai_pricing ORDER BY provider, model')).rows);
  }

  /** Operator-maintained price list used only for estimates. Prices are not shipped with the code. */
  @Put('ai/pricing/:provider/:model')
  setPricing(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('provider') provider: string, @Param('model') model: string, @Body() dto: PricingDto) {
    if (!/^[a-z0-9_-]{2,40}$/.test(provider) || !/^[a-zA-Z0-9._:-]{2,100}$/.test(model)) throw forbidden('Invalid provider or model identifier');
    return this.db.withSystem(async (c) => {
      const r = await c.query(`INSERT INTO ai_pricing (provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, currency, source, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) ON CONFLICT (provider, model) DO UPDATE SET input_per_mtok = EXCLUDED.input_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
          cache_read_per_mtok = EXCLUDED.cache_read_per_mtok, currency = EXCLUDED.currency, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, currency, source, updated_at`,
        [provider, model, dto.inputPerMtok, dto.outputPerMtok, dto.cacheReadPerMtok ?? null, dto.currency ?? 'USD', dto.source, a.userId]);
      await this.audit.record(c, { tenantId: null, actorUserId: a.userId, action: 'platform.ai_pricing_set', targetType: 'ai_pricing', targetId: `${provider}/${model}`, metadata: { ...dto }, meta: m });
      return r.rows[0];
    });
  }

  @Delete('ai/pricing/:provider/:model') @HttpCode(204)
  removePricing(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('provider') provider: string, @Param('model') model: string) {
    return this.db.withSystem(async (c) => {
      await c.query('DELETE FROM ai_pricing WHERE provider = $1 AND model = $2', [provider, model]);
      await this.audit.record(c, { tenantId: null, actorUserId: a.userId, action: 'platform.ai_pricing_removed', targetType: 'ai_pricing', targetId: `${provider}/${model}`, meta: m });
    });
  }

  /** Global queue depth and worker liveness: operational metadata only, no tenant content. */
  @Get('ingestion')
  async ingestion() {
    if (!this.queue || !this.redis) return { configured: false };
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized');
    const deadLetter = this.dlq ? await this.dlq.getJobCounts('waiting') : null;
    return { configured: true, queue: counts, deadLetter, workers: await workerHeartbeats(this.redis) };
  }

  @Get('tenants')
  tenants(@Auth() a: AuthContext, @Meta() m: RequestMeta) {
    return this.db.withSystem(async (c) => {
      await this.audit.record(c, { tenantId: null, actorUserId: a.userId, action: 'platform.tenants_listed', meta: m });
      return (await c.query(
        `SELECT t.id, t.name, t.slug, t.created_at, t.archived_at,
                (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id) AS member_count
         FROM tenants t ORDER BY t.created_at DESC`)).rows;
    });
  }
}
