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
const WORD = /[\p{L}\p{N}]/u;
/**
 * Evidence must literally occur in the text the model was given (whitespace/case-insensitive), as whole words: a
 * fragment such as "an" or "di" inside a longer word is not evidence. Minimum 4 characters for evidence spans.
 */
export function occursIn(needle: string, haystack: string, minLength = 4): boolean {
  const n = norm(needle); const h = norm(haystack);
  if (n.length < minLength) return false;
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) {
    const before = i === 0 ? '' : h[i - 1]!; const after = h[i + n.length] ?? '';
    if (!(before && WORD.test(before) && WORD.test(n[0]!)) && !(after && WORD.test(after) && WORD.test(n[n.length - 1]!))) return true;
  }
  return false;
}
/** Names (entities, aliases) may be short ("KPK", "BI") but must still occur as whole words. */
export const nameOccursIn = (name: string, haystack: string) => occursIn(name, haystack, 2);

/** Numbers in model text must occur in the supporting text ("1.000" and "1000" are the same number). */
export function unsupportedNumbers(text: string, support: string): string[] {
  const allowed = new Set(numbersIn(support));
  return numbersIn(text).filter((x) => !allowed.has(x));
}
function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d.,]*/g)) {
    let t = m[0].replace(/[.,]$/, '');
    if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, ''); else t = t.replace(',', '.');
    const v = Number(t);
    if (Number.isFinite(v)) out.push(String(v));
  }
  return out;
}
const QUOTED = /[“"«]([^”"»]{4,300})[”"»]/g;
const cap = (s: string, n: number) => s.trim().slice(0, n);

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
  const seenEntities = new Set<string>();
  const entities = a.entities.filter((e) => {
    // The name itself must occur in the source (as must its evidence), so a model cannot attach invented names or
    // attributes ("X (suspect)") to a real evidence span. Duplicates (same type and name) are kept once.
    const key = `${e.type}:${norm(e.name)}`;
    const ok = e.name.trim().length > 0 && e.name.length <= 200 && nameOccursIn(e.name, sourceText) && occursIn(e.evidence, sourceText) && !seenEntities.has(key);
    if (!ok) report.droppedEntities++; else seenEntities.add(key);
    return ok;
  }).slice(0, 40).map((e) => ({
    ...e, name: e.name.trim(), evidence: cap(e.evidence, 500), confidence: clamp01(e.confidence),
    // Aliases resolve future mentions tenant-wide, so only aliases that appear in this source are accepted.
    aliases: [...new Set(e.aliases.map((x) => x.trim()).filter((x) => x && x.length <= 200 && norm(x) !== norm(e.name) && nameOccursIn(x, sourceText)))].slice(0, 10),
  }));
  const seenTopics = new Set<string>();
  let topics = a.topics.filter((t) => {
    const ok = allowedTopics.has(t.key) && t.key !== 'unknown' && !seenTopics.has(t.key);
    if (!ok && t.key !== 'unknown' && !seenTopics.has(t.key)) report.droppedTopics++;
    if (ok) seenTopics.add(t.key);
    return ok;
  }).slice(0, 3).map((t) => ({ key: t.key, confidence: clamp01(t.confidence), evidence: keepEvidence(t.evidence) }));
  if (topics.length === 0) topics = [{ key: 'unknown', confidence: 0, evidence: [] }];
  const sEvidence = keepEvidence(a.sentiment.evidence);
  const sConf = clamp01(a.sentiment.confidence);
  const uncertain = a.sentiment.uncertain || sConf < 0.6 || (a.sentiment.label !== 'neutral' && a.sentiment.label !== 'unknown' && sEvidence.length === 0);
  if (uncertain && !a.sentiment.uncertain) report.forcedUncertain = true;
  const knownNames = new Set(entities.map((e) => e.name.toLowerCase()));
  const entitySentiments = a.entitySentiments.filter((s) => knownNames.has(s.entity.trim().toLowerCase())).slice(0, 20)
    .map((s) => { const ev = keepEvidence(s.evidence); const c = clamp01(s.confidence); return { ...s, entity: s.entity.trim(), confidence: c, evidence: ev, uncertain: s.uncertain || c < 0.6 || ev.length === 0 }; });
  // source_fact claims need a verbatim quote, and every number they state must be in that quote; interpretations may
  // not introduce numbers or quotations absent from the source.
  const claims = a.summary.claims.filter((c) => {
    const text = c.text.trim();
    let ok = text.length > 0 && text.length <= 600;
    if (ok && c.kind === 'source_fact') ok = c.quote !== null && occursIn(c.quote, sourceText) && unsupportedNumbers(text, c.quote).length === 0;
    if (ok && c.kind === 'interpretation') ok = unsupportedNumbers(text, sourceText).length === 0;
    if (ok) for (const q of text.matchAll(QUOTED)) if (!occursIn(q[1]!, sourceText)) { ok = false; break; }
    if (!ok) report.droppedClaims++;
    return ok;
  }).slice(0, 8).map((c) => ({ ...c, text: c.text.trim() }));
  const uncertainty = a.summary.uncertainty.map((u) => cap(u, 300)).filter(Boolean).slice(0, 5);
  // A summary is only "ok" when at least one claim is grounded in a verbatim source quote.
  const summary = !claims.some((c) => c.kind === 'source_fact') ? { status: 'insufficient_evidence' as const, claims, uncertainty } : { ...a.summary, claims, uncertainty };
  return {
    analysis: {
      ...a, entities, topics, entitySentiments, summary,
      sentiment: { ...a.sentiment, confidence: sConf, evidence: sEvidence, uncertain, rationale: a.sentiment.rationale.slice(0, 500) },
    },
    report,
  };
}

