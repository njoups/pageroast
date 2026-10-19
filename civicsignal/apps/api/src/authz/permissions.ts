/** Single source of truth for tenant roles and permissions. docs/SECURITY.md mirrors this (test-enforced). */
export const ROLES = ['owner', 'admin', 'project_manager', 'analyst', 'report_viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:read', 'org:update',
  'members:read', 'members:invite', 'members:update_role', 'members:remove',
  'projects:read', 'projects:create', 'projects:update', 'projects:archive', 'projects:delete', 'projects:manage_members',
  'audit:read',
  // Reserved for later milestones; listed now so the matrix is reviewed once.
  'sources:read', 'sources:manage', 'mentions:read', 'alerts:read', 'alerts:acknowledge', 'alerts:manage',
  'reports:read', 'reports:generate', 'billing:read', 'billing:manage', 'retention:manage', 'data:export', 'data:delete',
  'analysis:reprocess', 'ai:settings',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const PM: Permission[] = [
  'org:read', 'members:read',
  'projects:read', 'projects:create', 'projects:update', 'projects:archive', 'projects:manage_members',
  'sources:read', 'sources:manage', 'mentions:read', 'alerts:read', 'alerts:acknowledge', 'alerts:manage',
  'reports:read', 'reports:generate', 'analysis:reprocess',
];
const ANALYST: Permission[] = [
  'org:read', 'members:read', 'projects:read', 'sources:read', 'mentions:read',
  'alerts:read', 'alerts:acknowledge', 'reports:read', 'reports:generate',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS.filter((p) => p !== 'billing:manage' && p !== 'data:delete')),
  project_manager: new Set(PM),
  analyst: new Set(ANALYST),
  report_viewer: new Set<Permission>(['org:read', 'projects:read', 'reports:read']),
};

export const hasPermission = (role: Role, p: Permission): boolean => ROLE_PERMISSIONS[role].has(p);

/** Owners and admins see every project; other roles only see projects they are assigned to. */
export const seesAllProjects = (role: Role): boolean => role === 'owner' || role === 'admin';

const PRIVILEGED: ReadonlySet<Role> = new Set(['owner', 'admin']);

/**
 * Role-change rule: only owners may grant or revoke owner/admin. Admins may move members among the
 * non-privileged roles. (Last-owner protection is enforced in the service, which needs a DB count.)
 */
export function canAssignRole(actor: Role, targetCurrent: Role, next: Role): boolean {
  if (actor === 'owner') return true;
  if (actor !== 'admin') return false;
  return !PRIVILEGED.has(targetCurrent) && !PRIVILEGED.has(next);
}

/** Who may remove a member holding `target`. */
export const canRemoveMember = (actor: Role, target: Role): boolean =>
  actor === 'owner' || (actor === 'admin' && !PRIVILEGED.has(target));

export function renderMatrixMarkdown(): string {
  const head = `| Permission | ${ROLES.join(' | ')} |\n|---|${ROLES.map(() => ':-:').join('|')}|`;
  const rows = PERMISSIONS.map((p) => `| \`${p}\` | ${ROLES.map((r) => (hasPermission(r, p) ? '✔' : '')).join(' | ')} |`);
  return [head, ...rows].join('\n') +
    '\n\nPlatform administrators hold **no** tenant permissions. Project-scoped reads for project_manager, analyst ' +
    'and report_viewer are further limited to projects they are assigned to.';
}
