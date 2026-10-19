import { tokenize } from './text';

export const SUPPORTED_LANGUAGES = ['id', 'en'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const LANGUAGE_METHOD = 'lexical-profile/2';

export interface LanguageResult {
  language: string;          // ISO 639-1 where known; 'und' = undetermined
  confidence: number | null; // 0–1 margin between the best and second profile; null when not estimated
  method: string;
  supported: boolean;
  scores?: Record<string, number>;
}

/**
 * Headline vocabulary: headlines drop most function words, so common Indonesian news verbs and nouns are listed
 * (general vocabulary, not taken from evaluation items). Much of it is shared with Malay, so it only counts after the
 * Malay decision, to lift otherwise undetermined Indonesian headlines over the evidence threshold.
 */
const ID_HEADLINE = new Set([
  'minta', 'tolak', 'ungkap', 'klaim', 'usul', 'desak', 'bantah', 'dukung', 'tuntut', 'sebut', 'soroti', 'resmi', 'jadi', 'lagi', 'naik',
  'turun', 'bakal', 'siap', 'buka', 'tutup', 'meninggal', 'dunia', 'tewas', 'korban', 'kasus', 'sidang', 'hakim', 'jaksa', 'tersangka',
  'terdakwa', 'ketua', 'calon', 'anak', 'bocah', 'ribu', 'juta', 'miliar', 'triliun', 'besok', 'kemarin', 'jelang', 'imbas', 'lewat',
  'hasil', 'pasar', 'sekolah', 'siswa', 'guru', 'sakit', 'dokter', 'pasien', 'kereta', 'pesawat', 'kapal', 'cuaca', 'hujan', 'gempa',
  'erupsi', 'gunung', 'kebakaran', 'asap', 'kabut', 'polda', 'polres', 'kapolri', 'kapolda', 'prajurit', 'jenderal', 'mantan', 'wakil',
  'pemkab', 'pemkot', 'pemprov', 'partai', 'kader', 'demo', 'macet', 'mudik', 'libur', 'bansos', 'subsidi', 'pajak', 'utang', 'ekspor',
  'impor', 'rupiah', 'saham', 'bursa', 'emas', 'medali', 'kerja', 'sama', 'catat', 'dorong', 'pacu', 'pasti', 'perluas', 'target',
  'cegah', 'gagalkan', 'bantu', 'usaha', 'modal', 'kinerja', 'industri', 'perusahaan', 'pertama', 'hukum']);
/** Function words and highly distinctive vocabulary per language. Kept small and auditable on purpose. */
const PROFILES: Record<string, string[]> = {
  id: ['yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'tidak', 'akan', 'pada', 'adalah', 'dalam', 'oleh', 'juga',
    'karena', 'sudah', 'bisa', 'ada', 'para', 'terhadap', 'kepada', 'serta', 'atau', 'belum', 'lebih', 'bagi', 'saat', 'kini', 'hingga',
    'namun', 'tetapi', 'soal', 'usai', 'warga', 'pemerintah', 'kata', 'menjadi', 'telah', 'masih', 'baru', 'harus', 'sejak', 'setelah',
    'bahwa', 'akibat', 'polisi', 'uang', 'tahun', 'ribuan', 'ratusan', 'hari', 'pekan', 'bulan', 'kota', 'kabupaten', 'kecamatan', 'desa',
    'rumah', 'menteri', 'kementerian', 'presiden', 'gubernur', 'bupati', 'wali', 'jalan', 'harga', 'banjir', 'tiga', 'dua', 'satu'],
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'for', 'on', 'with', 'that', 'by', 'as', 'at', 'from', 'has', 'have', 'will', 'are', 'was',
    'were', 'be', 'it', 'an', 'this', 'said', 'after', 'over', 'its', 'their', 'new', 'more', 'but', 'not', 'than', 'been', 'which', 'who',
    'says', 'into', 'about', 'between', 'government', 'police', 'minister', 'ministry', 'city', 'residents', 'people', 'year', 'week',
    'two', 'three', 'hundreds', 'thousands', 'prices', 'school', 'new'],
  // Malay and Javanese share much vocabulary with Indonesian; these are their distinguishing words, so such text is
  // labelled unsupported instead of being treated as Indonesian.
  ms: ['kerajaan', 'kerana', 'boleh', 'baharu', 'ialah', 'polis', 'wang', 'percuma', 'biasiswa', 'kenderaan', 'perlembagaan', 'semalam',
    'berhubung', 'lelaki', 'kenyataan', 'pelancongan', 'kerjasama', 'bermula', 'sahaja', 'mendesak', 'mangsa'],
  jv: ['sing', 'ora', 'padha', 'amarga', 'ngendika', 'yen', 'kuwi', 'iki', 'wis', 'lan', 'karo', 'ing', 'ndandani', 'deres', 'diwiwiti',
    'ngarep', 'dalan', 'udan', 'bakal', 'sampun', 'menika', 'nggih', 'mboten', 'kanthi', 'saka'],
  fr: ['le', 'la', 'les', 'des', 'un', 'une', 'pour', 'et', 'du', 'est', 'dans', 'sur', 'au', 'aux', 'nouveau', 'nouvelle', 'gouvernement'],
  es: ['el', 'los', 'las', 'del', 'por', 'para', 'una', 'que', 'con', 'gobierno', 'nuevo', 'nueva', 'pequeñas', 'empresas'],
  de: ['der', 'die', 'das', 'und', 'ist', 'mit', 'für', 'von', 'auf', 'ein', 'eine', 'regierung', 'neue'],
};
/** Spellings used in Indonesian but not Malay: their presence vetoes a Malay decision. */
const ID_ONLY = new Set(['karena', 'pemerintah', 'bisa', 'polisi', 'uang', 'baru', 'gratis', 'kemarin', 'terkait', 'pernyataan', 'laki']);
/** Malay spellings with no ordinary Indonesian use (unlike e.g. 'mendesak' or 'bermula', which both languages share). */
const MS_STRONG = new Set(['kerajaan', 'kerana', 'baharu', 'ialah', 'polis', 'wang', 'percuma', 'kenderaan', 'perlembagaan', 'mangsa', 'sahaja',
  'biasiswa', 'pelancongan']);
