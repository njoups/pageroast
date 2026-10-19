import { jaccard } from './text';

export const CLUSTER_METHOD = 'headline-entity-topic/1';

export interface ClusterDoc {
  id: string;
  publisherDomain: string;
  contentHash: string;
  time: number;               // ms epoch; publication time, else discovery time
  tokens: Set<string>;        // significant headline tokens
  entities: Set<string>;      // resolved entity ids
  topics: Set<string>;        // topic keys excluding unknown/other
}
export interface PairScore { score: number; syndicated: boolean; reasons: { headline: number; sharedTokens: string[]; entities: number | null; sharedEntities: number; topic: boolean; hoursApart: number } }

/**
 * Similarity of two records as coverage of the same event. Returns null (never related) when they are outside the time
 * window or fail the gates that stop unrelated stories from merging on a single generic word.
 */
export function pairScore(a: ClusterDoc, b: ClusterDoc, windowHours: number): PairScore | null {
  const hoursApart = Math.abs(a.time - b.time) / 3_600_000;
  if (hoursApart > windowHours) return null;
  // Identical wire copy from another publisher: same event, but not independent corroboration.
  if (a.contentHash === b.contentHash && a.publisherDomain !== b.publisherDomain) {
    return { score: 1, syndicated: true, reasons: { headline: 1, sharedTokens: [], entities: null, sharedEntities: 0, topic: false, hoursApart: Math.round(hoursApart) } };
  }
  const sharedTokens = [...a.tokens].filter((t) => b.tokens.has(t));
  const sharedEntities = [...a.entities].filter((e) => b.entities.has(e)).length;
  if (sharedTokens.length < 2 && !(sharedEntities >= 1 && sharedTokens.length >= 1)) return null;
  const headline = jaccard(a.tokens, b.tokens);
  const ent = a.entities.size && b.entities.size ? jaccard(a.entities, b.entities) : null;
  const topic = [...a.topics].some((t) => b.topics.has(t));
  const raw = ent === null ? 0.8 * headline + 0.2 * (topic ? 1 : 0) : 0.55 * headline + 0.3 * ent + 0.15 * (topic ? 1 : 0);
  const decay = hoursApart <= 24 ? 1 : 1 - 0.25 * ((hoursApart - 24) / Math.max(1, windowHours - 24));
  return { score: Math.round(Math.min(1, raw * decay) * 1000) / 1000, syndicated: false, reasons: { headline: Math.round(headline * 100) / 100, sharedTokens: sharedTokens.slice(0, 8), entities: ent === null ? null : Math.round(ent * 100) / 100, sharedEntities, topic, hoursApart: Math.round(hoursApart) } };
}

export interface Candidate { doc: ClusterDoc; clusterId: string | null }
export type Decision =
  | { action: 'none' }
  | { action: 'join'; clusterId: string; score: number; pair: PairScore; mergeClusterIds: string[] }
  | { action: 'create'; withId: string; score: number; pair: PairScore };

/**
 * Average-link over a cluster's three best-matching members (not single-link, which chains unrelated stories).
 * A record that strongly matches two clusters causes them to merge (the caller records the change).
 */
export function decide(doc: ClusterDoc, candidates: Candidate[], threshold: number, windowHours: number): Decision {
  const byCluster = new Map<string, Array<{ s: PairScore }>>();
  let bestSingle: { id: string; s: PairScore } | null = null;
  for (const c of candidates) {
    if (c.doc.id === doc.id) continue;
    const s = pairScore(doc, c.doc, windowHours);
    if (!s) continue;
    if (c.clusterId) { const list = byCluster.get(c.clusterId) ?? []; list.push({ s }); byCluster.set(c.clusterId, list); }
    else if (!bestSingle || s.score > bestSingle.s.score) bestSingle = { id: c.doc.id, s };
  }
  const clusterScores = [...byCluster.entries()].map(([id, list]) => {
    const top = list.map((x) => x.s).sort((x, y) => y.score - x.score).slice(0, 3);
    return { id, score: top.reduce((n, x) => n + x.score, 0) / top.length, pair: top[0]! };
  }).sort((x, y) => y.score - x.score);
  const best = clusterScores[0];
  if (best && best.score >= threshold && (!bestSingle || best.score >= bestSingle.s.score)) {
    const mergeClusterIds = clusterScores.slice(1).filter((c) => c.score >= threshold + 0.1).map((c) => c.id);
    return { action: 'join', clusterId: best.id, score: Math.round(best.score * 1000) / 1000, pair: best.pair, mergeClusterIds };
  }
  if (bestSingle && bestSingle.s.score >= threshold) return { action: 'create', withId: bestSingle.id, score: bestSingle.s.score, pair: bestSingle.s };
  return { action: 'none' };
}

/** Member with the highest total similarity to the others; ties go to the earliest. Its real headline labels the cluster. */
export function representative(docs: ClusterDoc[], windowHours: number): ClusterDoc {
  let best = docs[0]!; let bestScore = -1;
  for (const d of docs) {
    const total = docs.reduce((n, o) => (o.id === d.id ? n : n + (pairScore(d, o, windowHours * 10)?.score ?? 0)), 0);
    if (total > bestScore || (total === bestScore && d.time < best.time)) { best = d; bestScore = total; }
  }
  return best;
}
