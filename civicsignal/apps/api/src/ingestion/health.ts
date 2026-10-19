export type Health = 'unknown' | 'healthy' | 'degraded' | 'failing' | 'disabled';

export interface HealthInput {
  enabled: boolean;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  lastErrorKind: string | null;
  refreshIntervalSeconds: number;
  now?: Date;
}

export const FAILING_AFTER = 3;
const FATAL = new Set(['auth', 'unconfigured', 'forbidden', 'unsafe', 'not_found']);

/**
 * Health is derived only from collection results. A source that has never been attempted is `unknown`, never healthy.
 *  - disabled: collection switched off
 *  - failing: ≥3 consecutive failures, or a non-transient failure (auth, unconfigured, forbidden, unsafe, not found)
 *  - degraded: last attempt failed transiently, or no success for more than 3 refresh intervals (collection lag)
 *  - healthy: last attempt succeeded and data is fresh
 */
export function computeHealth(h: HealthInput): Health {
  if (!h.enabled) return 'disabled';
  if (!h.lastAttemptAt) return 'unknown';
  if (h.consecutiveFailures >= FAILING_AFTER) return 'failing';
  if (h.consecutiveFailures > 0) return h.lastErrorKind && FATAL.has(h.lastErrorKind) ? 'failing' : 'degraded';
  const now = (h.now ?? new Date()).getTime();
  if (!h.lastSuccessAt || now - h.lastSuccessAt.getTime() > 3 * h.refreshIntervalSeconds * 1000) return 'degraded';
  return 'healthy';
}
