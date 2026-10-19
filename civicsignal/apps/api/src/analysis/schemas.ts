import { z } from 'zod/v4';

/**
 * Structured-output contracts shared by every provider. The JSON schema sent to the model has no numeric/length
 * constraints (kept within what structured outputs accept); ranges and evidence checks are enforced afterwards in
 * sanitize*(), which treats model output as untrusted.
 */
export const ENTITY_TYPES = ['organization', 'government_institution', 'public_figure', 'location', 'product_brand', 'event', 'policy_program', 'other'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const SENTIMENT_LABELS = ['positive', 'negative', 'neutral', 'mixed', 'unknown'] as const;

const Sentiment = z.object({
  label: z.enum(SENTIMENT_LABELS),
  confidence: z.number(),
  uncertain: z.boolean(),
  target: z.object({ type: z.enum(['article', 'entity', 'topic']), name: z.string().nullable() }),
  evidence: z.array(z.string()),
  rationale: z.string(),
});

export const ArticleAnalysisSchema = z.object({
  entities: z.array(z.object({
    type: z.enum(ENTITY_TYPES), name: z.string(), aliases: z.array(z.string()), evidence: z.string(), confidence: z.number(),
  })),
  topics: z.array(z.object({ key: z.string(), confidence: z.number(), evidence: z.array(z.string()) })),
  sentiment: Sentiment,
  entitySentiments: z.array(z.object({
    entity: z.string(), label: z.enum(SENTIMENT_LABELS), confidence: z.number(), uncertain: z.boolean(), evidence: z.array(z.string()),
  })),
  summary: z.object({
    status: z.enum(['ok', 'insufficient_evidence']),
    claims: z.array(z.object({ text: z.string(), kind: z.enum(['source_fact', 'interpretation']), quote: z.string().nullable() })),
    uncertainty: z.array(z.string()),
  }),
  taxonomyVersion: z.string(),
});
export type ArticleAnalysis = z.infer<typeof ArticleAnalysisSchema>;

/** Multi-record summaries (cluster, project, period). Records are referenced by short refs ("R1"), never by raw ids. */
export const MultiSummarySchema = z.object({
  status: z.enum(['ok', 'insufficient_evidence']),
  headline: z.string().nullable(),
  claims: z.array(z.object({ text: z.string(), kind: z.enum(['source_fact', 'interpretation']), supportingRefs: z.array(z.string()) })),
  conflicts: z.array(z.object({ description: z.string(), supportingRefs: z.array(z.string()) })),
  uncertainty: z.array(z.string()),
});
export type MultiSummary = z.infer<typeof MultiSummarySchema>;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 1000) / 1000)) : 0);
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
/** Evidence must literally occur in the text the model was given (whitespace/case-insensitive). */
export const occursIn = (needle: string, haystack: string) => needle.trim().length >= 2 && norm(haystack).includes(norm(needle));

export interface SanitizeReport { droppedEntities: number; droppedEvidence: number; droppedTopics: number; droppedClaims: number; forcedUncertain: boolean }

/**
 * Enforces the evidence contract on any provider's output:
 *  - entities without a verbatim evidence span are dropped (no hallucinated entities)
 *  - evidence quotes that do not occur in the source are removed
 *  - unknown topic keys are dropped; nothing left → 'unknown' (never forced into a category)
 *  - source_fact claims need a verbatim quote, otherwise they are dropped
 *  - confidences are clamped; sentiment below 0.6, or non-neutral without evidence, is marked uncertain
 */
