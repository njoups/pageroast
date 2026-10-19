import { DEFAULT_TOPICS, TAXONOMY_VERSION, type CustomTopic } from './taxonomy';
import { normalizeName, sentences, tokenize } from './text';
import type { ArticleAnalysis, EntityType } from './schemas';

/**
 * Rule-based baseline analyzer. Deterministic, no network, no cost. Used when no LLM provider is configured and as
 * the configured fallback during provider outages. Every result it produces is labelled method = 'baseline'.
 * Deliberately conservative: it does not extract people, does not do entity-targeted sentiment, and returns
 * 'unknown' / 'insufficient_evidence' rather than guessing.
 */
export const BASELINE_MODEL = 'civicsignal-baseline';
export const BASELINE_VERSION = 'baseline/1';

// ── Entities ────────────────────────────────────────────────────────────────────────────────────
interface GazetteerEntry { names: string[]; display: string; type: EntityType }
const GAZETTEER: GazetteerEntry[] = [
  { names: ['KPK', 'Komisi Pemberantasan Korupsi'], display: 'Komisi Pemberantasan Korupsi (KPK)', type: 'government_institution' },
  { names: ['DPR', 'Dewan Perwakilan Rakyat'], display: 'Dewan Perwakilan Rakyat (DPR)', type: 'government_institution' },
  { names: ['MPR', 'Majelis Permusyawaratan Rakyat'], display: 'Majelis Permusyawaratan Rakyat (MPR)', type: 'government_institution' },
  { names: ['Polri', 'Kepolisian Negara Republik Indonesia'], display: 'Kepolisian Negara Republik Indonesia (Polri)', type: 'government_institution' },
  { names: ['TNI', 'Tentara Nasional Indonesia'], display: 'Tentara Nasional Indonesia (TNI)', type: 'government_institution' },
  { names: ['BNPB', 'Badan Nasional Penanggulangan Bencana'], display: 'Badan Nasional Penanggulangan Bencana (BNPB)', type: 'government_institution' },
  { names: ['BMKG', 'Badan Meteorologi, Klimatologi, dan Geofisika'], display: 'Badan Meteorologi, Klimatologi, dan Geofisika (BMKG)', type: 'government_institution' },
  { names: ['KPU', 'Komisi Pemilihan Umum'], display: 'Komisi Pemilihan Umum (KPU)', type: 'government_institution' },
  { names: ['Bawaslu', 'Badan Pengawas Pemilihan Umum'], display: 'Badan Pengawas Pemilihan Umum (Bawaslu)', type: 'government_institution' },
  { names: ['OJK', 'Otoritas Jasa Keuangan'], display: 'Otoritas Jasa Keuangan (OJK)', type: 'government_institution' },
  { names: ['Bank Indonesia'], display: 'Bank Indonesia', type: 'government_institution' },
  { names: ['BPJS Kesehatan'], display: 'BPJS Kesehatan', type: 'government_institution' },
  { names: ['Kejaksaan Agung', 'Kejagung'], display: 'Kejaksaan Agung', type: 'government_institution' },
  { names: ['Mahkamah Konstitusi'], display: 'Mahkamah Konstitusi', type: 'government_institution' },
  { names: ['Mahkamah Agung'], display: 'Mahkamah Agung', type: 'government_institution' },
  { names: ['PLN'], display: 'PT PLN (Persero)', type: 'organization' },
  { names: ['Pertamina'], display: 'Pertamina', type: 'organization' },
  { names: ['ASEAN'], display: 'ASEAN', type: 'organization' },
  { names: ['PBB', 'Perserikatan Bangsa-Bangsa', 'United Nations'], display: 'Perserikatan Bangsa-Bangsa (PBB)', type: 'organization' },
  { names: ['Pemilu'], display: 'Pemilihan Umum (Pemilu)', type: 'event' },
  { names: ['Pilkada'], display: 'Pemilihan Kepala Daerah (Pilkada)', type: 'event' },
];
const PROVINCES = ['Aceh', 'Sumatera Utara', 'Sumatera Barat', 'Riau', 'Kepulauan Riau', 'Jambi', 'Sumatera Selatan', 'Bangka Belitung', 'Bengkulu',
  'Lampung', 'DKI Jakarta', 'Jakarta', 'Jawa Barat', 'Banten', 'Jawa Tengah', 'DI Yogyakarta', 'Yogyakarta', 'Jawa Timur', 'Bali', 'Nusa Tenggara Barat',
  'Nusa Tenggara Timur', 'Kalimantan Barat', 'Kalimantan Tengah', 'Kalimantan Selatan', 'Kalimantan Timur', 'Kalimantan Utara', 'Sulawesi Utara',
  'Gorontalo', 'Sulawesi Tengah', 'Sulawesi Barat', 'Sulawesi Selatan', 'Sulawesi Tenggara', 'Maluku', 'Maluku Utara', 'Papua', 'Papua Barat',
  'Papua Selatan', 'Papua Tengah', 'Papua Pegunungan', 'Papua Barat Daya', 'Surabaya', 'Bandung', 'Medan', 'Semarang', 'Makassar', 'Palembang',
  'Denpasar', 'Pontianak', 'Balikpapan', 'Manado', 'Kupang', 'Mataram', 'Padang', 'Pekanbaru', 'Batam', 'Bogor', 'Bekasi', 'Depok', 'Tangerang',
  'Flores', 'Sumatra', 'Kalimantan', 'Sulawesi', 'Jawa', 'Indonesia'];
