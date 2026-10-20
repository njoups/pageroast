import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  title: string;
  link: string;
  guid: string | null;
  summary: string | null;           // feed-provided description/summary (plain text)
  content: string | null;           // full content if the feed embeds it (used only when the licence permits)
  author: string | null;
  categories: string[];
  publishedAt: Date | null;
  publishedRaw: string | null;
}
export interface ParsedFeed {
  format: 'rss2' | 'rss1' | 'atom';
  title: string | null;
  link: string | null;
  language: string | null;
  items: FeedItem[];
  rejected: Array<{ index: number; reason: string }>;
}

export class FeedParseError extends Error {
  constructor(message: string) { super(message); this.name = 'FeedParseError'; }
}

export const MAX_ITEMS = 500;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['item', 'entry', 'category', 'link', 'author', 'dc:subject'].includes(name),
});

type Node = Record<string, unknown> | string | undefined;

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return text(o['#text']);
    if ('name' in o) return text(o.name);
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Feed text is untrusted: strip markup, decode entities, collapse whitespace. Output is plain text only. */
/**
 * Removes tags, and script/style elements with their content, in one linear pass (indexOf scans never revisit text).
 * Regex equivalents are quadratic on hostile input such as thousands of unclosed tags. An unclosed tag or element drops
 * the remainder of the text.
 */
export function stripTags(v: string): string {
  let out = ''; let i = 0; const lower = v.toLowerCase();
  while (i < v.length) {
    const lt = v.indexOf('<', i);
    if (lt < 0) { out += v.slice(i); break; }
    out += v.slice(i, lt) + ' ';
    const m = /^<(script|style)\b/.exec(lower.slice(lt, lt + 8));
    if (m) {
      const close = lower.indexOf(`</${m[1]}`, lt + 1);
      if (close < 0) break;
      const end = v.indexOf('>', close);
      if (end < 0) break;
      i = end + 1; continue;
    }
    const gt = v.indexOf('>', lt + 1);
    if (gt < 0) break;
    i = gt + 1;
  }
  return out;
}

/** Untrusted markup is truncated before regex stripping so pathological input (e.g. many unclosed tags) stays linear-bounded. */
export const MAX_MARKUP_CHARS = 200_000;
export function plainText(v: string | null, max?: number): string | null {
  if (!v) return null;
  let s = stripTags(v.length > MAX_MARKUP_CHARS ? v.slice(0, MAX_MARKUP_CHARS) : v);
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // eslint-disable-next-line no-control-regex -- deliberately strips control characters from untrusted feed text
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return max && s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const ID_MONTHS: Record<string, string> = {
  januari: 'Jan', februari: 'Feb', maret: 'Mar', april: 'Apr', mei: 'May', juni: 'Jun', juli: 'Jul', agustus: 'Aug',
  september: 'Sep', oktober: 'Oct', november: 'Nov', desember: 'Dec',
  jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', jun: 'Jun', jul: 'Jul', agu: 'Aug', agt: 'Aug', ags: 'Aug',
  sep: 'Sep', okt: 'Oct', nov: 'Nov', des: 'Dec',
};
const ID_DAYS = /^(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|sen|sel|rab|kam|jum|sab|min)\s*,\s*/i;

/** RFC 822 / ISO 8601 dates, plus Indonesian month and day names used by local publishers. Null when unparseable. */
export function parseFeedDate(raw: string | null, now = Date.now()): Date | null {
  if (!raw) return null;
  let s = raw.trim();
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    s = s.replace(ID_DAYS, '').replace(/\b([A-Za-z]+)\b/g, (w) => ID_MONTHS[w.toLowerCase()] ?? w).replace(/\bWIB\b/, '+0700').replace(/\bWITA\b/, '+0800').replace(/\bWIT\b/, '+0900');
    t = Date.parse(s);
  }
  if (Number.isNaN(t)) return null;
  // Publication dates more than a day in the future are publisher clock/format errors: treat as unknown.
  if (t > now + 24 * 3600 * 1000 || t < Date.UTC(1995, 0, 1)) return null;
  return new Date(t);
}

function atomLink(links: unknown): string | null {
  const arr = (Array.isArray(links) ? links : [links]).filter(Boolean) as Array<Record<string, string> | string>;
  const pick = arr.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) ?? arr[0];
  if (!pick) return null;
  return typeof pick === 'string' ? pick : pick['@_href'] ?? text(pick);
}

function absoluteHttpUrl(v: string | null, base: string | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim(), base ?? undefined);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

