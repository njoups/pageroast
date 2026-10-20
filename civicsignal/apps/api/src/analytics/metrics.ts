/** Pure metric formulas (docs/ANALYTICS_METHODOLOGY.md). Every function documents its denominator. */

export const SENTIMENT_KNOWN = ['positive', 'negative', 'neutral', 'mixed'] as const;
export interface SentimentCounts { positive: number; negative: number; neutral: number; mixed: number; unknown: number; unanalysed: number; uncertain: number }

export const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/**
 * Sentiment proportions. Denominator = positive + negative + neutral + mixed (known labels). `unknown` and records not yet
 * analysed are excluded and reported separately. `uncertain` counts low-confidence labels among the known ones; a
 * confident-only view uses only labels that are not uncertain (`confidentShares`, given those counts).
 */
export function sentimentShares(c: SentimentCounts) {
  const known = c.positive + c.negative + c.neutral + c.mixed;
  return {
    denominator: known,
    shares: { positive: pct(c.positive, known), negative: pct(c.negative, known), neutral: pct(c.neutral, known), mixed: pct(c.mixed, known) },
    excluded: { unknown: c.unknown, unanalysed: c.unanalysed },
    uncertainShare: pct(c.uncertain, known),
    net: known ? Math.round(((c.positive - c.negative) / known) * 1000) / 10 : null,   // percentage points
  };
}

/**
 * Share of voice among a selected entity group.
 *   SoV(e) = articles mentioning e / Σ_{e' in group} articles mentioning e' × 100
 * Each eligible article counts once per selected entity it mentions, so shares sum to 100%. Articles mentioning several
 * selected entities are counted for each (reported as `coMentionArticles`); `eligibleArticles` is the number of distinct
 * articles mentioning at least one selected entity.
 */
export function shareOfVoice(perEntity: Array<{ id: string; articles: number }>, eligibleArticles: number) {
  const denominator = perEntity.reduce((n, e) => n + e.articles, 0);
  return {
    denominator, eligibleArticles, coMentionArticles: Math.max(0, denominator - eligibleArticles),
    entities: perEntity.map((e) => ({ ...e, share: pct(e.articles, denominator) })),
  };
}

/** Change from previous to current; null when the previous value is 0 (undefined growth). */
export const change = (cur: number, prev: number) => ({ current: cur, previous: prev, delta: cur - prev, pct: prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null });

/** Simpson diversity of publisher shares: 1 − Σ p². 0 = one publisher; approaches 1 as coverage spreads evenly. */
export function simpsonDiversity(counts: number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  return Math.round((1 - counts.reduce((s, c) => s + (c / total) ** 2, 0)) * 1000) / 1000;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
