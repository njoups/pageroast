import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { Database } from '../database/database.service';
import { forbidden, notFound, unauthorized } from '../common/errors';
import type { AppRequest } from '../common/request';
import { hasPermission, Permission, Role } from './permissions';

export const PERMISSION_KEY = 'required_permission';
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the caller's membership in `:orgId` and checks the handler's permission.
 * Non-members get 404, so the existence of other tenants is not disclosed.
 * Platform-admin status is deliberately ignored here.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly db: Database, private readonly reflector: Reflector, private readonly audit: AuditService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw unauthorized();
    const orgId = req.params.orgId;
    if (typeof orgId !== 'string' || !UUID.test(orgId)) throw notFound('Organization');
    const role = await this.db.withUser(req.auth.userId, async (c) => {
      const r = await c.query<{ role: Role }>(
        `SELECT m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.tenant_id = $1 AND m.user_id = $2 AND t.archived_at IS NULL`, [orgId, req.auth!.userId]);
      return r.rows[0]?.role;
    });
    if (!role) throw notFound('Organization');
    const needed = this.reflector.get<Permission | undefined>(PERMISSION_KEY, context.getHandler());
    if (!needed) throw forbidden('Endpoint has no permission declared'); // fail closed
    if (!hasPermission(role, needed)) {
      // A member attempting an action their role does not allow: recorded in the tenant's audit log (outcome "denied").
      // Non-members get 404 above and are not recorded per tenant, so other tenants' existence is not disclosed.
      await this.db.withTenant(orgId, req.auth.userId, (c) => this.audit.record(c, {
        tenantId: orgId, actorUserId: req.auth!.userId, action: 'authz.denied', outcome: 'denied',
        metadata: { permission: needed, role, method: req.method, route: req.route?.path ?? null },
        meta: { ip: req.ip ?? null, requestId: req.requestId, userAgent: null },
      })).catch(() => undefined);
      throw forbidden();
    }
    req.tenant = { orgId, role };
    return true;
  }
}
