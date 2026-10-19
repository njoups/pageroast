import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheValidUntil, ConnectorError, errorForStatus, parseRetryAfter, type Connector, type FetchContext } from '../../../src/ingestion/connectors/connector';
import { FeedConnector } from '../../../src/ingestion/connectors/feed.connector';
import { GdeltConnector, parseGdeltSeenDate } from '../../../src/ingestion/connectors/gdelt.connector';
import { HttpFetchError, type SafeHttpClient, type SafeResponse } from '../../../src/ingestion/safe-http';

/** Deterministic fake of SafeHttpClient: records requests, returns canned responses. Labelled mock: no network. */
function fakeHttp(responses: Array<Partial<SafeResponse> | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const http = {
    async get(url: string, headers: Record<string, string> = {}) {
      calls.push({ url, headers });
      const r = responses.shift();
      if (!r) throw new Error('no fake response left');
      if (r instanceof Error) throw r;
      return { status: 200, headers: {}, body: Buffer.alloc(0), finalUrl: url, ...r } as SafeResponse;
    },
  } as unknown as SafeHttpClient;
  return { http, calls };
}
const ctx = <C>(http: SafeHttpClient, config: C, url: string | null = 'https://news.example/rss'): FetchContext<C> =>
  ({ config, url, http, cache: { etag: '"v1"', lastModified: 'Mon, 19 Oct 2026 00:00:00 GMT' }, credentials: null });