export function sanitizeArticleAnalysis(a: ArticleAnalysis, sourceText: string, allowedTopics: Set<string>): { analysis: ArticleAnalysis; report: SanitizeReport } {
  const report: SanitizeReport = { droppedEntities: 0, droppedEvidence: 0, droppedTopics: 0, droppedClaims: 0, forcedUncertain: false };
  const keepEvidence = (ev: string[]) => { const kept = ev.filter((e) => occursIn(e, sourceText)); report.droppedEvidence += ev.length - kept.length; return kept.slice(0, 8); };
  const entities = a.entities.filter((e) => {
    const ok = e.name.trim().length > 0 && e.name.length <= 200 && occursIn(e.evidence, sourceText);
    if (!ok) report.droppedEntities++;
    return ok;
  }).slice(0, 40).map((e) => ({ ...e, name: e.name.trim(), aliases: e.aliases.filter((x) => x.trim() && x.length <= 200).slice(0, 10), confidence: clamp01(e.confidence) }));
  let topics = a.topics.filter((t) => { const ok = allowedTopics.has(t.key) && t.key !== 'unknown'; if (!ok && t.key !== 'unknown') report.droppedTopics++; return ok; })
    .slice(0, 5).map((t) => ({ key: t.key, confidence: clamp01(t.confidence), evidence: keepEvidence(t.evidence) }));
  if (topics.length === 0) topics = [{ key: 'unknown', confidence: 0, evidence: [] }];
  const sEvidence = keepEvidence(a.sentiment.evidence);
  const sConf = clamp01(a.sentiment.confidence);
  const uncertain = a.sentiment.uncertain || sConf < 0.6 || (a.sentiment.label !== 'neutral' && a.sentiment.label !== 'unknown' && sEvidence.length === 0);
  if (uncertain && !a.sentiment.uncertain) report.forcedUncertain = true;
  const knownNames = new Set(entities.map((e) => e.name.toLowerCase()));
  const entitySentiments = a.entitySentiments.filter((s) => knownNames.has(s.entity.trim().toLowerCase())).slice(0, 20)
    .map((s) => { const ev = keepEvidence(s.evidence); const c = clamp01(s.confidence); return { ...s, entity: s.entity.trim(), confidence: c, evidence: ev, uncertain: s.uncertain || c < 0.6 || ev.length === 0 }; });
  const claims = a.summary.claims.filter((c) => {
    const ok = c.text.trim().length > 0 && (c.kind === 'interpretation' || (c.quote !== null && occursIn(c.quote, sourceText)));
    if (!ok) report.droppedClaims++;
    return ok;
  }).slice(0, 8);
  const summary = claims.length === 0 ? { status: 'insufficient_evidence' as const, claims: [], uncertainty: a.summary.uncertainty.slice(0, 5) } : { ...a.summary, claims, uncertainty: a.summary.uncertainty.slice(0, 5) };
  return {
    analysis: {
      ...a, entities, topics, entitySentiments, summary,
      sentiment: { ...a.sentiment, confidence: sConf, evidence: sEvidence, uncertain, rationale: a.sentiment.rationale.slice(0, 500) },
    },
    report,
  };
}

/** Maps refs back to record ids; claims or conflicts without at least one valid ref are dropped. */
export function sanitizeMultiSummary(s: MultiSummary, refs: Map<string, string>) {
  const map = (rs: string[]) => [...new Set(rs.map((r) => refs.get(r.trim().toUpperCase())).filter((x): x is string => !!x))];
  let dropped = 0;
  const claims = s.claims.map((c) => ({ text: c.text.trim(), kind: c.kind, supportingMentionIds: map(c.supportingRefs) }))
    .filter((c) => { const ok = c.text.length > 0 && c.supportingMentionIds.length > 0; if (!ok) dropped++; return ok; }).slice(0, 12);
  const conflicts = s.conflicts.map((c) => ({ description: c.description.trim(), supportingMentionIds: map(c.supportingRefs) }))
    .filter((c) => c.description && c.supportingMentionIds.length >= 1).slice(0, 6);
  const status = claims.length === 0 ? 'insufficient_evidence' as const : s.status;
  return { status, headline: status === 'ok' ? s.headline?.trim().slice(0, 200) || null : null, claims, conflicts, uncertainty: s.uncertainty.slice(0, 6), droppedClaims: dropped };
}
