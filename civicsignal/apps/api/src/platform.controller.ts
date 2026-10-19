import { CanActivate, Controller, ExecutionContext, Get, Inject, Injectable, UseGuards } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit/audit.service';
import { SessionGuard } from './auth/session.guard';
import { Database } from './database/database.service';
import { INGESTION_DLQ, INGESTION_QUEUE, REDIS } from './ingestion/ingestion-core.module';
import { workerHeartbeats, type Redis } from './ingestion/queue';
import { forbidden } from './common/errors';
import { Auth, AuthContext, Meta, RequestMeta, AppRequest } from './common/request';

@Injectable()
class PlatformAdminGuard implements CanActivate {
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
    @Inject(INGESTION_DLQ) private readonly dlq: Queue | null) {}

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
