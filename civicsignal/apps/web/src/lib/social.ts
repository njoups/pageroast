import type { Health, Role } from './api';

export interface OperationDetail { operation: string; label: string; supported: boolean; reason: string | null }
export interface ProviderInfo {
  provider: string; displayName: string; kind: string | null; implementation: 'implemented' | 'not_implemented';
  access: 'available' | 'requires_credentials' | 'requires_contract' | 'research_only' | 'unverified'; liveVerified: boolean; relevance: string;
  auth: { method: string; credentialLabel: string | null; setup: string[] };
  operationsDetail: OperationDetail[]; contentTypes: string[]; fields: string[]; metrics: string[]; historicalCoverage: string;
  limits: { maxResultsPerRequest: number | null; maxPagesPerSync: number | null; minRefreshIntervalSeconds: number };
  quota: { buckets: Array<{ key: string; label: string; perDay: number | null; costNote: string }>; resetTimeZone: string | null; resetNote: string };
  pricing: { model: string; note: string };
  rights: { storageMaxDays: number | null; refreshWithinDays: number | null; deletionOnRequestDays: number | null; derivedAnalysis: string; derivedAnalysisNote: string;
    metricAggregation: string; redistribution: string; attribution: string; commercialUse: string };
  limitations: string[]; docs: Array<{ title: string; url: string }>; verifiedAt: string | null; connectors: number;
}
export interface QuotaBucketState { key: string; label: string; limit: number | null; used: number; remaining: number | null; requests: number }
export interface SocialConnector {
  id: string; connectorId: string; name: string; provider: string; providerName: string; kind: string; enabled: boolean;
  authorizationStatus: string; authorizationBasis: string | null; config: Record<string, unknown>; permittedFields: string[];
  refreshIntervalSeconds: number; retentionDays: number | null;
  credentials: { required: boolean; label: string | null; configured: boolean; hint: string | null; updatedAt: string | null };
  connectionStatus: string; connectionVerifiedAt: string | null; health: Health;
  lastSuccessAt: string | null; lastAttemptAt: string | null; lastError: { kind: string; message: string } | null; consecutiveFailures: number;
  recordsCollected: number; recordsStored: number; schedule: { active: boolean; nextDueAt: string | null };
  paused: { until: string; reason: string } | null;
  quota: { provider: string; day: string; resetsAt: string | null; buckets: QuotaBucketState[]; exhausted: boolean };
  rights: { storageMaxDays?: number | null; derivedAnalysis?: string; derivedAnalysisAllowed: boolean; approval: { approvedAt: string; reference: string } | null;
    attribution: string | null; redistribution: string | null };
  lifecycle: { lastRun: Record<string, unknown> | null; refreshDue: number; pastDeletionDeadline: number };
  notices: Array<{ id: string; level: string; metric: string; period_key: string; value: string; threshold: string; created_at: string }>;
  capabilities: OperationDetail[];
}
export interface SocialRun { id: string; status: string; trigger: string; records_seen: number | null; records_new: number | null; records_rejected: number | null;
  matches: number | null; error: { kind: string; message: string } | null; created_at: string; finished_at: string | null }
export interface SocialUsage {
  windowDays: number; provider: string; quotaModel: string;
  days: Array<{ day: string; bucket: string; requests: number; units: number; recordsRetrieved: number; recordsRejected: number; rateLimited: number }>;
  totals: { requests: number; units: number; recordsRetrieved: number; recordsRejected: number; rateLimited: number };
  storage: { records: number; approxBytes: number }; processing: { analyses: number; tokens: number };
  cost: { status: 'estimated' | 'not_priced' | 'incomplete'; amount: number | null; currency: string | null; basis: string[]; verifiedAt: string | null };
  definitions: Record<string, string>;
}
export interface SentimentGroup { platform: string; contentType: string; records: number; analysed: number; confident: number; uncertain: number;
  notPermitted: number; shortText: number; counts: Record<string, number>; shares: Record<string, number | null> }
export interface SocialAnalytics {
  period: { from: string; to: string; timezone: string; granularity: string };
  totals: { records: number; analysed: number; withHashtags: number };
  volume: Array<{ platform: string; contentType: string; records: number; share: number | null }>;
  trend: { platforms: string[]; points: Array<Record<string, number | string>> };
  sentiment: SentimentGroup[];
  conversations: Array<{ parentExternalId: string; title: string | null; url: string | null; comments: number; analysed: number; uncertain: number; counts: Record<string, number> }>;
  hashtags: Array<{ tag: string; records: number; share: number | null }>;
  topics: Array<{ topic: string; label: string; records: number; share: number | null }>;
  engagement: Array<{ platform: string; records: number; aggregation: string; metrics: Array<{ metric: string; recordsWithMetric: number; recordsWithoutMetric: number }>;
    sortedBy: string | null; top: Array<{ id: string; title: string; url: string; content_type: string; engagement: Record<string, number>; observedAt: string }>; note: string | null }>;
  accounts: Array<{ platform: string; accounts: number; recordsWithAccountId: number; records: number }>;
  crossPlatformEntities: Array<{ entityId: string; name: string; news: number; social: number }>;
  entitySentiment: Array<{ entityId: string; name: string; results: number; uncertain: number; counts: Record<string, number> }>;
  freshness: { latestRecordDiscoveredAt: string | null; oldestMetricsObservedAt: string | null };
  definitions: Record<string, string>;
}

