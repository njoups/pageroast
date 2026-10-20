import { numbersIn, validateCommentary } from '../../../src/reports/claims';
import { csvCell, excerptAllowed, safeFilename, toCsv } from '../../../src/reports/csv';
import { renderPdf } from '../../../src/reports/pdf';
import { DefinitionSchema, ScheduleSchema } from '../../../src/reports/report-config';
import { buildModel, checkConsistency, type Article, type ReportData } from '../../../src/reports/templates';
import { bucketKeys } from '../../../src/analytics/engine';

/** Deterministic, synthetic report data (labelled as such in titles). */
function fixtureData(over: Partial<ReportData> = {}): ReportData {
  const art = (i: number): Article => ({ id: `00000000-0000-4000-8000-00000000000${i}`, title: `Synthetic headline ${i} — banjir di Kota Contoh`, publisher: `Publisher ${i}`,
    domain: `pub${i}.example`, url: `https://pub${i}.example/a/${i}`, publishedAt: '2026-10-18T03:00:00.000Z', sentiment: 'neutral', clusterSize: 1, attribution: `© Publisher ${i}` });
  const counts = { positive: 2, negative: 3, neutral: 4, mixed: 1, unknown: 1, unanalysed: 1, uncertain: 2 };
  return {
    coverage: { totals: { records: 14, articles: 12, duplicates: 2, publishers: 3, sources: 2, storyClusters: 4, unclusteredArticles: 5 },
      previousPeriod: { totals: { articles: 8 } }, change: { articles: { current: 12, previous: 8, delta: 4, pct: 50 }, publishers: { current: 3, previous: 2, delta: 1, pct: 50 } },
      timeline: { source: 'base_tables', points: [{ bucket: '2026-10-17', articles: 5, records: 6 }, { bucket: '2026-10-18', articles: 7, records: 8 }] } },
    sentiment: { totals: { counts, denominator: 10, shares: { positive: 20, negative: 30, neutral: 40, mixed: 10 }, net: -10 }, limitations: [], limitationKeys: [] },
    sov: { denominator: 10, eligibleArticles: 9, entities: [{ id: 'e1', name: 'Dinas A', articles: 6, share: 60 }, { id: 'e2', name: 'Dinas B', articles: 4, share: 40 }],
      formula: 'f', warnings: [], warningKeys: [] },
    topics: { topics: [{ key: 'environment', label: 'Environment', articles: 7, delta: 2, pct: 40 }], emerging: [], definitions: { emerging: '' } },
    entities: { entities: [{ id: 'e1', name: 'Dinas A', articles: 6, delta: 1, pct: 20 }], coOccurrence: [], definitions: { coOccurrence: '' } },
    sources: { totalArticles: 12, publishers: [{ domain: 'pub1.example', publisher: 'Publisher 1', articles: 12, share: 100, activeDays: 2, medianLagMinutes: 30 }],
      diversity: { simpson: 0, definition: '' }, notes: [] },
    issues: { top: [], highPriority: 0, definition: '' },
    focusIssue: null, notable: [art(1), art(2)], negative: [art(3)], policy: [], ...over,
  };
}
const ctx = { template: 'weekly_intelligence' as const, language: 'id' as const, organization: 'Org Uji', project: 'Proyek Uji', brandColor: '#123456', generatedAt: new Date('2026-10-19T01:00:00Z'),
  from: new Date('2026-10-11T17:00:00Z'), to: new Date('2026-10-18T17:00:00Z'), timezone: 'Asia/Jakarta', name: 'Laporan Mingguan', analystNote: null };