for (const p of PROVINCES) GAZETTEER.push({ names: [p], display: p, type: 'location' });

const CAP = "[A-Z][\\p{L}'\\-]+";
const CAPSEQ = `${CAP}(?:\\s+(?:dan\\s+|&\\s+)?${CAP}){0,5}`;
/** Pattern families: [regex, type, confidence]. Patterns need capitalised names, so ordinary lowercase text never matches. */
const PATTERNS: Array<[RegExp, EntityType, number]> = [
  [new RegExp(`\\b(?:Kementerian|Kemenko|Badan|Dinas|Komisi|Lembaga|Direktorat|Otoritas|Dewan)\\s+${CAPSEQ}`, 'gu'), 'government_institution', 0.7],
  [new RegExp(`\\b(?:Pemerintah\\s+(?:Kota|Kabupaten|Provinsi)|Pemkot|Pemkab|Pemprov|Polda|Polres|Polresta|Kodam|DPRD)\\s+${CAPSEQ}`, 'gu'), 'government_institution', 0.7],
  [new RegExp(`\\bMinistry\\s+of\\s+${CAPSEQ}`, 'gu'), 'government_institution', 0.7],
  [new RegExp(`\\b(?:Kabupaten|Kota|Provinsi|Kecamatan|Desa|Kelurahan)\\s+${CAPSEQ}`, 'gu'), 'location', 0.6],
  [new RegExp(`\\bPT\\.?\\s+${CAPSEQ}(?:\\s+Tbk)?`, 'gu'), 'organization', 0.65],
  [new RegExp(`\\b(?:Program|Gerakan|Kartu)\\s+${CAPSEQ}`, 'gu'), 'policy_program', 0.6],
  [/\b(?:UU|Undang-Undang|Perpres|Permen|Perda)\s+(?:Nomor\s+)?[\w/.-]*\d[\w/.-]*/gu, 'policy_program', 0.6],
];

function findAll(text: string, needle: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m.index);
  return out;
}

export function extractEntitiesBaseline(text: string): ArticleAnalysis['entities'] {
  // Collect every candidate span, then keep the longest non-overlapping ones, so "Dinas Pendidikan Kota Bandung"
  // wins over the gazetteer's "Bandung". On equal spans the gazetteer (curated, with aliases) wins.
  type Cand = { start: number; end: number; gazetteer: boolean; entity: ArticleAnalysis['entities'][number] };
  const cands: Cand[] = [];
  for (const g of GAZETTEER) {
    for (const name of g.names) {
      for (const at of findAll(text, name)) {
        cands.push({ start: at, end: at + name.length, gazetteer: true,
          entity: { type: g.type, name: g.display, aliases: g.names.filter((n) => n !== g.display), evidence: text.slice(at, at + name.length), confidence: 0.85 } });
      }
    }
  }
  for (const [re, type, confidence] of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const span = m[0].trim().replace(/[\s,.]+$/, '');
      if (span.split(/\s+/).length < 2) continue;
      cands.push({ start: m.index, end: m.index + span.length, gazetteer: false, entity: { type, name: span, aliases: [], evidence: span, confidence } });
    }
  }
  cands.sort((a, b) => (b.end - b.start) - (a.end - a.start) || Number(b.gazetteer) - Number(a.gazetteer) || a.start - b.start);
  const taken: Array<[number, number]> = [];
  const found = new Map<string, ArticleAnalysis['entities'][number]>();
  for (const c of cands) {
    if (taken.some(([a, b]) => c.start < b && c.end > a)) continue;
    taken.push([c.start, c.end]);
    const key = `${c.entity.type}|${normalizeName(c.entity.name)}`;
    if (!found.has(key)) found.set(key, c.entity);
  }
  return [...found.values()].slice(0, 25);
}

