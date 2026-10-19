import evalSet from '../../fixtures/eval/eval-set.json';
import { analyzeBaseline, classifyTopicsBaseline, extractEntitiesBaseline, extractiveSummary, sentimentBaseline } from '../../../src/analysis/baseline';
import { detectLanguage, resolveLanguage } from '../../../src/analysis/language';
import { macroF1 } from '../../../src/analysis/evaluate';

type Item = { id: string; text: string; language: string; sentiment?: string; topic: string };
const items = evalSet as Item[];

describe('language detection', () => {
  it('meets the documented accuracy on the evaluation set (regression guard, see docs/AI_EVALUATION.md)', () => {
    const ok = items.filter((x) => { const r = detectLanguage(x.text); return r.language === x.language || (x.language === 'und' && !r.supported && !['id', 'en', 'ms', 'jv'].includes(r.language)); });
    expect(ok.length).toBeGreaterThanOrEqual(62);
  });
  it('never labels Malay, Javanese or other languages as supported Indonesian/English', () => {
    for (const x of items.filter((i) => !['id', 'en'].includes(i.language))) expect(detectLanguage(x.text).supported).toBe(false);
  });
  it('returns und rather than guessing on tiny or non-linguistic input', () => {
    expect(detectLanguage('OK').language).toBe('und');
    expect(detectLanguage('2026-10-19 08:00 #12345').language).toBe('und');
  });
  it('falls back to the publisher-declared language only when detection is inconclusive', () => {
    expect(resolveLanguage('Siswa SMA meraih medali emas', 'id')).toMatchObject({ language: 'id', method: 'publisher-declared', supported: true });
    expect(resolveLanguage('Kerajaan akan menaikkan bantuan tunai kerana kos sara hidup meningkat', 'id').language).toBe('ms');
    expect(resolveLanguage('OK', 'fr').language).toBe('und');
  });
});

describe('baseline sentiment and topics (rule-based; regression guards)', () => {
  const labelled = items.filter((x) => x.sentiment);
  it('sentiment macro-F1 stays at or above the documented baseline', () => {
    const r = macroF1(labelled.map((x) => x.sentiment!), labelled.map((x) => sentimentBaseline(x.text).label), ['positive', 'negative', 'neutral', 'mixed']);
    expect(r.macroF1).toBeGreaterThanOrEqual(0.55);
  });
  it('handles short-range negation (two-token window) in both directions', () => {
    expect(sentimentBaseline('Auditors found no corruption at the agency').label).not.toBe('negative');
    expect(sentimentBaseline('Program itu tidak berhasil menurunkan antrean').label).toBe('negative');
  });
  it('marks low-confidence results uncertain and never claims entity-level sentiment', () => {
    const s = sentimentBaseline('Festival budaya tahunan digelar akhir pekan ini');
    expect(s).toMatchObject({ label: 'neutral', uncertain: true, target: { type: 'article', name: null } });
  });
  it('topic top-1 accuracy stays at or above the documented baseline, and unknown is used instead of forcing a category', () => {
    const supported = items.filter((x) => ['id', 'en'].includes(x.language));
    const hits = supported.filter((x) => classifyTopicsBaseline(x.text)[0]!.key === x.topic).length;
    expect(hits / supported.length).toBeGreaterThanOrEqual(0.6);
    expect(classifyTopicsBaseline('Festival budaya tahunan digelar akhir pekan ini')[0]!.key).toBe('unknown');
  });
  it('custom project topics are classified from their keywords', () => {
    const t = classifyTopicsBaseline('Penyaluran bansos tahap kedua dimulai', [{ id: 'x', key: 'custom:bansos', label: 'Bansos', description: null, keywords: ['bansos', 'bantuan sosial'] }]);
    expect(t[0]!.key).toBe('custom:bansos');
  });
});

describe('baseline entities', () => {
  it('extracts institutions, locations and programmes with verbatim evidence, and no people', () => {
    const text = 'KPK periksa pejabat Dinas Pendidikan Kota Bandung terkait Program Makan Bergizi Gratis di Jawa Barat';
    const e = extractEntitiesBaseline(text);
    const names = e.map((x) => `${x.type}:${x.name}`);
    expect(names).toEqual(expect.arrayContaining(['government_institution:Komisi Pemberantasan Korupsi (KPK)', 'location:Jawa Barat', 'policy_program:Program Makan Bergizi Gratis']));
    expect(e.find((x) => x.name.startsWith('Dinas Pendidikan'))?.type).toBe('government_institution');
    for (const x of e) expect(text).toContain(x.evidence);
    expect(e.some((x) => x.type === 'public_figure')).toBe(false);
  });
  it('gazetteer entities carry their aliases for resolution', () => {
    expect(extractEntitiesBaseline('Komisi Pemberantasan Korupsi menahan tersangka')[0]).toMatchObject({ name: 'Komisi Pemberantasan Korupsi (KPK)', aliases: ['KPK', 'Komisi Pemberantasan Korupsi'] });
  });
  it('does not treat lowercase common words as entities', () => {
    expect(extractEntitiesBaseline('harga beras naik di pasar tradisional')).toEqual([]);
  });
});

describe('extractive summaries', () => {
  it('headline-only records get no summary (insufficient evidence), never invented text', () => {
    expect(extractiveSummary(null, null)).toMatchObject({ status: 'insufficient_evidence', claims: [] });
  });
  it('quotes permitted text verbatim', () => {
    const ex = 'Hujan deras sejak Minggu malam membuat tiga kecamatan terendam. Ribuan warga mengungsi ke posko darurat. Bantuan mulai disalurkan.';
    const s = extractiveSummary(ex, null);
    expect(s.status).toBe('ok');
    for (const c of s.claims) { expect(ex).toContain(c.quote!); expect(c.kind).toBe('source_fact'); }
  });
  it('analyzeBaseline output passes its own schema', async () => {
    const { ArticleAnalysisSchema } = await import('../../../src/analysis/schemas');
    expect(ArticleAnalysisSchema.safeParse(analyzeBaseline({ title: 'Banjir di Jakarta', excerpt: null, body: null })).success).toBe(true);
  });
});
