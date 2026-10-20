/**
 * Limitation and warning messages, keyed by code so that API responses (English) and reports (Indonesian or English)
 * state exactly the same limitation.
 */
export interface Note { code: string; p: Record<string, string | number> }
type Lang = 'id' | 'en';

const M: Record<string, Record<Lang, (p: Note['p']) => string>> = {
  small_tone_sample: {
    en: (p) => `Only ${p.n} articles have a known tone label; proportions are unstable at this sample size.`,
    id: (p) => `Hanya ${p.n} artikel yang memiliki label nada yang diketahui; proporsi tidak stabil pada ukuran sampel ini.`,
  },
  unanalysed: {
    en: (p) => `${p.n} articles are not analysed yet and are excluded from proportions.`,
    id: (p) => `${p.n} artikel belum dianalisis dan dikecualikan dari proporsi.`,
  },
  baseline_method: {
    en: () => 'Some tone labels come from the rule-based baseline (lexicon) method, which is less accurate than model-based analysis.',
    id: () => 'Sebagian label nada berasal dari metode dasar berbasis aturan (leksikon), yang kurang akurat dibanding analisis berbasis model.',
  },
  uncertain_share: {
    en: (p) => `${p.pct}% of known labels are low-confidence (uncertain).`,
    id: (p) => `${p.pct}% label yang diketahui berkeyakinan rendah (tidak pasti).`,
  },
  sov_mixed_types: {
    en: (p) => `The group mixes entity types (${p.types}); shares compare unlike things.`,
    id: (p) => `Kelompok mencampur jenis entitas (${p.types}); pangsa membandingkan hal yang tidak sebanding.`,
  },
  sov_small_sample: {
    en: (p) => `Only ${p.n} articles mention the selected entities; shares are unstable at this sample size.`,
    id: (p) => `Hanya ${p.n} artikel yang menyebut entitas terpilih; pangsa tidak stabil pada ukuran sampel ini.`,
  },
  sov_co_mentions: {
    en: (p) => `${p.n} article mention(s) are co-mentions (articles naming more than one selected entity); each is counted once per entity.`,
    id: (p) => `${p.n} penyebutan berasal dari artikel yang menyebut lebih dari satu entitas terpilih; masing-masing dihitung sekali per entitas.`,
  },
  sov_auto_group: {
    en: () => 'No entity group was chosen; the five most-mentioned organisations/people in scope were used.',
    id: () => 'Kelompok entitas tidak dipilih; lima organisasi/tokoh yang paling sering disebut dalam cakupan digunakan.',
  },
  sov_entity_filter_ignored: {
    en: () => 'The entity filter is ignored for share of voice; select the group instead.',
    id: () => 'Filter entitas diabaikan untuk pangsa suara; pilih kelompok entitas.',
  },
  no_sources_enabled: {
    en: () => 'No collection source is enabled; figures cover previously collected records only.',
    id: () => 'Tidak ada sumber koleksi yang aktif; angka hanya mencakup rekaman yang sudah dikumpulkan sebelumnya.',
  },
  stale_sources: {
    en: (p) => `${p.n} enabled source(s) have not collected successfully in the last ${p.hours} hours; recent coverage may be incomplete.`,
    id: (p) => `${p.n} sumber aktif belum berhasil mengumpulkan data dalam ${p.hours} jam terakhir; cakupan terbaru mungkin belum lengkap.`,
  },
  period_open: {
    en: () => 'The period ends at or near the present; records still being collected are not included yet.',
    id: () => 'Periode berakhir pada atau mendekati saat ini; rekaman yang masih dikumpulkan belum termasuk.',
  },
  csv_truncated: {
    en: (p) => `CSV export limited to the first ${p.rows} of ${p.total} records (per-tenant export limit).`,
    id: (p) => `Ekspor CSV dibatasi pada ${p.rows} dari ${p.total} rekaman pertama (batas ekspor per organisasi).`,
  },
};

export const note = (code: string, p: Note['p'] = {}): Note => ({ code, p });
export const noteText = (n: Note, lang: Lang = 'en'): string => M[n.code]?.[lang](n.p) ?? n.code;
export const texts = (ns: Note[], lang: Lang = 'en') => ns.map((n) => noteText(n, lang));