// ── Topics ──────────────────────────────────────────────────────────────────────────────────────
function cueHits(tokens: string[], joined: string, cues: string[]): string[] {
  const hits: string[] = [];
  for (const c of cues) {
    const cue = c.toLowerCase();
    if (cue.includes(' ')) { if (joined.includes(` ${cue} `)) hits.push(cue); continue; }
    const prefix = cue.endsWith('*');
    const stem = prefix ? cue.slice(0, -1) : cue;
    if (tokens.some((t) => (prefix ? t.startsWith(stem) : t === stem))) hits.push(cue);
  }
  return hits;
}

export function classifyTopicsBaseline(text: string, custom: CustomTopic[] = []): ArticleAnalysis['topics'] {
  const tokens = tokenize(text);
  const joined = ` ${tokens.join(' ')} `;
  const scored = [
    ...DEFAULT_TOPICS.filter((t) => t.cues.length).map((t) => ({ key: t.key, hits: cueHits(tokens, joined, t.cues) })),
    ...custom.map((t) => ({ key: t.key, hits: cueHits(tokens, joined, t.keywords) })),
  ].filter((s) => s.hits.length > 0).sort((a, b) => b.hits.length - a.hits.length);
  if (scored.length === 0) return [{ key: 'unknown', confidence: 0, evidence: [] }];
  const top = scored[0]!.hits.length;
  return scored.filter((s, i) => i === 0 || (s.hits.length >= 2 && s.hits.length >= top * 0.75)).slice(0, 3)
    .map((s) => ({ key: s.key, confidence: Math.min(0.85, 0.35 + 0.15 * s.hits.length), evidence: s.hits.slice(0, 5) }));
}

// ── Sentiment ───────────────────────────────────────────────────────────────────────────────────
const POSITIVE = ['puji', 'dipuji', 'memuji', 'pujian', 'sambut', 'menyambut', 'sukses', 'berhasil', 'meraih', 'juara', 'medali', 'apresiasi',
  'prestasi', 'terobosan', 'lancar', 'memangkas', 'efisien', 'membaik', 'meningkatkan', 'peningkatan', 'manfaat', 'inovasi', 'unggul', 'akurat',
  'tumbuh', 'diresmikan', 'resmikan', 'cepat', 'praise*', 'welcom*', 'improv*', 'success*', 'win', 'wins', 'won', 'gold', 'award*', 'achiev*',
  'boost*', 'efficient', 'accurate', 'benefit*', 'breakthrough', 'reduces', 'cut', 'cuts', 'opens', 'quickly', 'growth'];
const NEGATIVE = ['korupsi', 'gagal', 'kecewa', 'mengeluh', 'mengeluhkan', 'keluhan', 'kecam', 'kecaman', 'protes', 'unjuk', 'banjir', 'longsor',
  'bencana', 'korban', 'tewas', 'meninggal', 'kebakaran', 'rusak', 'kerusakan', 'melonjak', 'meroket', 'mahal', 'krisis', 'gangguan', 'terlambat',
  'macet', 'lambat', 'buruk', 'kritik', 'dikritik', 'digugat', 'gugatan', 'pencemaran', 'tersangka', 'ditangkap', 'penipuan', 'kewalahan',
  'mengungsi', 'pengungsi', 'polemik', 'dugaan', 'rendam', 'merendam', 'tidak adil', 'mengular', 'turun', 'corruption', 'fail*', 'complain*',
  'delay*', 'poor', 'flood*', 'evacuat*', 'crisis', 'contaminat*', 'sued', 'lawsuit*', 'backlash', 'overwhelm*', 'spike*', 'soar*', 'frustrat*',
  'criticis*', 'criticiz*', 'unfair', 'protest*', 'dead', 'killed', 'damage*', 'alleged', 'accident*', 'submerge*', 'falling', 'without'];
