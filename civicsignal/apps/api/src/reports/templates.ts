import { texts } from '../analytics/notes';
import type { CommentaryClaim } from './claims';
import type { TemplateKey } from './report-config';

/**
 * Report templates: code-defined and versioned. A template turns deterministic metrics (analytics engine) and selected
 * records into a ReportModel; it never computes metrics itself and never states effectiveness, public opinion or causes.
 * Every paragraph is typed so readers can tell calculated metrics, observed source facts, AI interpretation and analyst
 * recommendations apart.
 */
export const TEMPLATE_VERSION = 'report-templates/1';

export type ParagraphKind = 'metric' | 'source_fact' | 'ai_interpretation' | 'analyst_recommendation' | 'note';
export type Block =
  | { type: 'paragraph'; kind: ParagraphKind; text: string; refs?: string[]; attribution?: string }
  | { type: 'kpis'; items: Array<{ label: string; value: string; detail?: string }> }
  | { type: 'table'; title: string; columns: string[]; rows: Array<Array<string | number>>; note?: string; numeric?: number[] }
  | { type: 'bar'; title: string; metric: string; unit: string; points: Array<{ label: string; value: number }> }
  | { type: 'columns'; title: string; metric: string; unit: string; points: Array<{ label: string; value: number }> }
  | { type: 'sources'; items: Array<{ id: string; ref: string; title: string; publisher: string; url: string; publishedAt: string | null }> };
export interface Section { key: string; title: string; blocks: Block[] }
export interface ReportModel {
  template: TemplateKey; templateVersion: string; title: string; subtitle: string; language: 'id' | 'en';
  organization: string; project: string; brandColor: string; generatedAt: string;
  period: { from: string; to: string; timezone: string; label: string };
  sections: Section[]; methodology: string[]; limitations: string[]; attribution: string[];
  metrics: Record<string, number | null>;
  ai: { requested: boolean; method: 'llm' | 'none' | 'unavailable'; kept: number; dropped: Array<{ text: string; reason: string }>; model?: string | null };
}

export interface Article { id: string; title: string; publisher: string; domain: string; url: string; publishedAt: string | null; sentiment: string; clusterSize: number; attribution: string | null }
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ReportData {
  coverage: any; sentiment: any; sov: any; topics: any; entities: any; sources: any; issues: any;
  focusIssue: { issue: any; evidence: Article[]; events: any[]; byDay: Array<{ day: string; n: number }> } | null;
  notable: Article[]; negative: Article[]; policy: Array<{ entity: any; articles: Article[] }>;
}
export interface ReportContext {
  template: TemplateKey; language: 'id' | 'en'; organization: string; project: string; brandColor: string; generatedAt: Date;
  from: Date; to: Date; timezone: string; name: string; analystNote: { text: string; author: string; at: string } | null;
}