describe('CSV export', () => {
  it('quotes every field, doubles quotes and uses CRLF with a BOM', () => {
    const buf = toCsv(['a', 'b'], [['x "y"', 'line1\nline2'], [3, null]]);
    const s = buf.toString('utf8');
    expect(s.startsWith('﻿"a","b"\r\n')).toBe(true);
    expect(s).toContain('"x ""y""","line1\nline2"\r\n"3",""\r\n');
  });
  it.each(['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '  =cmd|calc'])('neutralises formula injection: %j', (v) => {
    expect(csvCell(v)).toBe(`"'${v.replace(/"/g, '""')}"`);
  });
  it('keeps numbers (including negatives) and timestamps as data', () => {
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(new Date('2026-10-19T01:02:03Z'))).toBe('"2026-10-19T01:02:03.000Z"');
  });
  it('exports excerpts only where the licence permits redistribution', () => {
    expect(excerptAllowed(['title', 'url', 'excerpt'], null)).toEqual({ ok: true, reason: null });
    expect(excerptAllowed(['title', 'url'], null).reason).toBe('excerpt_not_permitted_by_source');
    expect(excerptAllowed(['title', 'url', 'excerpt'], 'No redistribution outside the licensee').reason).toBe('source_redistribution_restricted');
  });
  it('builds safe ASCII file names from untrusted report names', () => {
    expect(safeFilename('../../etc/passwd', 'pdf')).toBe('etc-passwd.pdf');
    expect(safeFilename('Laporan "Mingguan"\r\nX-Header: 1 – Peña', 'csv')).toBe('laporan-mingguan-x-header-1-pena.csv');
    expect(safeFilename('', 'pdf')).toBe('report.pdf');
    expect(safeFilename('a'.repeat(300), 'pdf').length).toBeLessThanOrEqual(104);
  });
});

describe('AI commentary validation', () => {
  const ids = new Set(['m1', 'm2']);
  const texts = new Map([['m1', 'Banjir merendam 1.200 rumah di Kota Contoh'], ['m2', 'Wali kota meninjau lokasi pengungsian']]);
  const metrics = { articles: 12, tone_negative_pct: 30 };
  const check = (text: string, refs = ['m1']) => validateCommentary([{ text, kind: 'interpretation', supportingMentionIds: refs }], { citedIds: ids, metrics, recordTexts: texts });
  it('parses Indonesian and English number formats', () => {
    expect(numbersIn('1.200 rumah, 12,5% dan 3,000 jiwa')).toEqual(['1200', '12.5', '3000']);
  });
  it('keeps claims that use only report metrics or numbers present in the cited record', () => {
    expect(check('Pemberitaan berfokus pada banjir; 12 artikel unik tercatat.').kept).toHaveLength(1);
    expect(check('Sumber melaporkan 1.200 rumah terendam.').kept).toHaveLength(1);
    expect(check('Pangsa negatif 30%.').kept).toHaveLength(1);
  });
  it.each([
    ['Liputan naik 45% minggu ini.', 'unsupported_number'],
    ['Liputan meningkat karena banjir besar.', 'causal_claim'],
    ['Coverage rose due to the flood.', 'causal_claim'],
    ['Masyarakat mendukung langkah wali kota.', 'public_opinion_claim'],
    ['The public believes the response was slow.', 'public_opinion_claim'],
    ['Program tanggap darurat terbukti efektif.', 'effectiveness_claim'],
    ['Liputan diperkirakan akan meningkat.', 'forecast'],
    ['Wali kota berkata “kami sudah siap sepenuhnya”.', 'unverified_quotation'],
  ])('drops %j (%s)', (text, reason) => {
    const r = check(text);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0]!.reason).toBe(reason);
  });
  it('drops claims citing records outside the report and keeps verbatim quotations', () => {
    expect(check('Liputan menyoroti pengungsian.', ['m9']).dropped[0]!.reason).toBe('no_valid_reference');
    expect(check('Judul menyebut “meninjau lokasi pengungsian”.', ['m2']).kept).toHaveLength(1);
  });
});