/**
 * Maps refs back to record ids; claims or conflicts without at least one valid ref are dropped. With `texts`
 * (record id → the title/excerpt the model was given), a claim is also dropped when it states a number or a quotation
 * that its cited records do not contain, and a headline with a number found in no record is removed.
 */
export function sanitizeMultiSummary(s: MultiSummary, refs: Map<string, string>, texts?: Map<string, string>) {
  const map = (rs: string[]) => [...new Set(rs.map((r) => refs.get(r.trim().toUpperCase())).filter((x): x is string => !!x))];
  const support = (ids: string[]) => ids.map((id) => texts?.get(id) ?? '').join('\n');
  const grounded = (text: string, ids: string[]) => {
    if (!texts) return true;
    const sup = support(ids);
    if (unsupportedNumbers(text, sup).length) return false;
    for (const q of text.matchAll(QUOTED)) if (!occursIn(q[1]!, sup)) return false;
    return true;
  };
  let dropped = 0;
  const claims = s.claims.map((c) => ({ text: cap(c.text, 600), kind: c.kind, supportingMentionIds: map(c.supportingRefs) }))
    .filter((c) => { const ok = c.text.length > 0 && c.supportingMentionIds.length > 0 && grounded(c.text, c.supportingMentionIds); if (!ok) dropped++; return ok; }).slice(0, 12);
  const conflicts = s.conflicts.map((c) => ({ description: cap(c.description, 600), supportingMentionIds: map(c.supportingRefs) }))
    .filter((c) => c.description && c.supportingMentionIds.length >= 1 && grounded(c.description, c.supportingMentionIds)).slice(0, 6);
  const status = claims.length === 0 ? 'insufficient_evidence' as const : s.status;
  const allIds = [...refs.values()];
  const headline = status === 'ok' ? cap(s.headline ?? '', 200) || null : null;
  return { status, headline: headline && grounded(headline, allIds) ? headline : null, claims, conflicts,
    uncertainty: s.uncertainty.map((u) => cap(u, 300)).filter(Boolean).slice(0, 6), droppedClaims: dropped };
}
