import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { canAssignRole, canRemoveMember, Role } from '../authz/permissions';
import { Database } from '../database/database.service';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import type { AuthContext, RequestMeta, TenantContext } from '../common/request';
import { hashToken } from '../identity/local-identity.provider';
import type { CreateOrgDto, InviteDto, UpdateOrgDto } from './dto';

const INVITE_TTL_DAYS = 7;
const ALLOWED_SETTINGS = new Set(['brandColor', 'timezone', 'locale']);
const TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

export function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return (base.length >= 3 ? base : `org-${base}`).replace(/-+$/, '') + '-' + randomBytes(2).toString('hex');
}

@Injectable()
export class OrganizationsService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  async create(auth: AuthContext, dto: CreateOrgDto, meta: RequestMeta) {
    const id = randomUUID();
    const slug = dto.slug ?? slugify(dto.name);
    return this.db.run({ system: true, tenantId: id, userId: auth.userId }, async (c) => {
      const t = await c.query(
        `INSERT INTO tenants (id, name, slug, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO NOTHING RETURNING id, name, slug, settings, created_at`, [id, dto.name, slug, auth.userId]);
      if (!t.rows[0]) throw conflict('slug_taken', 'This organization URL is already in use');
      await c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [id, auth.userId]);
      await this.audit.record(c, { tenantId: id, actorUserId: auth.userId, action: 'org.created', targetType: 'tenant', targetId: id, metadata: { name: dto.name }, meta });
      return { ...t.rows[0], role: 'owner' as Role };
    });
  }

  get(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('SELECT id, name, slug, settings, created_at FROM tenants WHERE id = $1', [t.orgId]);
      return { ...r.rows[0], role: t.role };
    });
  }

  update(auth: AuthContext, t: TenantContext, dto: UpdateOrgDto, meta: RequestMeta) {
    if (dto.settings) {
      const bad = Object.keys(dto.settings).filter((k) => !ALLOWED_SETTINGS.has(k));
      if (bad.length) throw badRequest('validation_failed', 'Unsupported settings keys', bad);
      const { brandColor, timezone, locale } = dto.settings;
      if (brandColor !== undefined && (typeof brandColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(brandColor))) throw badRequest('validation_failed', 'brandColor must be #RRGGBB');
      if (timezone !== undefined && (typeof timezone !== 'string' || !TIMEZONES.has(timezone))) throw badRequest('validation_failed', 'timezone must be an IANA timezone');
      if (locale !== undefined && (typeof locale !== 'string' || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(locale))) throw badRequest('validation_failed', 'locale must look like id-ID');
    }
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query(
        `UPDATE tenants SET name = coalesce($2, name), settings = settings || coalesce($3::jsonb, '{}'::jsonb)
         WHERE id = $1 RETURNING id, name, slug, settings, created_at`,
        [t.orgId, dto.name ?? null, dto.settings ? JSON.stringify(dto.settings) : null]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'org.updated', targetType: 'tenant', targetId: t.orgId, metadata: { fields: Object.keys(dto) }, meta });
      return r.rows[0];
    });
  }

  listMembers(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY u.display_name`, [t.orgId])).rows);
  }

  private async lockMember(c: PoolClient, tenantId: string, userId: string): Promise<{ role: Role }> {
    const r = await c.query<{ role: Role }>('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [tenantId, userId]);
    if (!r.rows[0]) throw notFound('Member');
    return r.rows[0];
  }

  private async assertNotLastOwner(c: PoolClient, tenantId: string): Promise<void> {
    const owners = await c.query(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner' FOR UPDATE`, [tenantId]);
    if (owners.rowCount! <= 1) throw conflict('last_owner', 'An organization must keep at least one owner');
  }

  updateRole(auth: AuthContext, t: TenantContext, userId: string, role: Role, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const target = await this.lockMember(c, t.orgId, userId);
      if (target.role === role) return { userId, role };
      if (!canAssignRole(t.role, target.role, role)) throw forbidden('Your role cannot make this change');
      if (target.role === 'owner') await this.assertNotLastOwner(c, t.orgId);
      await c.query('UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2', [t.orgId, userId, role]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'member.role_changed', targetType: 'user', targetId: userId, metadata: { from: target.role, to: role }, meta });
      return { userId, role };
    });
  }

  removeMember(auth: AuthContext, t: TenantContext, userId: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const target = await this.lockMember(c, t.orgId, userId);
      if (!canRemoveMember(t.role, target.role)) throw forbidden('Your role cannot remove this member');
      if (target.role === 'owner') await this.assertNotLastOwner(c, t.orgId);
      await c.query('DELETE FROM project_members WHERE tenant_id = $1 AND user_id = $2', [t.orgId, userId]);
      await c.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [t.orgId, userId]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'member.removed', targetType: 'user', targetId: userId, metadata: { role: target.role }, meta });
    });
  }

  invite(auth: AuthContext, t: TenantContext, dto: InviteDto, meta: RequestMeta) {
    if (!canAssignRole(t.role, 'report_viewer', dto.role)) throw forbidden('Only owners can invite administrators');
    const token = randomBytes(32).toString('base64url');
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const existing = await c.query('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.email = $2', [t.orgId, dto.email]);
      if (existing.rowCount) throw conflict('already_member', 'This person is already a member');
      const r = await c.query(
        `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))
         ON CONFLICT (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL DO NOTHING
         RETURNING id, email, role, expires_at, created_at`,
        [t.orgId, dto.email, dto.role, hashToken(token), auth.userId, INVITE_TTL_DAYS]);
      if (!r.rows[0]) throw conflict('invitation_pending', 'An open invitation already exists for this email; revoke it first');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'invitation.created', targetType: 'invitation', targetId: r.rows[0].id, metadata: { email: dto.email, role: dto.role }, meta });
      // The raw token is returned exactly once. Email delivery is not configured in M1.
      return { ...r.rows[0], token, delivery: 'manual' as const };
    });
  }

  listInvitations(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT id, email, role, expires_at, created_at FROM invitations
       WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`)).rows);
  }

  revokeInvitation(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id', [id]);
      if (!r.rowCount) throw notFound('Invitation');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'invitation.revoked', targetType: 'invitation', targetId: id, meta });
    });
  }

  async acceptInvitation(auth: AuthContext, token: string, meta: RequestMeta) {
    const inv = await this.db.withSystem(async (c) => (await c.query<{ id: string; tenant_id: string; email: string; role: Role }>(
      `SELECT i.id, i.tenant_id, i.email, i.role FROM invitations i JOIN tenants t ON t.id = i.tenant_id
       WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND t.archived_at IS NULL`,
      [hashToken(token)])).rows[0]);
    // Same response for unknown token and wrong recipient so tokens can't be probed for validity.
    if (!inv || inv.email !== auth.email) throw notFound('Invitation');
    return this.db.run({ system: true, tenantId: inv.tenant_id, userId: auth.userId }, async (c) => {
      const claimed = await c.query('UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL RETURNING id', [inv.id]);
      if (!claimed.rowCount) throw notFound('Invitation');
      const m = await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING id`,
        [inv.tenant_id, auth.userId, inv.role]);
      if (!m.rowCount) throw conflict('already_member', 'You are already a member of this organization');
      await this.audit.record(c, { tenantId: inv.tenant_id, actorUserId: auth.userId, action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id, metadata: { role: inv.role }, meta });
      return { organizationId: inv.tenant_id, role: inv.role };
    });
  }
}