const T = {
  id: {
    daily_briefing: 'Ringkasan Media Harian', weekly_intelligence: 'Laporan Intelijen Media Mingguan', monthly_performance: 'Kinerja Komunikasi Bulanan',
    issue_report: 'Laporan Isu & Krisis', policy_monitoring: 'Pemantauan Kebijakan & Program Publik',
    summary: 'Ringkasan', coverage: 'Cakupan pemberitaan', tone: 'Nada pemberitaan', sov: 'Pangsa suara (share of voice)', topics: 'Topik', entities: 'Entitas',
    sources: 'Sumber dan penerbit', issues: 'Isu dan peringatan', notable: 'Pemberitaan yang dirujuk', negativeCoverage: 'Pemberitaan bernada negatif', ai: 'Komentar AI (interpretasi)',
    analyst: 'Catatan analis', methodology: 'Metodologi', limitations: 'Keterbatasan', articles: 'Artikel unik', records: 'Rekaman (termasuk duplikat)', publishers: 'Penerbit',
    clusters: 'Klaster berita', vsPrev: 'vs periode sebelumnya', highPriority: 'Isu prioritas tinggi', net: 'Nada bersih', known: 'berlabel nada', none: 'Tidak ada data pada periode ini.',
    positive: 'Positif', negative: 'Negatif', neutral: 'Netral', mixed: 'Campuran', unknown: 'Tidak diketahui', unanalysed: 'Belum dianalisis',
    entity: 'Entitas', share: 'Pangsa', publisher: 'Penerbit', topic: 'Topik', change: 'Perubahan', status: 'Status', severity: 'Tingkat', title: 'Judul', days: 'Hari aktif',
    lag: 'Median jeda koleksi (menit)', perDay: 'Artikel per hari', policyTitle: 'Program/kebijakan', period: 'Periode', generated: 'Dibuat', evidence: 'Bukti',
    emerging: 'Topik yang meningkat', coMention: 'Muncul bersama', firstSeen: 'Pertama terdeteksi', lastSeen: 'Terakhir terdeteksi', events: 'Riwayat',
    srcNote: 'Frekuensi pemberitaan bukan ukuran kredibilitas, akurasi, atau pengaruh. Jeda koleksi = waktu koleksi dikurangi waktu terbit menurut penerbit; mencerminkan jeda umpan dan jadwal pengambilan.',
    divDef: 'Indeks keragaman Simpson 1 − Σp² atas pangsa penerbit dari artikel unik (0 = satu penerbit; mendekati 1 = tersebar di banyak penerbit).',
    emergingDef: 'Minimal 3 artikel pada periode ini dan baru muncul, atau naik minimal 50% dibanding periode sebelumnya dengan durasi sama. Deskriptif, bukan prakiraan.',
    coDef: 'Artikel unik yang menyebut kedua entitas. Kemunculan bersama bukan bukti adanya hubungan antara keduanya.',
    sovFormula: 'Pangsa suara (e) = artikel unik yang menyebut e ÷ jumlah artikel unik per entitas dalam kelompok × 100. Total pangsa = 100%.',
  },
  en: {
    daily_briefing: 'Daily Media Briefing', weekly_intelligence: 'Weekly Media Intelligence Report', monthly_performance: 'Monthly Communications Performance',
    issue_report: 'Issue & Crisis Report', policy_monitoring: 'Policy & Public Program Monitoring',
    summary: 'Summary', coverage: 'Coverage', tone: 'Tone of coverage', sov: 'Share of voice', topics: 'Topics', entities: 'Entities',
    sources: 'Sources and publishers', issues: 'Issues and alerts', notable: 'Cited coverage', negativeCoverage: 'Negative-tone coverage', ai: 'AI commentary (interpretation)',
    analyst: 'Analyst note', methodology: 'Methodology', limitations: 'Limitations', articles: 'Unique articles', records: 'Records (incl. duplicates)', publishers: 'Publishers',
    clusters: 'Story clusters', vsPrev: 'vs previous period', highPriority: 'High-priority issues', net: 'Net tone', known: 'with a known tone', none: 'No data in this period.',
    positive: 'Positive', negative: 'Negative', neutral: 'Neutral', mixed: 'Mixed', unknown: 'Unknown', unanalysed: 'Not analysed',
    entity: 'Entity', share: 'Share', publisher: 'Publisher', topic: 'Topic', change: 'Change', status: 'Status', severity: 'Severity', title: 'Title', days: 'Active days',
    lag: 'Median collection lag (min)', perDay: 'Articles per day', policyTitle: 'Programme/policy', period: 'Period', generated: 'Generated', evidence: 'Evidence',
    emerging: 'Rising topics', coMention: 'Co-mentioned', firstSeen: 'First detected', lastSeen: 'Last detected', events: 'History',
    srcNote: 'Publishing frequency is not a measure of credibility, accuracy or influence. Collection lag = our collection time minus the publisher-reported time; it reflects feed and polling delays.',
    divDef: 'Simpson diversity 1 − Σp² over publisher shares of unique articles (0 = a single publisher; closer to 1 = spread across many).',
    emergingDef: 'At least 3 articles in the period and new, or up at least 50% on the previous equal-length period. Descriptive, not a forecast.',
    coDef: 'Unique articles mentioning both entities. Co-occurrence is not evidence of a relationship between them.',
    sovFormula: 'SoV(e) = unique articles mentioning e ÷ Σ unique articles mentioning each entity in the group × 100. Shares sum to 100%.',
  },
} as const;
type Dict = Record<keyof (typeof T)['en'], string>;

