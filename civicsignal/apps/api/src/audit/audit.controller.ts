import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { Database } from '../database/database.service';
import { Auth, AuthContext, Tenant, TenantContext } from '../common/request';

class AuditQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) before?: number;
  @IsOptional() @IsString() @Matches(/^[a-z_.]{1,60}$/) action?: string;
}

@ApiTags('audit')
@Controller('organizations/:orgId/audit-events')
@UseGuards(SessionGuard, TenantGuard)
export class AuditController {
  constructor(private readonly db: Database) {}

  @Get()
  @RequirePermission('audit:read')
  async list(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Query() q: AuditQuery) {
    const limit = q.limit ?? 50;
    const rows = await this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT a.id::text, a.action, a.target_type, a.target_id, a.metadata, a.ip::text, a.request_id, a.occurred_at,
              a.actor_user_id, u.display_name AS actor_name, u.email AS actor_email
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ($1::bigint IS NULL OR a.id < $1) AND ($2::text IS NULL OR a.action LIKE $2 || '%')
       ORDER BY a.id DESC LIMIT $3`, [q.before ?? null, q.action ?? null, limit + 1])).rows);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, nextBefore: hasMore ? Number(items[items.length - 1]!.id) : null };
  }
}