describe('report templates', () => {
  it('passes the consistency check for coherent data and reports each mismatch otherwise', () => {
    expect(checkConsistency(fixtureData())).toEqual([]);
    const bad = fixtureData();
    bad.sentiment.totals.counts.neutral = 9;
    bad.coverage.timeline.points[0].articles = 1;
    bad.sov.entities[0].share = 70;
    const errs = checkConsistency(bad);
    expect(errs).toHaveLength(3);
    expect(errs.join(' ')).toMatch(/tone counts.*timeline total.*share-of-voice/s);
  });

  it('types every paragraph, cites sources by resolvable refs and keeps AI claims apart', () => {
    const d = fixtureData();
    const { model, cited } = buildModel(ctx, d, {
      claims: [{ text: 'Liputan berfokus pada banjir.', kind: 'interpretation', supportingMentionIds: [d.notable[0]!.id] },
        { text: 'Klaim tanpa rujukan.', kind: 'interpretation', supportingMentionIds: ['not-cited'] }],
      ai: { requested: true, method: 'llm', kept: 1, dropped: [] } });
    const refs = new Set(model.sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === 'sources' ? b.items.map((i) => i.ref) : []))));
    const paras = model.sections.flatMap((s) => s.blocks.filter((b) => b.type === 'paragraph')) as Array<{ kind: string; refs?: string[]; text: string }>;
    for (const p of paras) for (const r of p.refs ?? []) expect(refs.has(r)).toBe(true);
    const ai = paras.filter((p) => p.kind === 'ai_interpretation');
    expect(ai).toHaveLength(1);                         // the claim citing a record outside the report is not rendered
    expect(ai[0]!.refs).toEqual(['S1']);
    expect([...cited.keys()].sort()).toEqual(d.notable.concat(d.negative).map((a) => a.id).sort());
    expect(model.metrics.articles).toBe(12);
    expect(model.attribution).toEqual(['© Publisher 1', '© Publisher 2', '© Publisher 3']);
    expect(model.limitations.join(' ')).toMatch(/bukan ukuran opini publik/);
  });

  it('makes no effectiveness, opinion or causal claims in deterministic text (all templates, both languages)', () => {
    for (const template of ['daily_briefing', 'weekly_intelligence', 'monthly_performance', 'issue_report', 'policy_monitoring'] as const) {
      for (const language of ['id', 'en'] as const) {
        const { model } = buildModel({ ...ctx, template, language }, fixtureData({ policy: [{ entity: { id: 'e1', name: 'Program A', articles: 6, positive: 1, negative: 2 }, articles: [] }] }),
          { claims: [], ai: { requested: false, method: 'none', kept: 0, dropped: [] } });
        const text = model.sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === 'paragraph' ? [b.text] : []))).join(' ');
        expect(text).not.toMatch(/\b(efektif|berhasil|effective|successful|because|karena|public supports|masyarakat mendukung)\b/i);
      }
    }
  });
});

describe('PDF rendering', () => {
  it('renders a multi-page PDF with cover, Indonesian text and page numbers', async () => {
    const d = fixtureData({ notable: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, title: `Judul ${i}: Pemerintah daerah menyiapkan posko — “siaga” ñ é`, publisher: 'Penerbit', domain: 'p.example',
      url: 'javascript:alert(1)', publishedAt: null, sentiment: 'neutral', clusterSize: 1, attribution: null })) });
    const { model } = buildModel(ctx, d, { claims: [], ai: { requested: false, method: 'none', kept: 0, dropped: [] } });
    const pdf = await renderPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = pdf.toString('latin1');
    const pages = (raw.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(raw).not.toContain('javascript:');          // non-http(s) source URLs are never turned into links
    expect(raw).toMatch(/\/Title /);
  });
});

describe('configuration and buckets', () => {
  it('rejects unknown keys and incomplete schedules', () => {
    expect(DefinitionSchema.safeParse({ projectId: '00000000-0000-4000-8000-000000000001', template: 'weekly_intelligence', name: 'X', params: { evil: 1 } }).success).toBe(false);
    const s = ScheduleSchema.safeParse({ definitionId: '00000000-0000-4000-8000-000000000001', frequency: 'weekly' });
    expect(s.success).toBe(false);
    expect(ScheduleSchema.safeParse({ definitionId: '00000000-0000-4000-8000-000000000001', frequency: 'daily', timezone: 'Mars/Base' }).success).toBe(false);
  });
  it('creates every local bucket in the period, including empty ones', () => {
    expect(bucketKeys(new Date('2026-10-11T17:00:00Z'), new Date('2026-10-14T17:00:00Z'), 'Asia/Jakarta', 'day')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(bucketKeys(new Date('2026-09-30T17:00:00Z'), new Date('2026-10-31T17:00:00Z'), 'Asia/Jakarta', 'week')[0]).toBe('2026-09-28');
    expect(bucketKeys(new Date('2026-08-31T17:00:00Z'), new Date('2026-10-31T17:00:00Z'), 'Asia/Jakarta', 'month')).toEqual(['2026-09-01', '2026-10-01']);
  });
});