export const TEMPLATES: Record<TemplateKey, { defaultFrequency: 'daily' | 'weekly' | 'monthly' | 'custom'; defaultPeriodDays: number; description: string }> = {
  daily_briefing: { defaultFrequency: 'daily', defaultPeriodDays: 1, description: 'Previous day: coverage, tone, active issues and the most-covered stories.' },
  weekly_intelligence: { defaultFrequency: 'weekly', defaultPeriodDays: 7, description: 'Previous ISO week: trends, share of voice, topics, entities, sources and issues.' },
  monthly_performance: { defaultFrequency: 'monthly', defaultPeriodDays: 30, description: 'Previous calendar month: coverage volume, tone distribution and share of voice against the month before. Describes media coverage, not communication effectiveness.' },
  issue_report: { defaultFrequency: 'custom', defaultPeriodDays: 7, description: 'One detected issue (or all active issues): detection basis, timeline, publishers and evidence.' },
  policy_monitoring: { defaultFrequency: 'weekly', defaultPeriodDays: 30, description: 'Coverage of selected policies/programmes: volume, tone of coverage, publishers and co-mentioned entities. Not a measure of policy outcomes or public opinion.' },
};

export function fmtNum(v: number | null | undefined, lang: 'id' | 'en', digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return new Intl.NumberFormat(lang === 'id' ? 'id-ID' : 'en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
}
const fmtPct = (v: number | null | undefined, lang: 'id' | 'en') => (v == null ? '–' : `${fmtNum(v, lang, 1)}%`);
const fmtChange = (c: { delta: number; pct: number | null }, lang: 'id' | 'en') =>
  `${c.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(c.delta), lang)}${c.pct == null ? '' : ` (${c.pct >= 0 ? '+' : '−'}${fmtNum(Math.abs(c.pct), lang, 1)}%)`}`;
export function fmtDate(d: Date | string, tz: string, lang: 'id' | 'en', time = false): string {
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}) }).format(new Date(d));
}
export function periodLabel(from: Date, to: Date, tz: string, lang: 'id' | 'en'): string {
  const last = new Date(to.getTime() - 1);
  const a = fmtDate(from, tz, lang); const b = fmtDate(last, tz, lang);
  return a === b ? a : `${a} – ${b}`;
}

/** Flat metric registry: the only numbers AI commentary may use, and the values the consistency check compares. */
export function metricRegistry(d: ReportData): Record<string, number | null> {
  const m: Record<string, number | null> = {
    articles: d.coverage.totals.articles, records: d.coverage.totals.records, duplicates: d.coverage.totals.duplicates, publishers: d.coverage.totals.publishers,
    clusters: d.coverage.totals.storyClusters, prevArticles: d.coverage.previousPeriod.totals.articles, articlesChange: d.coverage.change.articles.delta,
    articlesChangePct: d.coverage.change.articles.pct, knownTone: d.sentiment.totals.denominator, net: d.sentiment.totals.net, highPriority: d.issues.highPriority,
    sovEligible: d.sov.eligibleArticles, diversity: d.sources.diversity.simpson,
  };
  for (const k of ['positive', 'negative', 'neutral', 'mixed', 'unknown', 'unanalysed'] as const) {
    m[`tone_${k}`] = d.sentiment.totals.counts[k];
    if (k in d.sentiment.totals.shares) m[`tone_${k}_pct`] = d.sentiment.totals.shares[k];
  }
  for (const e of d.sov.entities) { m[`sov_${e.id}`] = e.share; m[`sov_${e.id}_articles`] = e.articles; }
  for (const t of d.topics.topics.slice(0, 10)) m[`topic_${t.key}`] = t.articles;
  return m;
}

