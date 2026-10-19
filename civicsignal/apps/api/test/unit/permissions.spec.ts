import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canAssignRole, canRemoveMember, hasPermission, PERMISSIONS, renderMatrixMarkdown, ROLES } from '../../src/authz/permissions';

describe('permission matrix', () => {
  it('owner holds every permission', () => {
    for (const p of PERMISSIONS) expect(hasPermission('owner', p)).toBe(true);
  });

  it('report_viewer is read-only on reports and cannot see members or audit', () => {
    expect(hasPermission('report_viewer', 'reports:read')).toBe(true);
    for (const p of ['members:read', 'audit:read', 'projects:create', 'reports:generate'] as const) expect(hasPermission('report_viewer', p)).toBe(false);
  });

  it('only owner/admin can delete projects, read audit, or manage members', () => {
    for (const r of ROLES) {
      const privileged = r === 'owner' || r === 'admin';
      expect(hasPermission(r, 'projects:delete')).toBe(privileged);
      expect(hasPermission(r, 'audit:read')).toBe(privileged);
      expect(hasPermission(r, 'members:update_role')).toBe(privileged);
    }
  });

  it('admin cannot manage billing or delete tenant data', () => {
    expect(hasPermission('admin', 'billing:manage')).toBe(false);
    expect(hasPermission('admin', 'data:delete')).toBe(false);
  });

  it('role assignment prevents escalation by admins', () => {
    expect(canAssignRole('admin', 'analyst', 'project_manager')).toBe(true);
    expect(canAssignRole('admin', 'analyst', 'admin')).toBe(false);
    expect(canAssignRole('admin', 'analyst', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'admin', 'analyst')).toBe(false);
    expect(canAssignRole('admin', 'owner', 'analyst')).toBe(false);
    expect(canAssignRole('owner', 'analyst', 'owner')).toBe(true);
    expect(canAssignRole('project_manager', 'analyst', 'report_viewer')).toBe(false);
    expect(canRemoveMember('admin', 'admin')).toBe(false);
    expect(canRemoveMember('admin', 'analyst')).toBe(true);
    expect(canRemoveMember('owner', 'admin')).toBe(true);
  });

  it('docs/SECURITY.md matrix is in sync with code', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'SECURITY.md'), 'utf8');
    const block = doc.split('<!-- MATRIX:START -->')[1]?.split('<!-- MATRIX:END -->')[0]?.trim();
    expect(block).toBe(renderMatrixMarkdown());
  });
});
