import type { SafeHttpClient } from '../safe-http';

/** Error taxonomy shared by all connectors. `retryable` drives queue behaviour; `kind` drives health and UI. */
export type ConnectorErrorKind =
  | 'network' | 'timeout' | 'server' | 'rate_limited'            // transient → retried with backoff
  | 'auth' | 'forbidden' | 'not_found' | 'malformed' | 'unsafe'   // permanent until someone changes something
  | 'unconfigured' | 'quota' | 'http';

const RETRYABLE = new Set<ConnectorErrorKind>(['network', 'timeout', 'server', 'rate_limited']);

export class ConnectorError extends Error {
  constructor(readonly kind: ConnectorErrorKind, message: string, readonly opts: { httpStatus?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ConnectorError';
  }
  get retryable(): boolean { return RETRYABLE.has(this.kind); }
}

/** A record as delivered by a connector, before licence filtering, canonicalisation and deduplication. */
export interface RawRecord {
  url: string;
  title: string;
  summary: string | null;
  content: string | null;
  author: string | null;
  categories: string[];
  publishedAt: Date | null;
  publishedRaw: string | null;
  guid: string | null;
  language: string | null;
  publisher: string | null;
  extra?: Record<string, unknown>;          // connector-specific provenance (e.g. GDELT seen date)
}

export interface FetchContext<C> {
  config: C;
  url: string | null;                       // sources.feed_url
  http: SafeHttpClient;
  cache: { etag: string | null; lastModified: string | null };
  credentials: string | null;
  signal?: AbortSignal;
}

export interface FetchResult {
  status: 'ok' | 'not_modified';
  httpStatus: number;
  records: RawRecord[];
  rejected: Array<{ index: number; reason: string }>;
  cache: { etag: string | null; lastModified: string | null; validUntil: Date | null };
  meta: { title: string | null; language: string | null; format: string };
}

export interface Connector<C = unknown> {
  readonly kind: 'feed' | 'gdelt';
  readonly version: string;
  readonly requiresCredentials: boolean;
  readonly requiresUrl: boolean;
  /** Throws ConnectorError('unconfigured') with a human-readable message when config is invalid. */
  validateConfig(raw: unknown): C;
  fetch(ctx: FetchContext<C>): Promise<FetchResult>;
}

/** Maps HTTP status codes to the connector error taxonomy. Never retries 401/403: we do not work around access control. */
export function errorForStatus(status: number, retryAfter: string | string[] | undefined, what: string): ConnectorError {
  const ra = parseRetryAfter(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
  if (status === 429) return new ConnectorError('rate_limited', `${what} rate-limited the request (HTTP 429)`, { httpStatus: status, retryAfterMs: ra });
  if (status === 401) return new ConnectorError('auth', `${what} rejected our credentials (HTTP 401)`, { httpStatus: status });
  if (status === 403 || status === 451) return new ConnectorError('forbidden', `${what} refused access (HTTP ${status}); access controls are not bypassed`, { httpStatus: status });
  if (status === 404 || status === 410) return new ConnectorError('not_found', `${what} no longer exists (HTTP ${status})`, { httpStatus: status });
  if (status >= 500) return new ConnectorError('server', `${what} returned a server error (HTTP ${status})`, { httpStatus: status, retryAfterMs: ra });
  return new ConnectorError('http', `${what} returned HTTP ${status}`, { httpStatus: status });
}

export function parseRetryAfter(v: string | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 6 * 3600) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.min(Math.max(t - now, 0), 6 * 3600 * 1000);
}

/**
 * Honour Cache-Control max-age / Expires as a "do not refetch before" hint, capped (default 1 hour). The cap exists
 * because live news feeds are sometimes served with CDN defaults such as max-age=5184000 (60 days, observed on a real
 * Indonesian feed); conditional requests (ETag / Last-Modified) still avoid re-downloading unchanged feeds.
 */
export const MAX_CACHE_SECONDS = Number(process.env.INGESTION_MAX_CACHE_SECONDS ?? 3600);
export function cacheValidUntil(headers: Record<string, string | string[] | undefined>, now = Date.now(), capSeconds = MAX_CACHE_SECONDS): Date | null {
  const cc = ([] as string[]).concat(headers['cache-control'] ?? []).join(', ');
  if (/no-store|no-cache/i.test(cc)) return null;
  const m = /max-age=(\d+)/i.exec(cc);
  if (m) return new Date(now + Math.min(Number(m[1]), capSeconds) * 1000);
  const exp = Date.parse(String(headers.expires ?? ''));
  return Number.isNaN(exp) || exp <= now ? null : new Date(Math.min(exp, now + capSeconds * 1000));
}
