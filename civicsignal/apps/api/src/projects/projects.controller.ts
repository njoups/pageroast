import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { AddProjectMemberDto, CreateProjectDto, ListProjectsQuery, UpdateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@Controller('organizations/:orgId/projects')
@UseGuards(SessionGuard, TenantGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get() @RequirePermission('projects:read')
  list(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query() q: ListProjectsQuery) { return this.projects.list(a, t, q.status); }

  @Post() @RequirePermission('projects:create')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: CreateProjectDto, @Meta() m: RequestMeta) { return this.projects.create(a, t, dto, m); }

  @Get(':id') @RequirePermission('projects:read')
  get(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.projects.get(a, t, id); }

  @Patch(':id') @RequirePermission('projects:update')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto, @Meta() m: RequestMeta) {
    return this.projects.update(a, t, id, dto, m);
  }

  @Post(':id/archive') @HttpCode(200) @RequirePermission('projects:archive')
  archive(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.projects.setArchived(a, t, id, true, m); }

  @Post(':id/unarchive') @HttpCode(200) @RequirePermission('projects:archive')
  unarchive(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.projects.setArchived(a, t, id, false, m); }

  @Delete(':id') @HttpCode(204) @RequirePermission('projects:delete')
  remove(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.projects.remove(a, t, id, m); }

  @Get(':id/members') @RequirePermission('projects:read')
  members(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.projects.listMembers(a, t, id); }

  @Post(':id/members') @HttpCode(204) @RequirePermission('projects:manage_members')
  addMember(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddProjectMemberDto, @Meta() m: RequestMeta) {
    return this.projects.addMember(a, t, id, dto.userId, m);
  }

  @Delete(':id/members/:userId') @HttpCode(204) @RequirePermission('projects:manage_members')
  removeMember(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Meta() m: RequestMeta) {
    return this.projects.removeMember(a, t, id, userId, m);
  }
}
