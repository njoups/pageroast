/** Structured JSON log lines (one object per line) for the worker and pipeline. Never pass secrets or full URLs with queries. */
export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'test' && process.env.INGESTION_LOG !== 'true') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
