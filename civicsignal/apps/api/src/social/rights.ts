/** Provider rights snapshot stored on social connectors (copied from social/providers.ts). Empty for news connectors. */
export interface SourceRights { storageMaxDays?: number | null; refreshWithinDays?: number | null; deletionOnRequestDays?: number | null; derivedAnalysis?: string; metricAggregation?: string }

/**
 * Whether derived analysis (AI entities, topics, sentiment, summaries) may run on a source's records. News sources
 * carry no provider rights snapshot and are governed by their licence fields. 'requires_approval' needs an operator's
 * recorded approval on the connector; 'not_permitted' and 'unverified' never run.
 */
export function derivedAnalysisAllowed(src: { rights: SourceRights | null | undefined; derived_analysis_approved_at: Date | null | undefined }): boolean {
  const d = src.rights?.derivedAnalysis;
  if (!d || d === 'permitted') return true;
  if (d === 'requires_approval') return !!src.derived_analysis_approved_at;
  return false;
}
