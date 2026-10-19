import { createHash } from 'node:crypto';
import { tokenize } from './query';

/** Headline normalised for publisher+headline matching: tokenised, joined with single spaces. */
export const normalizeTitle = (title: string): string => tokenize(title).join(' ');

/** Exact-content fingerprint over normalised headline and permitted excerpt. */
export function contentHash(title: string, excerpt: string | null): string {
  return createHash('sha256').update(`${normalizeTitle(title)}\n${tokenize(excerpt ?? '').join(' ')}`).digest('hex');
}

/** Jaccard similarity of headline token sets. */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean)); const B = new Set(b.split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface DedupCandidate { id: string; publisherDomain: string; normalizedTitle: string; contentHash: string }
export interface DedupDecision { status: 'original' | 'duplicate' | 'near_duplicate'; duplicateOf: string | null; reason: string | null }

/**
 * Within-publisher duplicate detection for a record whose canonical URL is new. Records from *different* publishers are
 * never merged, even with identical text (syndicated wire copy keeps separate provenance). Duplicates are still stored,
 * flagged and linked, never deleted.
 *   1. same publisher + identical content hash          → duplicate (content_hash)
 *   2. same publisher + identical normalised headline   → duplicate (publisher_headline)
 *   3. same publisher + headline similarity ≥ threshold → near_duplicate (title_similarity), only for headlines of
 *      at least `minTokens` words so short generic titles ("Live update") are not merged
 */
export function decideDuplicate(
  rec: { publisherDomain: string; normalizedTitle: string; contentHash: string },
  candidates: DedupCandidate[],
  opts: { similarityThreshold: number; minTokens: number },
): DedupDecision {
  const same = candidates.filter((c) => c.publisherDomain === rec.publisherDomain);
  const byHash = same.find((c) => c.contentHash === rec.contentHash);
  if (byHash) return { status: 'duplicate', duplicateOf: byHash.id, reason: 'content_hash' };
  const byTitle = same.find((c) => c.normalizedTitle === rec.normalizedTitle && rec.normalizedTitle.length > 0);
  if (byTitle) return { status: 'duplicate', duplicateOf: byTitle.id, reason: 'publisher_headline' };
  if (opts.similarityThreshold > 0 && rec.normalizedTitle.split(' ').length >= opts.minTokens) {
    let best: DedupCandidate | null = null; let bestScore = 0;
    for (const c of same) {
      const s = titleSimilarity(rec.normalizedTitle, c.normalizedTitle);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best && bestScore >= opts.similarityThreshold) return { status: 'near_duplicate', duplicateOf: best.id, reason: `title_similarity:${bestScore.toFixed(2)}` };
  }
  return { status: 'original', duplicateOf: null, reason: null };
}