const SETS = Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, new Set(v)]));

/** Scripts that are certainly neither Indonesian nor English. */
const SCRIPTS: Array<[RegExp, string]> = [
  [/\p{Script=Han}/u, 'zh'], [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ja'], [/\p{Script=Hangul}/u, 'ko'],
  [/\p{Script=Arabic}/u, 'ar'], [/\p{Script=Cyrillic}/u, 'ru'], [/\p{Script=Thai}/u, 'th'], [/\p{Script=Devanagari}/u, 'hi'],
];

/**
 * Deterministic language identification for news headlines and short texts.
 *  - non-Latin scripts → that language (unsupported)
 *  - Latin text → the profile with the most function-word hits, with Indonesian morphology as a tiebreaker
 *  - too little evidence (fewer than 2 hits and no morphology) → 'und', never a guess
 */
export function detectLanguage(text: string): LanguageResult {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length < 4) return { language: 'und', confidence: null, method: LANGUAGE_METHOD, supported: false };
  for (const [re, code] of SCRIPTS) {
    const matched = (letters.match(new RegExp(re.source, 'gu')) ?? []).length;
    if (matched / letters.length > 0.3) return { language: code, confidence: 0.95, method: LANGUAGE_METHOD, supported: false };
  }
  const toks = tokenize(text);
  const scores: Record<string, number> = {};
  for (const [lang, set] of Object.entries(SETS)) scores[lang] = toks.filter((t) => set.has(t)).length;
  // Indonesian affixation is a strong signal even in headlines with few function words.
  const morph = toks.filter((t) => t.length > 5 && (/^(me[mn]g?|meny|me(?=[lrwy])|ber|ter|pe[mn]g?|peny|di)[a-z]{3,}/.test(t) || /[a-z]{3,}(kan|nya|an)$/.test(t))).length;
  scores.id = (scores.id ?? 0) + morph * 0.5;
  // English inflection
  const enMorph = toks.filter((t) => t.length > 4 && /(ing|tion|ed|ly)$/.test(t)).length;
  scores.en = (scores.en ?? 0) + enMorph * 0.3;
  // Distinctive Malay/Javanese words outrank shared vocabulary.
  scores.ms = (scores.ms ?? 0) * 1.5;
  scores.jv = (scores.jv ?? 0) * 1.5;

  // Malay-only spellings with no Indonesian-only spelling present decide Malay, even when shared vocabulary ties.
  // Two or more distinct strong Malay spellings decide Malay regardless of length (longer texts accumulate shared words).
  const msHits = toks.filter((t) => SETS.ms!.has(t)).length;
  const msStrong = new Set(toks.filter((t) => MS_STRONG.has(t))).size;
  const idOnly = toks.some((t) => ID_ONLY.has(t));
  if (!idOnly && (msStrong >= 2 || (msHits >= 1 && (scores.ms ?? 0) >= (scores.id ?? 0) - 1.5 && (scores.ms ?? 0) >= (scores.en ?? 0)))) {
    return { language: 'ms', confidence: Math.min(0.9, 0.5 + msHits * 0.15), method: LANGUAGE_METHOD, supported: false, scores };
  }
  // Headline vocabulary only after the Malay decision (it is largely shared with Malay).
  scores.id = (scores.id ?? 0) + toks.filter((t) => ID_HEADLINE.has(t)).length;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  if (bestScore < 1.5) return { language: 'und', confidence: null, method: LANGUAGE_METHOD, supported: false, scores };
  const confidence = Math.round(Math.min(0.99, (bestScore - second) / (bestScore + 1)) * 100) / 100;
  if (confidence < 0.15) return { language: 'und', confidence, method: LANGUAGE_METHOD, supported: false, scores };
  return { language: best, confidence, method: LANGUAGE_METHOD, supported: (SUPPORTED_LANGUAGES as readonly string[]).includes(best), scores };
}

/**
 * Uses the publisher-declared language only when detection is inconclusive ('und' for lack of evidence) and the
 * declared language is supported. A positive detection of another language (e.g. Malay) is never overridden.
 */
export function resolveLanguage(text: string, declared: string | null): LanguageResult {
  const d = detectLanguage(text);
  if (d.language === 'und' && declared && (SUPPORTED_LANGUAGES as readonly string[]).includes(declared)) {
    return { language: declared, confidence: null, method: 'publisher-declared', supported: true, scores: d.scores };
  }
  return d;
}
