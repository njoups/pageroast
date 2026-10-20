import { Controller, Get, Inject, Injectable, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { CLOCK, type Clock } from '../alerts/clock';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { Auth, AuthContext, Tenant, TenantContext } from '../common/request';
import * as E from './engine';

export class AnalyticsQuery implements E.AnalyticsParams {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(366) days?: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @Matches(/^(custom:)?[a-z_0-9]{2,40}$/) topic?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @Matches(/^[a-z]{2,3}$/) language?: string;
  @IsOptional() @IsIn(E.SENTIMENT_FILTERS as unknown as string[]) sentiment?: string;
  @IsOptional() @IsIn(E.ISSUE_STATUSES as unknown as string[]) issueStatus?: string;
  @IsOptional() @IsIn(['day', 'week', 'month']) granularity?: E.Granularity;
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsArray() @ArrayMaxSize(10) @IsUUID('all', { each: true }) entityIds?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) offset?: number;
}

const METRICS = {
  overview: E.overview, coverage: E.coverage, sentiment: E.sentiment, 'share-of-voice': E.shareOfVoiceMetric,
  topics: E.topics, entities: E.entities, sources: E.sources, issues: E.issues,
} as const;
export type MetricName = keyof typeof METRICS;

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig, @Inject(CLOCK) private readonly clock: Clock) {}

  opts(): E.EngineOptions {
    return { now: this.clock.now(), maxPeriodDays: this.config.analytics.maxPeriodDays, cacheTtlSeconds: this.config.analytics.cacheTtlSeconds, staleHours: this.config.alerts.collectionStaleHours };
  }

  metric(auth: AuthContext, t: TenantContext, name: MetricName, q: AnalyticsQuery) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const o = this.opts();
      const s = await E.resolveScope(c, { tenantId: t.orgId, userId: auth.userId, role: t.role }, q, o);
      const fn = METRICS[name] as (c: import('pg').PoolClient, s: E.Scope) => Promise<object>;
      return E.cached(c, name, s, o, () => fn(c, s));
    });
  }
}

/**
 * Executive analytics, computed from persisted records the caller may see (tenant RLS + project assignment).
 * Every response carries `period`, `freshness`, `cache` and metric definitions; see docs/ANALYTICS_METHODOLOGY.md.
 */
@ApiTags('analytics')
@Controller('organizations/:orgId/analytics')
@UseGuards(SessionGuard, TenantGuard)
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get('overview') @RequirePermission('mentions:read')
  overview(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'overview', q); }
  @Get('coverage') @RequirePermission('mentions:read')
  coverage(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'coverage', q); }
  @Get('sentiment') @RequirePermission('mentions:read')
  sentiment(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'sentiment', q); }
  @Get('share-of-voice') @RequirePermission('mentions:read')
  sov(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'share-of-voice', q); }
  @Get('topics') @RequirePermission('mentions:read')
  topics(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'topics', q); }
  @Get('entities') @RequirePermission('mentions:read')
  entities(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'entities', q); }
  @Get('sources') @RequirePermission('mentions:read')
  sources(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'sources', q); }
  @Get('issues') @RequirePermission('alerts:read')
  issues(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: AnalyticsQuery) { return this.svc.metric(a, t, 'issues', q); }
}
