import { HttpFetchError } from '../safe-http';
import { FeedParseError, parseFeed } from '../feed-parser';
import { cacheValidUntil, Connector, ConnectorError, errorForStatus, FetchContext, FetchResult } from './connector';

export type FeedConfig = Record<string, never>;

export function httpErrorToConnector(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (e instanceof HttpFetchError) {
    const kind = e.kind === 'unsafe' || e.kind === 'redirect' ? 'unsafe' : e.kind === 'too_large' ? 'malformed' : e.kind;
    return new ConnectorError(kind, e.message);
  }
  return new ConnectorError('network', (e as Error).message ?? 'Unknown network error');
}

/** RSS 2.0, RSS 1.0 (RDF) and Atom feeds. One conditional GET per run; never fetches article pages. */
export class FeedConnector implements Connector<FeedConfig> {
  readonly kind = 'feed' as const;
  readonly version = 'feed/1.0.0';
  readonly requiresCredentials = false;
  readonly requiresUrl = true;

  validateConfig(raw: unknown): FeedConfig {
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Object.keys(raw as object).length > 0)) {
      throw new ConnectorError('unconfigured', 'Feed connectors take no configuration; set the feed URL on the source');
    }
    return {};
  }

  async fetch(ctx: FetchContext<FeedConfig>): Promise<FetchResult> {
    if (!ctx.url) throw new ConnectorError('unconfigured', 'Source has no feed URL');
    const headers: Record<string, string> = { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1' };
    if (ctx.cache.etag) headers['if-none-match'] = ctx.cache.etag;
    if (ctx.cache.lastModified) headers['if-modified-since'] = ctx.cache.lastModified;
    let res;
    try { res = await ctx.http.get(ctx.url, headers, ctx.signal); } catch (e) { throw httpErrorToConnector(e); }
    const cache = {
      etag: (res.headers.etag as string | undefined) ?? ctx.cache.etag,
      lastModified: (res.headers['last-modified'] as string | undefined) ?? ctx.cache.lastModified,
      validUntil: cacheValidUntil(res.headers),
    };
    if (res.status === 304) return { status: 'not_modified', httpStatus: 304, records: [], rejected: [], cache, meta: { title: null, language: null, format: 'unchanged' } };
    if (res.status !== 200) throw errorForStatus(res.status, res.headers['retry-after'], 'The feed server');
    let parsed;
    try { parsed = parseFeed(res.body.toString('utf8'), res.finalUrl); }
    catch (e) { throw new ConnectorError('malformed', e instanceof FeedParseError ? e.message : 'Feed could not be parsed', { httpStatus: 200 }); }
    return {
      status: 'ok', httpStatus: 200, cache, rejected: parsed.rejected,
      meta: { title: parsed.title, language: parsed.language, format: parsed.format },
      records: parsed.items.map((i) => ({
        url: i.link, title: i.title, summary: i.summary, content: i.content, author: i.author, categories: i.categories,
        publishedAt: i.publishedAt, publishedRaw: i.publishedRaw, guid: i.guid, language: parsed.language, publisher: parsed.title,
      })),
    };
  }
}