function categoriesOf(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return [...new Set(arr.map((c) => (typeof c === 'object' && c && '@_term' in c ? (c as Record<string, string>)['@_term']! : text(c)))
    .map((c) => plainText(c ?? null, 80)).filter((c): c is string => !!c))].slice(0, 20);
}

export function parseFeed(xml: string, feedUrl: string | null = null): ParsedFeed {
  if (!xml || !xml.trim()) throw new FeedParseError('Empty response body');
  // Entity declarations enable expansion attacks (billion laughs) and are never needed by real feeds.
  if (/<!ENTITY/i.test(xml)) throw new FeedParseError('Feeds declaring XML entities are rejected');
  const head = xml.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) throw new FeedParseError('Received an HTML page, not a feed');
  let doc: Record<string, Node>;
  try { doc = parser.parse(xml, true) as Record<string, Node>; }
  catch (e) { throw new FeedParseError(`Malformed XML: ${(e as Error).message.split('\n')[0]}`); }

  const rss = doc.rss as Record<string, Node> | undefined;
  const rdf = (doc['rdf:RDF'] ?? doc.RDF) as Record<string, Node> | undefined;
  const atom = doc.feed as Record<string, Node> | undefined;
  const out: ParsedFeed = { format: 'rss2', title: null, link: null, language: null, items: [], rejected: [] };
  let rawItems: Array<Record<string, unknown>> = [];

  if (rss && typeof rss === 'object' && rss.channel) {
    const ch = (Array.isArray(rss.channel) ? rss.channel[0] : rss.channel) as Record<string, unknown>;
    out.title = plainText(text(ch.title), 200);
    out.link = absoluteHttpUrl(text(Array.isArray(ch.link) ? ch.link.find((l) => typeof l === 'string') ?? ch.link[0] : ch.link), feedUrl);
    out.language = text(ch.language)?.toLowerCase().slice(0, 10) ?? null;
    rawItems = (ch.item as Array<Record<string, unknown>> | undefined) ?? [];
  } else if (rdf && typeof rdf === 'object') {
    out.format = 'rss1';
    const ch = rdf.channel as Record<string, unknown> | undefined;
    out.title = plainText(text(ch?.title), 200);
    out.language = text(ch?.['dc:language'])?.toLowerCase().slice(0, 10) ?? null;
    rawItems = (rdf.item as unknown as Array<Record<string, unknown>> | undefined) ?? [];
  } else if (atom && typeof atom === 'object') {
    out.format = 'atom';
    out.title = plainText(text(atom.title), 200);
    out.link = absoluteHttpUrl(atomLink(atom.link), feedUrl);
    out.language = (typeof atom === 'object' ? (atom as Record<string, string>)['@_xml:lang'] : null)?.toLowerCase() ?? null;
    rawItems = (atom.entry as unknown as Array<Record<string, unknown>> | undefined) ?? [];
  } else {
    throw new FeedParseError('Document is neither RSS nor Atom');
  }

  const base = out.link ?? feedUrl;
  rawItems.slice(0, MAX_ITEMS).forEach((it, index) => {
    const isAtom = out.format === 'atom';
    const title = plainText(text(it.title), 500);
    const link = absoluteHttpUrl(isAtom ? atomLink(it.link) : text(it.link) ?? (it.guid && (it.guid as Record<string, string>)['@_isPermaLink'] !== 'false' ? text(it.guid) : null), base);
    if (!title) return out.rejected.push({ index, reason: 'missing_title' });
    if (!link) return out.rejected.push({ index, reason: 'missing_or_invalid_link' });
    const publishedRaw = text(isAtom ? it.published ?? it.updated : it.pubDate ?? it['dc:date'] ?? it.date);
    const authorRaw = isAtom ? text((it.author as unknown[] | undefined)?.[0]) : text(it['dc:creator'] ?? it.author);
    out.items.push({
      title,
      link,
      guid: plainText(text(isAtom ? it.id : it.guid), 500),
      summary: plainText(text(isAtom ? it.summary : it.description), 1000),
      content: plainText(text(isAtom ? it.content : it['content:encoded'])),
      author: plainText(authorRaw, 200),
      categories: categoriesOf(it.category ?? it['dc:subject']),
      publishedAt: parseFeedDate(publishedRaw),
      publishedRaw,
    });
  });
  if (rawItems.length > MAX_ITEMS) out.rejected.push({ index: MAX_ITEMS, reason: `item_limit_exceeded:${rawItems.length - MAX_ITEMS}` });
  return out;
}