/** Arithmetic cross-checks between independently computed metrics. Any failure stops rendering. */
export function checkConsistency(d: ReportData): string[] {
  const errs: string[] = [];
  const art = d.coverage.totals.articles;
  const c = d.sentiment.totals.counts;
  const toneSum = c.positive + c.negative + c.neutral + c.mixed + c.unknown + c.unanalysed;
  if (toneSum !== art) errs.push(`tone counts (${toneSum}) ≠ unique articles (${art})`);
  const tl = d.coverage.timeline.points.reduce((a: number, p: { articles: number }) => a + p.articles, 0);
  if (tl !== art) errs.push(`timeline total (${tl}) ≠ unique articles (${art})`);
  if (d.sources.totalArticles !== art) errs.push(`publisher totals (${d.sources.totalArticles}) ≠ unique articles (${art})`);
  if (d.sov.denominator > 0) {
    const s = d.sov.entities.reduce((a: number, e: { share: number | null }) => a + (e.share ?? 0), 0);
    if (Math.abs(s - 100) > 0.5) errs.push(`share-of-voice shares sum to ${s}, not 100`);
  }
  if (d.coverage.totals.records < art) errs.push('records < unique articles');
  return errs;
}

const refList = (arts: Article[], refOf: Map<string, string>) => arts.map((a) => refOf.get(a.id)!).filter(Boolean);

