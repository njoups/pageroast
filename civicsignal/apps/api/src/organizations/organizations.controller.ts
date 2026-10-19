import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { RateLimit, RateLimitGuard } from '../common/rate-limit';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { AcceptInvitationDto, CreateOrgDto, InviteDto, UpdateOrgDto, UpdateRoleDto } from './dto';
import { OrganizationsService } from './organizations.service';

@ApiTags('organizations')
@Controller('organizations')
@UseGuards(SessionGuard)
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  create(@Auth() a: AuthContext, @Body() dto: CreateOrgDto, @Meta() m: RequestMeta) { return this.orgs.create(a, dto, m); }

  @Get(':orgId') @UseGuards(TenantGuard) @RequirePermission('org:read')
  get(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.orgs.get(a, t); }

  @Patch(':orgId') @UseGuards(TenantGuard) @RequirePermission('org:update')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: UpdateOrgDto, @Meta() m: RequestMeta) { return this.orgs.update(a, t, dto, m); }

  @Get(':orgId/members') @UseGuards(TenantGuard) @RequirePermission('members:read')
  members(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.orgs.listMembers(a, t); }

  @Patch(':orgId/members/:userId') @UseGuards(TenantGuard) @RequirePermission('members:update_role')
  updateRole(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdateRoleDto, @Meta() m: RequestMeta) {
    return this.orgs.updateRole(a, t, userId, dto.role, m);
  }

  @Delete(':orgId/members/:userId') @HttpCode(204) @UseGuards(TenantGuard) @RequirePermission('members:remove')
  remove(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('userId', ParseUUIDPipe) userId: string, @Meta() m: RequestMeta) {
    return this.orgs.removeMember(a, t, userId, m);
  }

  @Post(':orgId/leave') @HttpCode(204) @UseGuards(TenantGuard) @RequirePermission('org:read')
  leave(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Meta() m: RequestMeta) { return this.orgs.leave(a, t, m); }

  @Post(':orgId/invitations') @UseGuards(TenantGuard) @RequirePermission('members:invite')
  invite(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() dto: InviteDto, @Meta() m: RequestMeta) { return this.orgs.invite(a, t, dto, m); }

  @Get(':orgId/invitations') @UseGuards(TenantGuard) @RequirePermission('members:invite')
  invitations(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.orgs.listInvitations(a, t); }

  @Delete(':orgId/invitations/:id') @HttpCode(204) @UseGuards(TenantGuard) @RequirePermission('members:invite')
  revoke(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) { return this.orgs.revokeInvitation(a, t, id, m); }
}

@ApiTags('organizations')
@Controller('invitations')
@UseGuards(SessionGuard, RateLimitGuard)
export class InvitationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post('accept') @HttpCode(200) @RateLimit({ limit: 10, windowSeconds: 300 })
  accept(@Auth() a: AuthContext, @Body() dto: AcceptInvitationDto, @Meta() m: RequestMeta) { return this.orgs.acceptInvitation(a, dto.token, m); }
}
