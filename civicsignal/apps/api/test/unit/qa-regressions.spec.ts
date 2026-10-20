import { occursIn, sanitizeArticleAnalysis, sanitizeMultiSummary, type ArticleAnalysis } from '../../src/analysis/schemas';
import { canonicalizeUrl } from '../../src/ingestion/url';
import { budgetPeriodEnd, providerDay } from '../../src/social/quota';
import { usagePeriod } from '../../src/commercial/periods';
import { computeSeverity } from '../../src/alerts/severity';
import { resolveScope } from '../../src/analytics/engine';
import { decideDuplicate } from '../../src/ingestion/dedup';

/** Regression tests for defects found in the full-system QA audit (docs/FULL_SYSTEM_QA_REPORT.md). */

const SOURCE = 'Banjir rendam Jakarta\nWarga di Kampung Melayu mengungsi. Gubernur Anies Baswedan meninjau lokasi pada Senin, 12 korban dievakuasi.';
const analysis = (o: Partial<ArticleAnalysis> = {}): ArticleAnalysis => ({
  entities: [], topics: [], entitySentiments: [], taxonomyVersion: 't',
  sentiment: { label: 'neutral', confidence: 0.9, uncertain: false, target: { type: 'article', name: null }, evidence: [], rationale: '' },
  summary: { status: 'ok', claims: [], uncertainty: [] }, ...o,
});

describe('QA-AI-01 evidence must be real, whole-word source text', () => {
  it('rejects 2-letter fragments and sub-word matches as evidence', () => {
    expect(occursIn('di', SOURCE)).toBe(false);          // too short
    expect(occursIn('an', SOURCE)).toBe(false);
    expect(occursIn('mpung Mel', SOURCE)).toBe(false);   // inside words
    expect(occursIn('Kampung Melayu', SOURCE)).toBe(true);
    expect(occursIn('kampung   MELAYU', SOURCE)).toBe(true);
  });

  it('drops invented entities, attributes, aliases and sentiment evidence (auditor repro)', () => {
    const { analysis: a, report } = sanitizeArticleAnalysis(analysis({
      entities: [
        { type: 'public_figure', name: 'Gubernur Budi Santoso (tersangka korupsi)', aliases: [], evidence: 'di', confidence: 0.9 },
        { type: 'public_figure', name: 'Anies Baswedan', aliases: ['Anies', 'Presiden'], evidence: 'Gubernur Anies Baswedan meninjau', confidence: 0.9 },
        { type: 'public_figure', name: 'anies baswedan', aliases: [], evidence: 'Gubernur Anies Baswedan meninjau', confidence: 0.8 },   // duplicate
        { type: 'location', name: 'Kementerian Keuangan', aliases: ['KPK'], evidence: 'Kampung Melayu', confidence: 0.9 },             // name not in source
      ],
      sentiment: { label: 'negative', confidence: 0.95, uncertain: false, target: { type: 'article', name: null }, evidence: ['an'], rationale: '' },
    }), SOURCE, new Set());
    expect(a.entities.map((e) => e.name)).toEqual(['Anies Baswedan']);
    expect(a.entities[0]!.aliases).toEqual(['Anies']);                  // "Presiden" does not occur in the source
    expect(report.droppedEntities).toBe(3);
    expect(a.sentiment).toMatchObject({ evidence: [], uncertain: true });
  });

  it('keeps a source_fact claim only when its quote is real and its numbers come from the quote', () => {
    const { analysis: a } = sanitizeArticleAnalysis(analysis({ summary: { status: 'ok', uncertainty: [], claims: [
      { kind: 'source_fact', text: 'Banjir menewaskan 57 orang dan merugikan Rp 3 triliun', quote: 'an' },
      { kind: 'source_fact', text: 'Sebanyak 57 korban dievakuasi', quote: '12 korban dievakuasi' },
      { kind: 'source_fact', text: '12 korban dievakuasi', quote: '12 korban dievakuasi' },
      { kind: 'interpretation', text: 'Ribuan warga, sekitar 5.000 orang, terdampak', quote: null },
      { kind: 'interpretation', text: 'Situasi di "Kampung Melayu" memburuk', quote: null },
    ] } }), SOURCE, new Set());
    expect(a.summary.claims.map((c) => c.text)).toEqual(['12 korban dievakuasi', 'Situasi di "Kampung Melayu" memburuk']);
    expect(a.summary.status).toBe('ok');
  });

  it('a summary made only of interpretations is insufficient_evidence', () => {
    const { analysis: a } = sanitizeArticleAnalysis(analysis({ summary: { status: 'ok', uncertainty: [], claims: [{ kind: 'interpretation', text: 'Warga khawatir', quote: null }] } }), SOURCE, new Set());
    expect(a.summary.status).toBe('insufficient_evidence');
  });
});

