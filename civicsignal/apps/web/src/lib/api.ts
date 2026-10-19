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

// ── Ingestion ──────────────────────────────────────────────────────────────────────────────────────
export type Health = 'unknown' | 'healthy' | 'degraded' | 'failing' | 'disabled';
export interface SourceError { kind: string; message: string; httpStatus: number | null; at?: string; runId?: string; retryable?: boolean }
export interface Source {
  id: string; name: string; domain: string; category: string; collectionMethod: string; feedUrl: string | null; enabled: boolean;
  authorizationStatus: 'unverified' | 'authorized' | 'restricted' | 'revoked'; authorizationBasis: string | null;
  verificationStatus: 'unverified' | 'verified'; permittedFields: string[]; permitsFullText: boolean; refreshIntervalSeconds: number;
  rateLimitPerMinute: number | null; quotaPerDay: number | null; licenseTerms: string | null; usageRestrictions: string | null;
  redistributionRestrictions: string | null; retentionDays: number | null; attributionRequirement: string | null;
  lastSuccessAt: string | null; lastAttemptAt: string | null; lastError: SourceError | null; recordsCollected: number;
  consecutiveFailures: number; health: Health; schedule: { active: boolean; nextDueAt: string | null };
  connector: { id: string; kind: 'feed' | 'gdelt'; config: Record<string, unknown>; status: string; verifiedAt: string | null; version: string | null;
    requiresCredentials: boolean; credentials: { configured: boolean; hint: string | null; updatedAt: string | null } };
  createdAt: string; updatedAt: string;
}
export interface Run {
  id: string; status: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'dead_lettered'; trigger: string; attempt: number;
  records_seen: number; records_new: number; records_known: number; records_duplicate: number; records_rejected: number; matches: number;
  http_status: number | null; not_modified: boolean; rate_limited: boolean; duration_ms: number | null; error: SourceError | null;
  stages: Record<string, string>; rejections: Array<{ reason: string; index?: number }>; created_at: string; started_at: string | null;
  finished_at: string | null; requested_by_name: string | null;
}
export interface MentionMatch { projectId: string; projectName: string; queryId: string; queryName: string; terms: string[] }
export interface Mention {
  id: string; title: string; url: string; canonical_url: string; publisher: string | null; publisher_domain: string; excerpt: string | null;
  author: string | null; categories: string[]; language: string | null; published_at: string | null; discovered_at: string; last_seen_at: string;
  source_id: string; source_name: string; source_type: string; duplicate_status: 'original' | 'duplicate' | 'near_duplicate';
  duplicate_of: string | null; duplicate_reason: string | null; processing_status: string; availability: string;
  attribution: string | null; redistribution_restrictions: string | null; connector: string; gdelt_seen_at: string | null;
  matches: MentionMatch[]; dataOrigin: 'live';
}
export interface MonitoringQuery {
  id: string; project_id: string; name: string; keywords: string[]; aliases: string[]; exclusions: string[]; boolean_expression: string | null;
  languages: string[]; is_active: boolean; match_count: number; created_at: string; updated_at: string;
}

export const HEALTH_TONE: Record<Health, 'green' | 'amber' | 'red' | 'slate'> = { healthy: 'green', degraded: 'amber', failing: 'red', unknown: 'slate', disabled: 'slate' };
export const HEALTH_LABEL: Record<Health, string> = { healthy: 'Healthy', degraded: 'Degraded', failing: 'Failing', unknown: 'Not yet collected', disabled: 'Disabled' };
export const KIND_LABEL: Record<string, string> = { feed: 'RSS / Atom feed', gdelt: 'GDELT DOC 2.0 (open data)' };

export function relTime(s: string | null): string {
  if (!s) return 'never';
  const d = (Date.now() - new Date(s).getTime()) / 1000;
  const f = (n: number, u: string) => `${Math.round(n)} ${u}${Math.round(n) === 1 ? '' : 's'}`;
  const abs = Math.abs(d); const suffix = d >= 0 ? 'ago' : 'from now';
  if (abs < 60) return d >= 0 ? 'just now' : 'in under a minute';
  if (abs < 3600) return `${f(abs / 60, 'minute')} ${suffix}`;
  if (abs < 86400) return `${f(abs / 3600, 'hour')} ${suffix}`;
  return `${f(abs / 86400, 'day')} ${suffix}`;
}

export const canIngest = {
  readSources: (r: Role) => r !== 'report_viewer',
  manageSources: (r: Role) => r === 'owner' || r === 'admin' || r === 'project_manager',
  readMentions: (r: Role) => r !== 'report_viewer',
};
