export type Role = 'owner' | 'admin' | 'project_manager' | 'analyst' | 'report_viewer';
export interface Org { id: string; name: string; slug: string; role: Role; settings?: Record<string, string> }
export interface Me {
  user: { id: string; email: string; displayName: string; isPlatformAdmin: boolean };
  organizations: Org[];
  identityProvider: { name: string; mfa: boolean; passwordRecovery: boolean };
}
export interface Project {
  id: string; name: string; objective: string; status: 'active' | 'archived'; languages: string[];
  date_range_start: string | null; date_range_end: string | null; created_at: string; updated_at: string; member_count?: number;
}
export interface Member { user_id: string; role: Role; email: string; display_name: string; created_at: string }
export interface AuditEvent {
  id: string; action: string; target_type: string | null; target_id: string | null; metadata: Record<string, unknown>;
  ip: string | null; occurred_at: string; actor_name: string | null; actor_email: string | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const d = Array.isArray(e.details) ? e.details as Array<{ field?: string; problems?: string[] }> : [];
    const extra = d.map((x) => x.problems?.join(', ')).filter(Boolean).join('; ');
    return extra ? `${e.message}: ${extra}` : e.message;
  }
  return 'Network error — is the API running?';
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner', admin: 'Administrator', project_manager: 'Project manager', analyst: 'Analyst', report_viewer: 'Report viewer',
};

/** UI hints only. The API enforces every permission server-side. */
export const can = {
  manageMembers: (r: Role) => r === 'owner' || r === 'admin',
  readMembers: (r: Role) => r !== 'report_viewer',
  createProject: (r: Role) => r === 'owner' || r === 'admin' || r === 'project_manager',
  deleteProject: (r: Role) => r === 'owner' || r === 'admin',
  readAudit: (r: Role) => r === 'owner' || r === 'admin',
  updateOrg: (r: Role) => r === 'owner' || r === 'admin',
};

export const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/**
 * Post-login redirect target: only same-origin paths. Rejects '//host', '/\\host' (browsers normalise '\\' to '/'),
 * and anything that resolves to another origin.
 */
export function safeNextPath(next: string | null, origin: string): string {
  if (!next || !next.startsWith('/') || next.includes('\\')) return '/';
  try {
    const u = new URL(next, origin);
    const path = `${u.pathname}${u.search}${u.hash}`;
    // '/.//evil.com' normalises to pathname '//evil.com', which the router would treat as protocol-relative.
    return u.origin === origin && !path.startsWith('//') ? path : '/';
  } catch { return '/'; }
}

export const parseLanguages = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