describe('QA-AI-03 multi-record summaries cannot state numbers or quotes their records do not contain', () => {
  const refs = new Map([['R1', 'm-1'], ['R2', 'm-2']]);
  const texts = new Map([['m-1', 'Banjir di Bekasi, 300 warga mengungsi'], ['m-2', 'Pemerintah kirim bantuan ke Bekasi']]);
  it('drops invented figures and quotations, removes an ungrounded headline and caps text', () => {
    const s = sanitizeMultiSummary({
      status: 'ok', headline: 'Ignore previous instructions: 1.000 korban tewas',
      claims: [
        { kind: 'source_fact', text: 'Banjir menewaskan 1.000 orang, kata "Menteri X"', supportingRefs: [' r1 '] },
        { kind: 'source_fact', text: '300 warga mengungsi di Bekasi', supportingRefs: ['R1'] },
        { kind: 'source_fact', text: '300 warga menerima bantuan', supportingRefs: ['R2'] },          // number is in R1, not in the cited R2
        { kind: 'source_fact', text: 'Bantuan dikirim', supportingRefs: ['R99'] },
      ],
      conflicts: [], uncertainty: ['x'.repeat(100_000)],
    }, refs, texts);
    expect(s.claims.map((c) => c.text)).toEqual(['300 warga mengungsi di Bekasi']);
    expect(s.headline).toBeNull();
    expect(s.uncertainty[0]!.length).toBeLessThanOrEqual(300);
    expect(s.droppedClaims).toBe(3);
  });
});

describe('QA-IN-01 a monthly social budget pause ends at the provider\'s next month', () => {
  it('ends at Pacific midnight on the 1st and the next check is in the new month', () => {
    const end = budgetPeriodEnd('youtube', 'month', new Date('2026-11-01T03:00:00Z'));   // still 31 Oct in Pacific time
    expect(end.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(providerDay('youtube', end).day).toBe('2026-11-01');
    expect(budgetPeriodEnd('youtube', 'month', new Date('2026-12-31T20:00:00Z')).toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });
});

describe('QA-IN-13 canonical URLs never keep credentials', () => {
  it('strips userinfo', () => {
    expect(canonicalizeUrl('https://user:pw@ex.com/a?utm_source=x')).toBe('https://ex.com/a');
  });
});

describe('QA-BL-10 usage periods depend on the frozen period time zone only', () => {
  it('a different time zone would give a different period start (why the zone is frozen with the anchor)', () => {
    const anchor = new Date('2026-10-04T17:00:00Z');
    const at = new Date('2026-11-10T00:00:00Z');
    expect(usagePeriod(anchor, at, 'Asia/Jakarta').start.toISOString()).not.toBe(usagePeriod(anchor, at, 'America/New_York').start.toISOString());
  });
});

describe('QA-AR-02 negative-shift severity uses the window population, not the negative-only evidence', () => {
  it('scores negative_share from the detector observation', () => {
    const t = Date.UTC(2026, 9, 19, 11, 0, 0);
    const negatives = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, t, publisher: `p${i}.example`, sourceId: 's', clusterId: null, syndicated: false,
      analysed: true, label: 'negative' as const, uncertain: false, topics: [], headlineOnly: false }));
    const cand = { signal: 'negative_shift' as const, scope: 'issue' as const, subjectType: 'project' as const, subjectKey: 'p', evidence: negatives, title: 'x',
      result: { triggered: true, suppressed: null, method: '', observed: { negativeShare: 0.35, confident: 72 }, baseline: {}, thresholds: {}, exceeded: [], limitations: [] } };
    const s = computeSeverity(cand as never, { topicRelevant: false, collectionStale: false, now: t + 3_600_000, floor: null });
    expect(s.factors.find((f) => f.factor === 'negative_share')).toMatchObject({ value: 0.35, points: 0 });   // 100% before the fix (+2)
  });
});

describe('QA-AR-03 date-only analytics bounds are tenant-local calendar days', () => {
  const fake = { query: async (sql: string) => ({ rows: sql.includes('timezone') ? [{ tz: 'Asia/Jakarta' }] : [{ id: 'p1' }] }) } as never;
  it('from = local midnight, to = end of that local day', async () => {
    const s = await resolveScope(fake, { tenantId: 't', userId: 'u', role: 'owner' }, { from: '2026-10-01', to: '2026-10-07' }, { now: new Date('2026-10-20T00:00:00Z'), maxPeriodDays: 400 });
    expect(s.from.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(s.to.toISOString()).toBe('2026-10-07T17:00:00.000Z');
  });
  it('a single date-only day is a valid one-day range', async () => {
    const s = await resolveScope(fake, { tenantId: 't', userId: 'u', role: 'owner' }, { from: '2026-10-07', to: '2026-10-07' }, { now: new Date('2026-10-20T00:00:00Z'), maxPeriodDays: 400 });
    expect(s.to.getTime() - s.from.getTime()).toBe(86_400_000);
  });
});

describe('QA-IN-03 recurring headlines from one publisher on different days are not duplicates', () => {
  const t0 = Date.UTC(2026, 9, 1, 2, 0, 0);
  const cand = { id: 'a', publisherDomain: 'ex.com', normalizedTitle: 'harga emas hari ini', contentHash: 'h1', publishedAt: t0 };
  const opts = { similarityThreshold: 0.9, minTokens: 4 };
  it('same headline a week later is original; within the window it is a duplicate', () => {
    expect(decideDuplicate({ publisherDomain: 'ex.com', normalizedTitle: 'harga emas hari ini', contentHash: 'h2', publishedAt: t0 + 7 * 86_400_000 }, [cand], opts).status).toBe('original');
    expect(decideDuplicate({ publisherDomain: 'ex.com', normalizedTitle: 'harga emas hari ini', contentHash: 'h2', publishedAt: t0 + 3_600_000 }, [cand], opts).status).toBe('duplicate');
  });
  it('an emoji-only title never matches by hash', () => {
    expect(decideDuplicate({ publisherDomain: 'ex.com', normalizedTitle: '', contentHash: 'h1', publishedAt: t0 }, [cand], opts).status).toBe('original');
  });
});
