import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { seesAllProjects } from '../authz/permissions';
import { Database } from '../database/database.service';
import { badRequest, conflict, notFound } from '../common/errors';
import type { AuthContext, RequestMeta, TenantContext } from '../common/request';
import type { CreateProjectDto, UpdateProjectDto } from './dto';

const COLS = `p.id, p.name, p.objective, p.status, p.languages, p.date_range_start, p.date_range_end,
  p.created_by, p.archived_at, p.created_at, p.updated_at`;

function checkRange(start?: string | null, end?: string | null) {
  if (start && end && end < start) throw badRequest('validation_failed', 'dateRangeEnd must be on or after dateRangeStart');
}

@Injectable()
export class ProjectsService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  /** Visibility rule: owners/admins see all projects, others only those they are assigned to. Returns 404 otherwise. */
  private async load(c: PoolClient, auth: AuthContext, t: TenantContext, id: string, lock = false) {
    const r = await c.query(
      `SELECT ${COLS} FROM projects p WHERE p.id = $1
       AND ($2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3))
       ${lock ? 'FOR UPDATE' : ''}`, [id, seesAllProjects(t.role), auth.userId]);
    if (!r.rows[0]) throw notFound('Project');
    return r.rows[0];
  }

  list(auth: AuthContext, t: TenantContext, status: 'active' | 'archived' | 'all' = 'active') {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => (await c.query(
      `SELECT ${COLS}, (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS member_count
       FROM projects p
       WHERE ($1 = 'all' OR p.status = $1)
         AND ($2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3))
       ORDER BY p.created_at DESC`, [status, seesAllProjects(t.role), auth.userId])).rows);
  }

  get(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, (c) => this.load(c, auth, t, id));
  }

  create(auth: AuthContext, t: TenantContext, dto: CreateProjectDto, meta: RequestMeta) {
    checkRange(dto.dateRangeStart, dto.dateRangeEnd);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query(
        `INSERT INTO projects (tenant_id, name, objective, languages, date_range_start, date_range_end, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [t.orgId, dto.name, dto.objective ?? '', dto.languages ?? [], dto.dateRangeStart ?? null, dto.dateRangeEnd ?? null, auth.userId])
        .catch((e: { code?: string }) => { throw e.code === '23505' ? conflict('project_name_taken', 'A project with this name already exists') : e; });
      const id = r.rows[0].id as string;
      // Creators who would not otherwise see all projects are assigned so they can see what they created.
      if (!seesAllProjects(t.role)) {
        await c.query('INSERT INTO project_members (tenant_id, project_id, user_id, added_by) VALUES ($1,$2,$3,$3)', [t.orgId, id, auth.userId]);
      }
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'project.created', targetType: 'project', targetId: id, metadata: { name: dto.name }, meta });
      return this.load(c, auth, t, id);
    });
  }

  update(auth: AuthContext, t: TenantContext, id: string, dto: UpdateProjectDto, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = await this.load(c, auth, t, id, true);
      if (p.status === 'archived') throw conflict('project_archived', 'Unarchive the project before editing it');
      const start = dto.dateRangeStart !== undefined ? dto.dateRangeStart : (p.date_range_start as string | null);
      const end = dto.dateRangeEnd !== undefined ? dto.dateRangeEnd : (p.date_range_end as string | null);
      checkRange(start?.slice(0, 10), end?.slice(0, 10));
      await c.query(
        `UPDATE projects SET name = coalesce($2, name), objective = coalesce($3, objective), languages = coalesce($4, languages),
           date_range_start = CASE WHEN $5 THEN $6::date ELSE date_range_start END,
           date_range_end = CASE WHEN $7 THEN $8::date ELSE date_range_end END
         WHERE id = $1`,
        [id, dto.name ?? null, dto.objective ?? null, dto.languages ?? null,
          dto.dateRangeStart !== undefined, dto.dateRangeStart ?? null, dto.dateRangeEnd !== undefined, dto.dateRangeEnd ?? null])
        .catch((e: { code?: string }) => { throw e.code === '23505' ? conflict('project_name_taken', 'A project with this name already exists') : e; });
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'project.updated', targetType: 'project', targetId: id, metadata: { fields: Object.keys(dto) }, meta });
      return this.load(c, auth, t, id);
    });
  }

  setArchived(auth: AuthContext, t: TenantContext, id: string, archived: boolean, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.load(c, auth, t, id, true);
      await c.query(
        `UPDATE projects SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() ELSE NULL END WHERE id = $1`,
        [id, archived ? 'archived' : 'active']);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: archived ? 'project.archived' : 'project.unarchived', targetType: 'project', targetId: id, meta });
      return this.load(c, auth, t, id);
    });
  }

  remove(auth: AuthContext, t: TenantContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const p = await this.load(c, auth, t, id, true);
      await c.query('DELETE FROM projects WHERE id = $1', [id]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'project.deleted', targetType: 'project', targetId: id, metadata: { name: p.name }, meta });
    });
  }

  listMembers(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.load(c, auth, t, id);
      return (await c.query(
        `SELECT pm.user_id, u.display_name, u.email, m.role, pm.created_at FROM project_members pm
         JOIN users u ON u.id = pm.user_id JOIN memberships m ON m.user_id = pm.user_id AND m.tenant_id = pm.tenant_id
         WHERE pm.project_id = $1 ORDER BY u.display_name`, [id])).rows;
    });
  }

  addMember(auth: AuthContext, t: TenantContext, id: string, userId: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.load(c, auth, t, id);
      const m = await c.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2', [t.orgId, userId]);
      if (!m.rowCount) throw notFound('Member');
      await c.query(
        `INSERT INTO project_members (tenant_id, project_id, user_id, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [t.orgId, id, userId, auth.userId]);
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'project.member_added', targetType: 'project', targetId: id, metadata: { userId }, meta });
    });
  }

  removeMember(auth: AuthContext, t: TenantContext, id: string, userId: string, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      await this.load(c, auth, t, id);
      const r = await c.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [id, userId]);
      if (!r.rowCount) throw notFound('Project member');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'project.member_removed', targetType: 'project', targetId: id, metadata: { userId }, meta });
    });
  }
}