export const PLATFORM_LABEL: Record<string, string> = { youtube: 'YouTube' };
export const CONTENT_LABEL: Record<string, string> = { video: 'Video', short_video: 'Short video', live_stream: 'Live stream', post: 'Post', comment: 'Comment', article: 'News article' };
export const ACCESS_LABEL: Record<ProviderInfo['access'], string> = {
  available: 'Available', requires_credentials: 'Needs credentials', requires_contract: 'Needs a contract', research_only: 'Research access only', unverified: 'Not verified',
};
export const PAUSE_LABEL: Record<string, string> = {
  provider_quota: 'Provider quota exhausted', budget_soft_limit: 'Budget soft limit (scheduled syncs paused)', budget_hard_limit: 'Budget hard limit (all syncs stopped)',
};
export const canSocial = {
  read: (r: Role) => r !== 'report_viewer',
  manage: (r: Role) => r === 'owner' || r === 'admin' || r === 'project_manager',
  approve: (r: Role) => r === 'owner' || r === 'admin',          // ai:settings
};

/** Quota bar figures: used share of the limit, capped at 100; null when the provider publishes no limit. */
export function quotaPercent(b: QuotaBucketState): number | null {
  if (b.limit === null || b.limit <= 0) return null;
  return Math.min(100, Math.round((100 * b.used) / b.limit));
}

/** Human description of a connector's state, in priority order (what an operator should act on first). */
export function connectorStatus(c: SocialConnector, now = Date.now()): { label: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue'; detail: string | null } {
  if (c.authorizationStatus !== 'authorized') return { label: 'Not authorized', tone: 'amber', detail: 'Record the authorization basis and mark the connector authorized before collecting.' };
  if (!c.credentials.configured) return { label: 'Unconfigured', tone: 'amber', detail: `Add the ${c.credentials.label ?? 'credentials'} to connect.` };
  if (c.paused && new Date(c.paused.until).getTime() > now) return { label: 'Paused', tone: 'amber', detail: `${PAUSE_LABEL[c.paused.reason] ?? c.paused.reason} until ${new Date(c.paused.until).toLocaleString('en-GB')}.` };
  if (c.connectionStatus === 'failing') return { label: 'Connection failing', tone: 'red', detail: 'The last connection test failed. Re-enter the key (reauthorize) and test again.' };
  if (!c.enabled) return { label: 'Disabled', tone: 'slate', detail: c.lastSuccessAt ? null : 'Test the connection, then enable scheduled collection.' };
  if (c.health === 'failing') return { label: 'Failing', tone: 'red', detail: c.lastError?.message ?? null };
  if (c.health === 'degraded') return { label: 'Degraded', tone: 'amber', detail: c.lastError?.message ?? null };
  if (c.health === 'healthy') return { label: 'Collecting', tone: 'green', detail: null };
  return { label: 'Not yet collected', tone: 'blue', detail: null };
}

/** Cost line that never shows a figure the server could not compute. */
export function costText(u: SocialUsage['cost']): string {
  if (u.status === 'not_priced') return 'Not priced: no verified pricing is configured for this provider.';
  if (u.status === 'incomplete') return 'Incomplete: some charged items have no usage counter, so no total is shown.';
  return `${u.amount!.toLocaleString('en-GB', { maximumFractionDigits: 4 })} ${u.currency} (estimate; prices verified ${u.verifiedAt})`;
}

/** Labels for a sentiment share; an empty denominator is "no confident labels", never 0 %. */
export function shareText(share: number | null): string { return share === null ? '—' : `${share}%`; }

/** Builds the connector config sent to the API from the form (only settings the YouTube connector accepts). */
export function youtubeConfig(f: { mode: 'search' | 'channel'; query: string; channelIds: string; lookbackHours: number; maxPages: number; includeComments: boolean }): Record<string, unknown> {
  const base = { lookbackHours: f.lookbackHours, maxPages: f.maxPages, includeComments: f.includeComments };
  if (f.mode === 'search') return { mode: 'search', query: f.query.trim(), ...base };
  return { mode: 'channel', channelIds: f.channelIds.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean), ...base };
}
