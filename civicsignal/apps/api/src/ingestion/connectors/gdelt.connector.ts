import { cacheValidUntil, Connector, ConnectorError, errorForStatus, FetchContext, FetchResult, RawRecord } from './connector';
import { httpErrorToConnector } from './feed.connector';

/**
 * GDELT DOC 2.0 article list (https://api.gdeltproject.org/api/v2/doc/doc). Public, no credentials.
 * Returns article URL, headline, domain, language and the time GDELT *saw* the article. It does not return the
 * publisher's publication time, so `publishedAt` stays null and the seen time is kept in provenance.
 * GDELT asks clients to send at most one request every 5 seconds (enforced by the host spacing gate).
 */
export interface GdeltConfig { query: string; timespan: string; maxRecords: number }

const ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const LANG: Record<string, string> = {
  indonesian: 'id', english: 'en', malay: 'ms', javanese: 'jv', chinese: 'zh', arabic: 'ar', japanese: 'ja', korean: 'ko',
  french: 'fr', german: 'de', spanish: 'es', portuguese: 'pt', russian: 'ru', dutch: 'nl', thai: 'th', vietnamese: 'vi', tagalog: 'tl',
};

export function parseGdeltSeenDate(v: unknown): Date | null {
  const m = typeof v === 'string' ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v) : null;
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : null;
}

export class GdeltConnector implements Connector<GdeltConfig> {
  readonly kind = 'gdelt' as const;
  readonly version = 'gdelt-doc2/1.0.0';
  readonly requiresCredentials = false;
  readonly requiresUrl = false;

  validateConfig(raw: unknown): GdeltConfig {
    const c = (raw ?? {}) as Record<string, unknown>;
    const extra = Object.keys(c).filter((k) => !['query', 'timespan', 'maxRecords'].includes(k));
    if (extra.length) throw new ConnectorError('unconfigured', `Unknown GDELT settings: ${extra.join(', ')}`);
    const query = typeof c.query === 'string' ? c.query.trim() : '';
    if (query.length < 3 || query.length > 500) throw new ConnectorError('unconfigured', 'GDELT query must be 3–500 characters');
    const timespan = typeof c.timespan === 'string' ? c.timespan : '1h';
    if (!/^(\d{1,3})(min|h|d)$/.test(timespan)) throw new ConnectorError('unconfigured', 'timespan must look like 15min, 1h or 1d');
    const maxRecords = c.maxRecords === undefined ? 75 : Number(c.maxRecords);
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 250) throw new ConnectorError('unconfigured', 'maxRecords must be 1–250');
    return { query, timespan, maxRecords };
  }

  buildUrl(c: GdeltConfig): string {
    const u = new URL(ENDPOINT);
    u.searchParams.set('query', c.query);
    u.searchParams.set('mode', 'artlist');
    u.searchParams.set('format', 'json');
    u.searchParams.set('sort', 'datedesc');
    u.searchParams.set('maxrecords', String(c.maxRecords));
    u.searchParams.set('timespan', c.timespan);
    return u.toString();
  }

  async fetch(ctx: FetchContext<GdeltConfig>): Promise<FetchResult> {
    let res;
    try { res = await ctx.http.get(this.buildUrl(ctx.config), { accept: 'application/json' }, ctx.signal); } catch (e) { throw httpErrorToConnector(e); }
    const body = res.body.toString('utf8');
    // GDELT sometimes answers rate limiting or query errors with a plain-text body.
    if (res.status === 429 || /limit requests to one every/i.test(body.slice(0, 300))) {
      throw new ConnectorError('rate_limited', 'GDELT rate limit: at most one request every 5 seconds', { httpStatus: res.status, retryAfterMs: 10_000 });
    }
    if (res.status !== 200) throw errorForStatus(res.status, res.headers['retry-after'], 'GDELT');
    if (!body.trim()) {
      return { status: 'ok', httpStatus: 200, records: [], rejected: [], cache: { etag: null, lastModified: null, validUntil: cacheValidUntil(res.headers) }, meta: { title: 'GDELT DOC 2.0', language: null, format: 'gdelt-json' } };
    }
    let data: { articles?: unknown };
    try { data = JSON.parse(body); } catch {
      throw new ConnectorError('malformed', `GDELT returned a non-JSON response: ${body.slice(0, 120).replace(/\s+/g, ' ')}`, { httpStatus: 200 });
    }
    const list = Array.isArray(data.articles) ? data.articles : [];
    const records: RawRecord[] = []; const rejected: FetchResult['rejected'] = [];
    list.slice(0, 250).forEach((a: Record<string, unknown>, index) => {
      const url = typeof a.url === 'string' ? a.url : null;
      const title = typeof a.title === 'string' ? a.title.trim() : '';
      if (!url || !/^https?:\/\//.test(url)) return rejected.push({ index, reason: 'missing_or_invalid_link' });
      if (!title) return rejected.push({ index, reason: 'missing_title' });
      records.push({
        url, title, summary: null, content: null, author: null, categories: [], publishedAt: null, publishedRaw: null, guid: null,
        language: LANG[String(a.language ?? '').toLowerCase()] ?? null,
        publisher: typeof a.domain === 'string' ? a.domain : null,
        extra: { gdeltSeenAt: parseGdeltSeenDate(a.seendate)?.toISOString() ?? null, sourceCountry: a.sourcecountry ?? null },
      });
    });
    return { status: 'ok', httpStatus: 200, records, rejected, cache: { etag: null, lastModified: null, validUntil: cacheValidUntil(res.headers) }, meta: { title: 'GDELT DOC 2.0', language: null, format: 'gdelt-json' } };
  }
}
