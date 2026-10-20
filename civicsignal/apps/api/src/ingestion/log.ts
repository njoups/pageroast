import { redact } from '../common/redact';

/**
 * Structured JSON log lines (one object per line) for the API, worker and pipeline. Fields pass through redaction
 * (credential-like keys, URL userinfo, bearer tokens, secret query parameters); still never pass article bodies or
 * personal data. Lines carry the deployment environment and, where available, a request id for correlation.
 */
export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'test' && process.env.INGESTION_LOG !== 'true') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, env: process.env.APP_ENV || undefined, ...(redact(fields) as Record<string, unknown>) });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
