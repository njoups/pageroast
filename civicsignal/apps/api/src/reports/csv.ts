/**
 * CSV export (RFC 4180): every field quoted, quotes doubled, CRLF line endings, UTF-8 with BOM (so spreadsheet apps
 * read Indonesian characters correctly). Spreadsheet formula injection is neutralised: a cell beginning with = + - @,
 * tab or carriage return (after optional whitespace) is prefixed with a single quote.
 */
export type Cell = string | number | boolean | null | undefined | Date;

const DANGEROUS = /^[\s]*[=+\-@\t\r]/;

export function csvCell(v: Cell): string {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Numbers are written as numbers; negative numbers are data, not formulas.
  if (typeof v !== 'number' && DANGEROUS.test(s)) s = `'${s}`;
  s = s.replace(/\u0000/g, ''); // eslint-disable-line no-control-regex
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(columns: readonly string[], rows: Cell[][]): Buffer {
  const lines = [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((_, i) => csvCell(r[i])).join(','))];
  return Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

/** Stable column order for the article export. Changing it is a breaking change: add columns at the end only. */
export const ARTICLE_COLUMNS = [
  'report_run_id', 'period_start', 'period_end', 'timezone', 'project', 'mention_id', 'published_at', 'collected_at', 'publisher', 'publisher_domain',
  'title', 'url', 'language', 'sentiment', 'sentiment_uncertain', 'analysis_method', 'topics', 'entities', 'story_cluster_id', 'cited_in_sections', 'excerpt', 'excerpt_omitted_reason',
] as const;

/** Whether a source's licence allows redistributing the excerpt in an export. Full bodies are never exported. */
export function excerptAllowed(permittedFields: string[] | null, redistributionRestrictions: string | null): { ok: boolean; reason: string | null } {
  if (redistributionRestrictions && redistributionRestrictions.trim()) return { ok: false, reason: 'source_redistribution_restricted' };
  if (!permittedFields?.includes('excerpt')) return { ok: false, reason: 'excerpt_not_permitted_by_source' };
  return { ok: true, reason: null };
}

/** ASCII, lowercase file names: [a-z0-9._-] only, ≤ 120 characters. User-entered names never reach headers raw. */
export function safeFilename(base: string, ext: 'pdf' | 'csv'): string {
  const s = base.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/-{2,}/g, '-').slice(0, 100);
  return `${s || 'report'}.${ext}`;
}