export function buildModel(ctx: ReportContext, d: ReportData, opts: { claims: CommentaryClaim[]; ai: ReportModel['ai'] }): { model: ReportModel; cited: Map<string, string[]> } {
  const L: Dict = T[ctx.language]; const lang = ctx.language;
  const cited = new Map<string, string[]>();                    // mention id → sections citing it
  const sourcesList: Article[] = [];
  const refOf = new Map<string, string>();
  const cite = (section: string, arts: Article[]) => {
    for (const a of arts) {
      if (!refOf.has(a.id)) { refOf.set(a.id, `S${refOf.size + 1}`); sourcesList.push(a); }
      cited.set(a.id, [...new Set([...(cited.get(a.id) ?? []), section])]);
    }
    return arts;
  };
  const cov = d.coverage; const sen = d.sentiment; const tot = cov.totals;
  const sections: Section[] = [];

  // Summary (all templates)
  const kpis: Block = { type: 'kpis', items: [
    { label: L.articles, value: fmtNum(tot.articles, lang), detail: `${fmtChange(cov.change.articles, lang)} ${L.vsPrev}` },
    { label: L.records, value: fmtNum(tot.records, lang) },
    { label: L.publishers, value: fmtNum(tot.publishers, lang), detail: `${fmtChange(cov.change.publishers, lang)} ${L.vsPrev}` },
    { label: L.clusters, value: fmtNum(tot.storyClusters, lang) },
    { label: L.net, value: sen.totals.net == null ? '–' : `${sen.totals.net > 0 ? '+' : ''}${fmtNum(sen.totals.net, lang, 1)} pp`, detail: `n = ${fmtNum(sen.totals.denominator, lang)} ${L.known}` },
    { label: L.highPriority, value: fmtNum(d.issues.highPriority, lang) },
  ] };
  const summaryText = lang === 'id'
    ? `Pada periode ini tercatat ${fmtNum(tot.articles, lang)} artikel unik dari ${fmtNum(tot.publishers, lang)} penerbit (${fmtNum(tot.records, lang)} rekaman termasuk duplikat), dibandingkan ${fmtNum(cov.previousPeriod.totals.articles, lang)} artikel pada periode sebelumnya dengan durasi yang sama.`
    : `This period recorded ${fmtNum(tot.articles, lang)} unique articles from ${fmtNum(tot.publishers, lang)} publishers (${fmtNum(tot.records, lang)} records including duplicates), against ${fmtNum(cov.previousPeriod.totals.articles, lang)} articles in the previous period of equal length.`;
  sections.push({ key: 'summary', title: L.summary, blocks: [kpis, { type: 'paragraph', kind: 'metric', text: summaryText }] });

  const toneTable: Block = { type: 'table', title: L.tone, columns: [L.tone, L.articles, L.share], numeric: [1, 2], rows:
    (['positive', 'negative', 'neutral', 'mixed', 'unknown', 'unanalysed'] as const).map((k) => [L[k], fmtNum(sen.totals.counts[k], lang),
      k === 'unknown' || k === 'unanalysed' ? (lang === 'id' ? 'tidak dihitung' : 'excluded') : fmtPct(sen.totals.shares[k], lang)]),
    note: lang === 'id' ? 'Pangsa dihitung dari artikel dengan label nada yang diketahui; label tidak diketahui dan artikel yang belum dianalisis dikecualikan.' : 'Shares use articles with a known tone label; unknown and not-yet-analysed articles are excluded.' };
  const timeline: Block = { type: 'columns', title: `${L.articles} / ${cov.timeline.points.length > 31 ? (lang === 'id' ? 'minggu' : 'week') : (lang === 'id' ? 'hari' : 'day')}`, metric: L.articles, unit: '',
    points: cov.timeline.points.map((p: { bucket: string; articles: number }) => ({ label: p.bucket.slice(5), value: p.articles })) };
  const topicTable: Block = { type: 'table', title: L.topics, columns: [L.topic, L.articles, L.change], numeric: [1, 2],
    rows: d.topics.topics.filter((t: any) => t.key !== 'unknown').slice(0, 10).map((t: any) => [t.label, fmtNum(t.articles, lang), fmtChange(t, lang)]) };
  const sovBlocks: Block[] = d.sov.denominator > 0 ? [
    { type: 'bar', title: L.sov, metric: L.share, unit: '%', points: d.sov.entities.map((e: any) => ({ label: e.name ?? e.id, value: e.share ?? 0 })) },
    { type: 'table', title: L.sov, columns: [L.entity, L.articles, L.share], numeric: [1, 2], rows: d.sov.entities.map((e: any) => [e.name ?? e.id, fmtNum(e.articles, lang), fmtPct(e.share, lang)]),
      note: `${L.sovFormula} n = ${fmtNum(d.sov.eligibleArticles, lang)}.` },
    ...texts(d.sov.warningKeys, lang).map((w: string) => ({ type: 'paragraph' as const, kind: 'note' as const, text: w })),
  ] : [{ type: 'paragraph', kind: 'note', text: L.none }];
  const issuesTable: Block = d.issues.top.length ? { type: 'table', title: L.issues, columns: [L.title, L.severity, L.status, L.lastSeen],
    rows: d.issues.top.map((i: any) => [i.title, i.severity, i.status, fmtDate(i.last_detected_at, ctx.timezone, lang, true)]) } : { type: 'paragraph', kind: 'note', text: L.none };
  const publisherTable: Block = { type: 'table', title: L.sources, columns: [L.publisher, L.articles, L.share, L.days, L.lag], numeric: [1, 2, 3, 4],
    rows: d.sources.publishers.slice(0, 12).map((p: any) => [p.publisher ?? p.domain, fmtNum(p.articles, lang), fmtPct(p.share, lang), fmtNum(p.activeDays, lang), fmtNum(p.medianLagMinutes, lang)]),
    note: L.srcNote };
  const entityTable: Block = { type: 'table', title: L.entities, columns: [L.entity, L.articles, L.change], numeric: [1, 2],
    rows: d.entities.entities.slice(0, 10).map((e: any) => [e.name ?? e.id, fmtNum(e.articles, lang), fmtChange(e, lang)]) };
  const notableSources: Block = { type: 'sources', items: [] };
  const notableIntro: Block = { type: 'paragraph', kind: 'source_fact', text: lang === 'id'
    ? 'Judul berikut dikutip sebagaimana diterbitkan, dipilih dari klaster berita terbesar pada periode ini (satu artikel per klaster).'
    : 'The headlines below are quoted as published, selected from the largest story clusters in the period (one article per cluster).', refs: [] };

  const t = ctx.template;
  if (t === 'daily_briefing' || t === 'weekly_intelligence' || t === 'monthly_performance') {
    sections.push({ key: 'coverage', title: L.coverage, blocks: [timeline] });
    sections.push({ key: 'tone', title: L.tone, blocks: [toneTable, ...texts(sen.limitationKeys, lang).map((x: string) => ({ type: 'paragraph' as const, kind: 'note' as const, text: x }))] });
    if (t !== 'daily_briefing') sections.push({ key: 'sov', title: L.sov, blocks: sovBlocks });
    const topicBlocks: Block[] = [topicTable];
    if (t !== 'daily_briefing' && d.topics.emerging.length) topicBlocks.push({ type: 'table', title: L.emerging, columns: [L.topic, L.articles, L.change], numeric: [1, 2],
      rows: d.topics.emerging.slice(0, 5).map((x: any) => [x.label, fmtNum(x.current, lang), fmtChange(x, lang)]), note: L.emergingDef });
    sections.push({ key: 'topics', title: L.topics, blocks: topicBlocks });
    if (t !== 'daily_briefing') {
      sections.push({ key: 'entities', title: L.entities, blocks: [entityTable, ...(d.entities.coOccurrence.length ? [{ type: 'table' as const, title: L.coMention, columns: [L.entity, L.entity, L.articles], numeric: [2],
        rows: d.entities.coOccurrence.slice(0, 8).map((p: any) => [p.a.name ?? p.a.id, p.b.name ?? p.b.id, fmtNum(p.articles, lang)]), note: L.coDef }] : [])] });
      sections.push({ key: 'sources', title: L.sources, blocks: [publisherTable, { type: 'paragraph', kind: 'metric', text: `${lang === 'id' ? 'Indeks keragaman Simpson' : 'Simpson diversity'}: ${fmtNum(d.sources.diversity.simpson, lang, 3)}. ${L.divDef}` }] });
    }
    sections.push({ key: 'issues', title: L.issues, blocks: [issuesTable] });
    const notable = cite('notable', d.notable);
    notableSources.items = notable.map((a) => ({ id: a.id, ref: refOf.get(a.id)!, title: a.title, publisher: a.publisher, url: a.url, publishedAt: a.publishedAt }));
    sections.push({ key: 'notable', title: L.notable, blocks: notable.length ? [{ ...notableIntro, refs: refList(notable, refOf) }, notableSources] : [{ type: 'paragraph', kind: 'note', text: L.none }] });
    if (t !== 'daily_briefing' && d.negative.length) {
      const neg = cite('negative', d.negative);
      sections.push({ key: 'negative', title: L.negativeCoverage, blocks: [
        { type: 'paragraph', kind: 'source_fact', refs: refList(neg, refOf), text: lang === 'id' ? 'Artikel yang dilabeli bernada negatif oleh analisis (label otomatis, dapat keliru).' : 'Articles labelled negative by the analysis (automated labels; they can be wrong).' },
        { type: 'sources', items: neg.map((a) => ({ id: a.id, ref: refOf.get(a.id)!, title: a.title, publisher: a.publisher, url: a.url, publishedAt: a.publishedAt })) }] });
    }
  }

  if (t === 'issue_report') {
    if (d.focusIssue) {
      const i = d.focusIssue.issue;
      const det = i.detection ?? {};
      const ev = cite('issue_evidence', d.focusIssue.evidence);
      sections.push({ key: 'issue', title: i.title, blocks: [
        { type: 'kpis', items: [{ label: L.severity, value: i.severity }, { label: L.status, value: i.status }, { label: L.firstSeen, value: fmtDate(i.first_detected_at, ctx.timezone, lang, true) },
          { label: L.lastSeen, value: fmtDate(i.last_detected_at, ctx.timezone, lang, true) }, { label: L.evidence, value: fmtNum(d.focusIssue.evidence.length, lang) }] },
        { type: 'paragraph', kind: 'metric', text: `${lang === 'id' ? 'Dasar deteksi' : 'Detection basis'}: ${String(det.rationale ?? det.method ?? i.signal)}` },
        ...((det.limitations ?? []) as string[]).map((x) => ({ type: 'paragraph' as const, kind: 'note' as const, text: x })),
        { type: 'columns', title: `${L.evidence} / ${lang === 'id' ? 'hari' : 'day'}`, metric: L.evidence, unit: '', points: d.focusIssue.byDay.map((x) => ({ label: x.day.slice(5), value: x.n })) },
        { type: 'table', title: L.events, columns: [lang === 'id' ? 'Waktu' : 'Time', lang === 'id' ? 'Peristiwa' : 'Event'], rows: d.focusIssue.events.slice(0, 20).map((e: any) => [fmtDate(e.at, ctx.timezone, lang, true), e.event]) },
        { type: 'paragraph', kind: 'source_fact', refs: refList(ev, refOf), text: lang === 'id' ? 'Rekaman pendukung, judul sebagaimana diterbitkan:' : 'Supporting records, headlines as published:' },
        { type: 'sources', items: ev.map((a) => ({ id: a.id, ref: refOf.get(a.id)!, title: a.title, publisher: a.publisher, url: a.url, publishedAt: a.publishedAt })) },
      ] });
    } else {
      sections.push({ key: 'issues', title: L.issues, blocks: [issuesTable, { type: 'paragraph', kind: 'note', text: d.issues.definition }] });
    }
    sections.push({ key: 'coverage', title: L.coverage, blocks: [timeline, toneTable] });
    if (d.negative.length) {
      const neg = cite('negative', d.negative);
      sections.push({ key: 'negative', title: L.negativeCoverage, blocks: [{ type: 'sources', items: neg.map((a) => ({ id: a.id, ref: refOf.get(a.id)!, title: a.title, publisher: a.publisher, url: a.url, publishedAt: a.publishedAt })) }] });
    }
  }

  if (t === 'policy_monitoring') {
    sections.push({ key: 'coverage', title: L.coverage, blocks: [timeline, toneTable] });
    sections.push({ key: 'sov', title: L.sov, blocks: sovBlocks });
    for (const p of d.policy) {
      const arts = cite(`policy:${p.entity.id}`, p.articles);
      sections.push({ key: `policy:${p.entity.id}`, title: `${L.policyTitle}: ${p.entity.name ?? p.entity.id}`, blocks: [
        { type: 'kpis', items: [{ label: L.articles, value: fmtNum(p.entity.articles, lang) }, { label: L.positive, value: fmtNum(p.entity.positive, lang) }, { label: L.negative, value: fmtNum(p.entity.negative, lang) }] },
        { type: 'paragraph', kind: 'note', text: lang === 'id' ? 'Nada adalah nada artikel yang menyebut program ini, bukan penilaian atas program atau pendapat masyarakat.' : 'Tone is the tone of articles mentioning the programme, not an assessment of the programme or of public opinion.' },
        ...(arts.length ? [{ type: 'sources' as const, items: arts.map((a) => ({ id: a.id, ref: refOf.get(a.id)!, title: a.title, publisher: a.publisher, url: a.url, publishedAt: a.publishedAt })) }] : []),
      ] });
    }
    sections.push({ key: 'topics', title: L.topics, blocks: [topicTable] });
    sections.push({ key: 'sources', title: L.sources, blocks: [publisherTable] });
  }

  // AI claims may only cite records already cited by the deterministic sections.
  const commentary: Block[] = opts.claims.map((c) => ({ type: 'paragraph' as const, kind: 'ai_interpretation' as const, text: c.text,
    refs: c.supportingMentionIds.map((id) => refOf.get(id)).filter((x): x is string => !!x) })).filter((b) => b.refs.length > 0);
  if (commentary.length || opts.ai.requested) {
    sections.push({ key: 'ai', title: L.ai, blocks: commentary.length ? [
      { type: 'paragraph', kind: 'note', text: lang === 'id' ? 'Bagian ini dibuat oleh model AI dari rekaman yang dirujuk di atas, lalu divalidasi: klaim dengan angka di luar metrik laporan, klaim sebab-akibat, klaim opini publik atau efektivitas, dan kutipan yang tidak ditemukan di sumber dihapus. Ini interpretasi, bukan metrik.' : 'Written by an AI model from the records cited above, then validated: claims with numbers outside the report metrics, causal claims, public-opinion or effectiveness claims, and quotations not found in the sources were removed. This is interpretation, not a metric.' },
      ...commentary] : [{ type: 'paragraph', kind: 'note', text: opts.ai.method === 'unavailable'
        ? (lang === 'id' ? 'Komentar AI diminta tetapi tidak tersedia (tidak ada penyedia AI generatif yang dikonfigurasi, atau semua klaim gagal validasi).' : 'AI commentary was requested but is unavailable (no generative AI provider configured, or every claim failed validation).')
        : L.none }] });
  }
  if (ctx.analystNote) sections.push({ key: 'analyst', title: L.analyst, blocks: [{ type: 'paragraph', kind: 'analyst_recommendation', text: ctx.analystNote.text, attribution: `${ctx.analystNote.author}, ${fmtDate(ctx.analystNote.at, ctx.timezone, lang, true)}` }] });

  // Every reference in the model must resolve to a cited record (validated again by the generator against the database).
  for (const s of sections) for (const b of s.blocks) if (b.type === 'paragraph' && b.refs) b.refs = b.refs.filter((r) => [...refOf.values()].includes(r));

  const methodology = lang === 'id' ? [
    'Artikel unik = rekaman yang bukan duplikat atau hampir-duplikat dari rekaman sebelumnya. Rekaman = semua rekaman yang cocok dengan proyek, termasuk duplikat.',
    'Waktu artikel = waktu terbit dari penerbit; jika tidak ada, waktu koleksi. Periode setengah terbuka [awal, akhir) dalam zona waktu yang tercantum.',
    'Nada: label otomatis tingkat artikel dari analisis terkini. Pangsa = label/total label yang diketahui (positif, negatif, netral, campuran). Nada bersih = pangsa positif − pangsa negatif (poin persentase).',
    'Pangsa suara: artikel unik yang menyebut entitas ÷ jumlah artikel unik per entitas dalam kelompok × 100. Tanpa estimasi jangkauan, tayangan, atau nilai iklan.',
    'Semua angka dihitung secara deterministik dari data tersimpan, bukan oleh model AI.',
  ] : [
    'Unique articles = records that are not duplicates or near-duplicates of an earlier record. Records = all records matching the project, duplicates included.',
    'Article time = publisher-reported time, else collection time. Periods are half-open [start, end) in the time zone shown.',
    'Tone: automated article-level label from the current analysis. Shares = label ÷ known labels (positive, negative, neutral, mixed). Net tone = positive share − negative share (percentage points).',
    'Share of voice: unique articles mentioning the entity ÷ sum of unique articles per entity in the group × 100. No reach, impression or advertising-value estimates.',
    'All figures are computed deterministically from stored data, not by an AI model.',
  ];
  const limitations = [
    ...texts(sen.limitationKeys, lang),
    ...(lang === 'id' ? ['Cakupan terbatas pada sumber yang dikumpulkan untuk proyek ini; pemberitaan di luar sumber tersebut tidak terwakili.',
      'Laporan ini menggambarkan pemberitaan media; ini bukan ukuran opini publik, efektivitas komunikasi, atau hasil kebijakan.']
      : ['Coverage is limited to the sources collected for this project; coverage elsewhere is not represented.',
        'This report describes media coverage; it is not a measure of public opinion, communication effectiveness or policy outcomes.']),
  ];
  const attribution = [...new Set(sourcesList.map((a) => a.attribution).filter((x): x is string => !!x))];
  const model: ReportModel = {
    template: t, templateVersion: TEMPLATE_VERSION, title: ctx.name, subtitle: T[lang][t], language: lang,
    organization: ctx.organization, project: ctx.project, brandColor: ctx.brandColor, generatedAt: ctx.generatedAt.toISOString(),
    period: { from: ctx.from.toISOString(), to: ctx.to.toISOString(), timezone: ctx.timezone, label: periodLabel(ctx.from, ctx.to, ctx.timezone, lang) },
    sections, methodology, limitations, attribution, metrics: metricRegistry(d), ai: opts.ai,
  };
  return { model, cited };
}
