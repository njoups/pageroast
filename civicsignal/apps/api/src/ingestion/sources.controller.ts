import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { CreateSourceDto, CredentialsDto, RunsQuery, UpdateSourceDto } from './sources.dto';
import { SourcesService } from './sources.service';

class MetricsQuery { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(720) hours?: number }

@ApiTags('sources')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get('sources') @RequirePermission('sources:read')
  list(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.sources.list(a, t); }

  @Post('sources') @RequirePermission('sources:manage')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: CreateSourceDto, @Meta() m: RequestMeta) { return this.sources.create(a, t, dto, m); }

  @Get('sources/:id') @RequirePermission('sources:read')
  get(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.sources.get(a, t, id); }

  @Patch('sources/:id') @RequirePermission('sources:manage')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSourceDto, @Meta() m: RequestMeta) {
    return this.sources.update(a, t, id, dto, m);
  }

  @Post('sources/:id/enable') @HttpCode(200) @RequirePermission('sources:manage')
  enable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.sources.setEnabled(a, t, id, true, m); }

  @Post('sources/:id/disable') @HttpCode(200) @RequirePermission('sources:manage')
  disable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.sources.setEnabled(a, t, id, false, m); }

  @Delete('sources/:id') @HttpCode(204) @RequirePermission('sources:manage')
  remove(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.sources.remove(a, t, id, m); }

  @Post('sources/:id/collect') @HttpCode(202) @RequirePermission('sources:manage')
  collect(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.sources.collectNow(a, t, id, m); }

  @Get('sources/:id/runs') @RequirePermission('sources:read')
  runs(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: RunsQuery) { return this.sources.runs(a, t, id, q.limit); }

  @Post('sources/:id/runs/:runId/retry') @HttpCode(202) @RequirePermission('sources:manage')
  retry(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('runId', ParseUUIDPipe) runId: string, @Meta() m: RequestMeta) {
    return this.sources.retryRun(a, t, id, runId, m);
  }

  @Put('sources/:id/credentials') @HttpCode(204) @RequirePermission('sources:manage')
  setCredentials(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CredentialsDto, @Meta() m: RequestMeta) {
    return this.sources.setCredentials(a, t, id, dto.secret, m);
  }

  @Delete('sources/:id/credentials') @HttpCode(204) @RequirePermission('sources:manage')
  removeCredentials(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) {
    return this.sources.setCredentials(a, t, id, null, m);
  }

  @Get('ingestion/metrics') @RequirePermission('sources:read')
  metrics(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: MetricsQuery) { return this.sources.metrics(a, t, q.hours ?? 24); }
}