describe('connector contract (both connectors)', () => {
  const cases: Array<[string, Connector, unknown, string | null]> = [
    ['feed', new FeedConnector() as Connector, {}, 'https://news.example/rss'],
    ['gdelt', new GdeltConnector() as Connector, { query: 'banjir sourcecountry:indonesia' }, null],
  ];
  it.each(cases)('%s maps HTTP failures to the shared taxonomy without retrying access-control errors', async (_n, connector, raw, url) => {
    const cfg = connector.validateConfig(raw);
    for (const [status, kind, retryable] of [[401, 'auth', false], [403, 'forbidden', false], [404, 'not_found', false], [503, 'server', true]] as const) {
      const { http } = fakeHttp([{ status }]);
      await expect(connector.fetch(ctx(http, cfg, url))).rejects.toMatchObject({ kind, retryable });
    }
  });
  it.each(cases)('%s maps network failures and timeouts to retryable errors', async (_n, connector, raw, url) => {
    const cfg = connector.validateConfig(raw);
    for (const [err, kind] of [[new HttpFetchError('timeout', 't'), 'timeout'], [new HttpFetchError('network', 'n'), 'network'], [new HttpFetchError('unsafe', 'u'), 'unsafe']] as const) {
      const { http } = fakeHttp([err]);
      await expect(connector.fetch(ctx(http, cfg, url))).rejects.toMatchObject({ kind });
    }
  });
  it.each(cases)('%s rate limiting carries Retry-After', async (_n, connector, raw, url) => {
    const { http } = fakeHttp([{ status: 429, headers: { 'retry-after': '30' } }]);
    const e = await connector.fetch(ctx(http, connector.validateConfig(raw), url)).catch((x: ConnectorError) => x);
    expect(e).toBeInstanceOf(ConnectorError);
    expect((e as ConnectorError).kind).toBe('rate_limited');
    expect((e as ConnectorError).opts.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('FeedConnector', () => {
  const feed = new FeedConnector();
  const rss = readFileSync(join(__dirname, '../../fixtures/feeds/rss2.xml'));
  it('sends conditional headers and returns not_modified on 304', async () => {
    const { http, calls } = fakeHttp([{ status: 304, headers: { etag: '"v1"' } }]);
    const r = await feed.fetch(ctx(http, {}));
    expect(calls[0]!.headers).toMatchObject({ 'if-none-match': '"v1"', 'if-modified-since': 'Mon, 19 Oct 2026 00:00:00 GMT' });
    expect(r).toMatchObject({ status: 'not_modified', records: [] });
  });
  it('returns normalisable records, new validators and cache hints', async () => {
    const { http } = fakeHttp([{ status: 200, body: rss, headers: { etag: '"v2"', 'cache-control': 'max-age=600' } }]);
    const r = await feed.fetch(ctx(http, {}));
    expect(r.records).toHaveLength(3);
    expect(r.rejected).toHaveLength(3);
    expect(r.cache.etag).toBe('"v2"');
    expect(r.cache.validUntil!.getTime()).toBeGreaterThan(Date.now() + 590_000);
  });
  it('treats an HTML login page as malformed (not retried, no bypass attempted)', async () => {
    const { http } = fakeHttp([{ status: 200, body: readFileSync(join(__dirname, '../../fixtures/feeds/paywall.html')) }]);
    await expect(feed.fetch(ctx(http, {}))).rejects.toMatchObject({ kind: 'malformed', retryable: false });
  });
  it('rejects configuration it does not understand', () => {
    expect(() => feed.validateConfig({ username: 'x' })).toThrow(/no configuration/);
  });
});

describe('GdeltConnector (deterministic fixtures; not a live response)', () => {
  const g = new GdeltConnector();
  const body = readFileSync(join(__dirname, '../../fixtures/gdelt-artlist.json'));
  it('validates configuration', () => {
    expect(g.validateConfig({ query: 'banjir' })).toEqual({ query: 'banjir', timespan: '1h', maxRecords: 75 });
    expect(() => g.validateConfig({})).toThrow(/3–500/);
    expect(() => g.validateConfig({ query: 'banjir', maxRecords: 1000 })).toThrow(/1–250/);
    expect(() => g.validateConfig({ query: 'banjir', timespan: 'forever' })).toThrow(/timespan/);
    expect(() => g.validateConfig({ query: 'banjir', apiKey: 'x' })).toThrow(/Unknown/);
  });
  it('builds the documented artlist request', () => {
    const u = new URL(g.buildUrl({ query: 'banjir', timespan: '1h', maxRecords: 75 }));
    expect([u.host, u.pathname, u.searchParams.get('mode'), u.searchParams.get('format'), u.searchParams.get('query')]).toEqual(['api.gdeltproject.org', '/api/v2/doc/doc', 'artlist', 'json', 'banjir']);
  });
  it('maps articles, languages and rejects invalid items; never invents a publication date', async () => {
    const { http } = fakeHttp([{ status: 200, body }]);
    const r = await g.fetch(ctx(http, g.validateConfig({ query: 'banjir' }), null));
    expect(r.records.map((x) => [x.publisher, x.language, x.publishedAt])).toEqual([['portal.example', 'id', null], ['other.example', 'en', null]]);
    expect(r.records[0]!.extra).toMatchObject({ gdeltSeenAt: '2026-10-19T08:15:00.000Z' });
    expect(r.rejected.map((x) => x.reason)).toEqual(['missing_or_invalid_link', 'missing_title']);
  });
  it('recognises GDELT plain-text throttling and non-JSON errors', async () => {
    const { http } = fakeHttp([{ status: 200, body: Buffer.from('Please limit requests to one every 5 seconds or contact us') }, { status: 200, body: Buffer.from('Invalid query: phrase too short') }, { status: 200, body: Buffer.from('') }]);
    const cfg = g.validateConfig({ query: 'banjir' });
    await expect(g.fetch(ctx(http, cfg, null))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(g.fetch(ctx(http, cfg, null))).rejects.toMatchObject({ kind: 'malformed' });
    await expect(g.fetch(ctx(http, cfg, null))).resolves.toMatchObject({ records: [] });
  });
  it('parses seen dates strictly', () => {
    expect(parseGdeltSeenDate('20261019T081500Z')!.toISOString()).toBe('2026-10-19T08:15:00.000Z');
    expect(parseGdeltSeenDate('yesterday')).toBeNull();
  });
});

describe('HTTP helpers', () => {
  it('parses Retry-After seconds and dates, capped at 6h', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
    expect(parseRetryAfter('999999')).toBe(6 * 3600 * 1000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
  it('honours Cache-Control and Expires, ignores no-cache', () => {
    const now = Date.UTC(2026, 9, 19);
    expect(cacheValidUntil({ 'cache-control': 'public, max-age=300' }, now)!.getTime()).toBe(now + 300_000);
    expect(cacheValidUntil({ 'cache-control': 'no-cache, max-age=300' }, now)).toBeNull();
    // Real-world case: a live news feed served with a 60-day CDN max-age is capped (default 1 hour).
    expect(cacheValidUntil({ 'cache-control': 'max-age=5184000' }, now, 3600)!.getTime()).toBe(now + 3600 * 1000);
    expect(cacheValidUntil({ 'cache-control': ['max-age=5184000', 'public'] as unknown as string }, now, 3600)!.getTime()).toBe(now + 3600 * 1000);
    expect(cacheValidUntil({ expires: new Date(now + 120_000).toUTCString() }, now)!.getTime()).toBe(now + 120_000);
  });
  it('451 Unavailable For Legal Reasons is treated as forbidden', () => {
    expect(errorForStatus(451, undefined, 'x').kind).toBe('forbidden');
  });
});
