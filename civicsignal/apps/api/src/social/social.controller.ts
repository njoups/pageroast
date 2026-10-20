import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { MentionsQuery } from '../ingestion/mentions';
import { CredentialsDto } from '../ingestion/sources.dto';
import { SocialAnalyticsService } from './social-analytics';
import { SocialService } from './social.service';

class UsageQuery { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number }
class SocialAnalyticsQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(366) days?: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,30}$/) platform?: string;
  @IsOptional() @IsIn(['day', 'week', 'month']) granularity?: 'day' | 'week' | 'month';
}

/**
 * Social listening: provider catalogue and capability matrix, social connectors (configuration, credentials,
 * connection test, sync, health, usage), derived-analysis approvals, budgets, social mentions and analytics.
 * Connectors are sources of a social kind; the generic /sources endpoints still list them and their runs.
 */
@ApiTags('social')
@Controller('organizations/:orgId/social')
@UseGuards(SessionGuard, TenantGuard)
export class SocialController {
  constructor(private readonly social: SocialService, private readonly analytics: SocialAnalyticsService) {}

  @Get('providers') @RequirePermission('sources:read')
  providers(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.social.providers(a, t); }

  @Get('connectors') @RequirePermission('sources:read')
  list(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.social.listConnectors(a, t); }

  @Post('connectors') @RequirePermission('sources:manage')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) { return this.social.createConnector(a, t, b, m); }

  @Get('connectors/:id') @RequirePermission('sources:read')
  get(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.social.getConnector(a, t, id); }

  @Patch('connectors/:id') @RequirePermission('sources:manage')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.social.updateConnector(a, t, id, b, m); }

  @Put('connectors/:id/credentials') @HttpCode(204) @RequirePermission('sources:manage')
  setCredentials(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CredentialsDto, @Meta() m: RequestMeta) {
    return this.social.setCredentials(a, t, id, dto.secret, m);
  }

  @Delete('connectors/:id/credentials') @HttpCode(204) @RequirePermission('sources:manage')
  removeCredentials(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.social.setCredentials(a, t, id, null, m); }

  @Post('connectors/:id/test') @HttpCode(200) @RequirePermission('sources:manage')
  test(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.social.test(a, t, id, m); }

  @Post('connectors/:id/sync') @HttpCode(202) @RequirePermission('sources:manage')
  sync(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.social.sync(a, t, id, m); }

  @Post('connectors/:id/enable') @HttpCode(200) @RequirePermission('sources:manage')
  enable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.social.setEnabled(a, t, id, true, m); }

  @Post('connectors/:id/disable') @HttpCode(200) @RequirePermission('sources:manage')
  disable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.social.setEnabled(a, t, id, false, m); }

  @Get('connectors/:id/health') @RequirePermission('sources:read')
  health(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.social.health(a, t, id); }

  @Get('connectors/:id/usage') @RequirePermission('sources:read')
  usage(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: UsageQuery) { return this.social.usage(a, t, id, q.days ?? 30); }

  @Put('connectors/:id/derived-analysis-approval') @RequirePermission('ai:settings')
  approval(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) { return this.social.setApproval(a, t, id, b, m); }

  @Get('budgets') @RequirePermission('sources:read')
  budgets(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.social.budgets(a, t); }

  @Put('budgets') @RequirePermission('sources:manage')
  putBudget(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) { return this.social.putBudget(a, t, b, m); }

  @Delete('budgets/:id') @HttpCode(204) @RequirePermission('sources:manage')
  deleteBudget(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.social.deleteBudget(a, t, id, m); }

  @Post('notices/:id/acknowledge') @HttpCode(200) @RequirePermission('sources:manage')
  ack(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.social.acknowledgeNotice(a, t, id); }

  @Get('mentions') @RequirePermission('mentions:read')
  mentions(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: MentionsQuery) { return this.social.socialMentions(a, t, q); }

  @Get('analytics') @RequirePermission('mentions:read')
  overview(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: SocialAnalyticsQueryDto) { return this.analytics.overview(a, t, q); }

  @Get('issues/:issueId/timeline') @RequirePermission('alerts:read')
  timeline(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('issueId', ParseUUIDPipe) id: string) { return this.analytics.issueTimeline(a, t, id); }
}