const NEGATORS = new Set(['tidak', 'bukan', 'belum', 'tanpa', 'tak', 'no', 'not', 'never', 'without']);

export function sentimentBaseline(text: string): ArticleAnalysis['sentiment'] {
  const tokens = tokenize(text);
  const joined = ` ${tokens.join(' ')} `;
  const pos: string[] = []; const neg: string[] = [];
  const match = (list: string[], sink: string[], polarity: 'pos' | 'neg') => {
    for (const w of list) {
      if (w.includes(' ')) { if (joined.includes(` ${w} `)) sink.push(w); continue; }
      const prefix = w.endsWith('*'); const stem = prefix ? w.slice(0, -1) : w;
      tokens.forEach((t, i) => {
        if (!(prefix ? t.startsWith(stem) : t === stem)) return;
        const negated = tokens.slice(Math.max(0, i - 2), i).some((p) => NEGATORS.has(p));
        // A negated negative word ("no evidence of a crime") is not positive; it just stops counting.
        if (negated && polarity === 'neg') return;
        if (negated && polarity === 'pos') { neg.push(t); return; } // evidence stays a verbatim token
        sink.push(t);
      });
    }
  };
  match(POSITIVE, pos, 'pos');
  match(NEGATIVE, neg, 'neg');
  const p = new Set(pos).size; const n = new Set(neg).size;
  let label: ArticleAnalysis['sentiment']['label']; let confidence: number;
  if (p === 0 && n === 0) { label = 'neutral'; confidence = 0.45; }
  else if (p > 0 && n > 0 && Math.min(p, n) / Math.max(p, n) >= 0.5) { label = 'mixed'; confidence = 0.5; }
  else { label = p > n ? 'positive' : 'negative'; confidence = Math.min(0.75, 0.45 + 0.1 * Math.abs(p - n)); }
  return {
    label, confidence, uncertain: confidence < 0.6,
    target: { type: 'article', name: null },
    evidence: [...new Set([...pos, ...neg])].slice(0, 6),
    rationale: `Lexicon cues: ${p} positive, ${n} negative. Article-level tone only; not attributed to any entity.`,
  };
}

// ── Extractive summary ──────────────────────────────────────────────────────────────────────────
/** Quotes the permitted excerpt/body; never writes new text. Headline-only records get no summary. */
export function extractiveSummary(excerpt: string | null, body: string | null): ArticleAnalysis['summary'] {
  const source = (body && body.length > (excerpt?.length ?? 0) ? body : excerpt) ?? '';
  const sents = sentences(source).filter((s) => s.length >= 25);
  if (source.length < 60 || sents.length === 0) {
    return { status: 'insufficient_evidence', claims: [], uncertainty: ['Only the headline is available under this source licence; no summary was generated.'] };
  }
  const picked: string[] = [];
  for (const s of sents) { if (picked.join(' ').length + s.length > 320) break; picked.push(s); if (picked.length === 2) break; }
  if (picked.length === 0) picked.push(sents[0]!.slice(0, 317) + '…');
  return { status: 'ok', claims: picked.map((s) => ({ text: s, kind: 'source_fact' as const, quote: s })), uncertainty: ['Extractive summary: sentences quoted from the permitted source text, not generated.'] };
}

export function analyzeBaseline(input: { title: string; excerpt: string | null; body: string | null; customTopics?: CustomTopic[] }): ArticleAnalysis {
  const text = [input.title, input.excerpt ?? '', input.body ?? ''].join('\n');
  return {
    entities: extractEntitiesBaseline(text),
    topics: classifyTopicsBaseline(text, input.customTopics),
    sentiment: sentimentBaseline(text),
    entitySentiments: [],
    summary: extractiveSummary(input.excerpt, input.body),
    taxonomyVersion: TAXONOMY_VERSION,
  };
}
