import { ConnectorError, emptyUsage } from '../../../src/ingestion/connectors/connector';
import { getConnector } from '../../../src/ingestion/connectors/registry';
import { extractHashtags, presentMetrics, YoutubeConnector, youtubeQuotaDay, type YoutubeConfig } from '../../../src/ingestion/connectors/youtube.connector';
import type { SafeHttpClient } from '../../../src/ingestion/safe-http';
import { PROVIDERS, providerForKind } from '../../../src/social/providers';
import { quotaShortfall } from '../../../src/social/quota';
import { derivedAnalysisAllowed } from '../../../src/social/rights';

/** Mock HTTP: deterministic, synthetic YouTube-shaped responses. No network. */
function fakeHttp(routes: Record<string, (q: URLSearchParams) => { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const http = {
    async get(url: string, headers: Record<string, string> = {}) {
      calls.push({ url, headers });
      const u = new URL(url); const path = u.pathname.split('/').pop()!;
      const h = routes[path];
      const r = h ? h(u.searchParams) : { status: 404, body: { error: { errors: [{ reason: 'notFound' }] } } };
      return { status: r.status ?? 200, headers: {}, body: Buffer.from(JSON.stringify(r.body)), finalUrl: url };
    },
  } as unknown as SafeHttpClient;
  return { http, calls };
}

const yt = new YoutubeConnector();
const video = (id: string, o: { title?: string; description?: string; stats?: Record<string, string>; live?: string; channelId?: string } = {}) => ({
  id, snippet: { title: o.title ?? `Video ${id}`, description: o.description ?? '', channelId: o.channelId ?? 'UCaaaaaaaaaaaaaaaaaaaaaa', channelTitle: 'Kanal Contoh',
    publishedAt: '2026-10-19T03:00:00Z', liveBroadcastContent: o.live ?? 'none', defaultLanguage: 'id' }, statistics: o.stats ?? { viewCount: '10' },
});

describe('YouTube connector: configuration', () => {
  it('applies documented defaults and validates every setting', () => {
    const c = yt.validateConfig({ query: 'banjir jakarta' });
    expect(c).toMatchObject({ mode: 'search', regionCode: 'ID', relevanceLanguage: 'id', maxResults: 25, maxPages: 1, includeComments: false, quotaPerDay: { search: 100, units: 10_000 } });
  });
  it.each([
    [{ query: 'x' }, /2–200/],
    [{ mode: 'channel' }, /at least one channel/],
    [{ mode: 'channel', channelIds: ['not-a-channel'] }, /channel ids/],
    [{ mode: 'channel', channelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa'], query: 'banjir' }, /does not take a query/],
    [{ query: 'banjir', maxResults: 51 }, /maxResults/],
    [{ query: 'banjir', maxPages: 5 }, /maxPages/],
    [{ query: 'banjir', regionCode: 'idn' }, /regionCode/],
    [{ query: 'banjir', includeComments: 'yes' }, /includeComments/],
    [{ query: 'banjir', apiKey: 'x' }, /Unknown YouTube settings: apiKey/],
    [{ query: 'banjir', quotaPerDay: { units: 0 } }, /quotaPerDay.units/],
  ])('rejects %j', (cfg, err) => {
    expect(() => yt.validateConfig(cfg)).toThrow(err);
    try { yt.validateConfig(cfg); } catch (e) { expect((e as ConnectorError).kind).toBe('unconfigured'); }
  });
  it('estimates the worst-case quota of one sync per bucket', () => {
    expect(yt.estimateSyncUsage(yt.validateConfig({ query: 'banjir', maxPages: 3, includeComments: true, maxVideosForComments: 4 }))).toEqual({ search: 3, units: 7 });
    expect(yt.estimateSyncUsage(yt.validateConfig({ mode: 'channel', channelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa', 'UCbbbbbbbbbbbbbbbbbbbbbb'], maxPages: 2 }))).toEqual({ search: 0, units: 9 });
  });
});

describe('YouTube connector: requests and normalisation', () => {
  const cfg: YoutubeConfig = yt.validateConfig({ query: 'banjir', includeComments: true, maxVideosForComments: 1 });
  const ctx = (http: SafeHttpClient, credentials: string | null = 'TEST-KEY-not-a-real-key') => ({ config: cfg, url: null, http, cache: { etag: null, lastModified: null }, credentials });

  it('sends the key in the X-Goog-Api-Key header, never in the URL, and counts quota per bucket', async () => {
    const { http, calls } = fakeHttp({
      search: () => ({ body: { items: [{ id: { videoId: 'vidAAAAAAAA' } }, { id: { videoId: 'vidBBBBBBBB' } }, { id: { channelId: 'UCx' } }] } }),
      videos: () => ({ body: { items: [
        video('vidAAAAAAAA', { title: 'Banjir di #Jakarta, warga mengungsi', description: 'Liputan #banjir #BanjirJakarta', stats: { viewCount: '1200', likeCount: '50', commentCount: '3' } }),
        video('vidBBBBBBBB', { stats: { viewCount: '7' }, live: 'live' }),
      ] } }),
      commentThreads: () => ({ body: { items: [{ snippet: { totalReplyCount: 2, topLevelComment: { id: 'UgxCOMMENT1', snippet: { textOriginal: 'Semoga cepat surut #banjir', authorDisplayName: 'Warga', authorChannelId: { value: 'UCcccccccccccccccccccccc' }, likeCount: 4, publishedAt: '2026-10-19T04:00:00Z', videoId: 'vidAAAAAAAA' } } } }] } }),
    });
    const r = await yt.fetch(ctx(http));
    for (const c of calls) {
      expect(c.url).not.toMatch(/TEST-KEY|key=/i);
      expect(c.headers['x-goog-api-key']).toBe('TEST-KEY-not-a-real-key');
    }
    expect(calls.map((c) => new URL(c.url).pathname.split('/').pop())).toEqual(['search', 'videos', 'commentThreads']);
    expect(new URL(calls[0]!.url).searchParams.get('type')).toBe('video');
    expect(r.usage).toEqual({ buckets: { search: { requests: 1, units: 1 }, units: { requests: 2, units: 2 } }, rateLimited: 0 });
    const [a, b, comment] = r.records;
    expect(a).toMatchObject({ url: 'https://www.youtube.com/watch?v=vidAAAAAAAA', guid: 'vidAAAAAAAA', language: 'id',
      social: { platform: 'youtube', contentType: 'video', externalId: 'vidAAAAAAAA', authorRef: 'UCaaaaaaaaaaaaaaaaaaaaaa',
        hashtags: ['jakarta', 'banjir', 'banjirjakarta'], engagement: { viewCount: 1200, likeCount: 50, commentCount: 3 } } });
    // Hidden like counts stay absent (never zero); live broadcasts are labelled as such.
    expect(b!.social).toMatchObject({ contentType: 'live_stream', engagement: { viewCount: 7 } });
    expect(b!.social!.engagement).not.toHaveProperty('likeCount');
    expect(comment).toMatchObject({ url: 'https://www.youtube.com/watch?v=vidAAAAAAAA&lc=UgxCOMMENT1',
      social: { contentType: 'comment', parentExternalId: 'vidAAAAAAAA', engagement: { likeCount: 4, totalReplyCount: 2 }, hashtags: ['banjir'] } });
  });

  it('maps provider errors without echoing credentials, and keeps usage of failed calls', async () => {
    const reason = (r: string, status = 403) => fakeHttp({ search: () => ({ status, body: { error: { code: status, message: `bad API key TEST-KEY`, errors: [{ reason: r }] } } }) }).http;
    const fail = async (http: SafeHttpClient) => { try { await yt.fetch(ctx(http)); } catch (e) { return e as ConnectorError; } throw new Error('expected failure'); };
    const q = await fail(reason('quotaExceeded'));
    expect(q.kind).toBe('quota'); expect(q.retryable).toBe(false);
    expect(q.opts.resumeAt!.getTime()).toBe(youtubeQuotaDay().resetsAt.getTime());
    expect(q.opts.usage!.buckets.search).toEqual({ requests: 1, units: 1 });
    const rl = await fail(reason('rateLimitExceeded'));
    expect(rl.kind).toBe('rate_limited'); expect(rl.retryable).toBe(true); expect(rl.opts.usage!.rateLimited).toBe(1);
    const key = await fail(reason('keyInvalid', 400));
    expect(key.kind).toBe('auth'); expect(key.message).not.toMatch(/TEST-KEY/);
    expect((await fail(reason('accessNotConfigured'))).kind).toBe('forbidden');
    expect((await fail(fakeHttp({ search: () => ({ status: 503, body: {} }) }).http)).kind).toBe('server');
    expect((await fail(fakeHttp({}).http)).kind).toBe('not_found');
    await expect(yt.fetch(ctx(fakeHttp({}).http, null))).rejects.toMatchObject({ kind: 'unconfigured' });
  });

  it('treats comments disabled on one video as a rejection, not a failed collection', async () => {
    const { http } = fakeHttp({
      search: () => ({ body: { items: [{ id: { videoId: 'vidAAAAAAAA' } }] } }),
      videos: () => ({ body: { items: [video('vidAAAAAAAA')] } }),
      commentThreads: () => ({ status: 403, body: { error: { errors: [{ reason: 'commentsDisabled' }] } } }),
    });
    const r = await yt.fetch(ctx(http));
    expect(r.records).toHaveLength(1);
    expect(r.rejected).toEqual([{ index: -1, reason: 'comments_unavailable:vidAAAAAAAA' }]);
  });

  it('refresh reports records the provider no longer returns (deleted or private)', async () => {
    const { http } = fakeHttp({
      videos: () => ({ body: { items: [video('vidAAAAAAAA', { stats: { viewCount: '2000' } })] } }),
      comments: () => ({ body: { items: [] } }),
    });
    const r = await yt.refresh(ctx(http), [{ externalId: 'vidAAAAAAAA', contentType: 'video' }, { externalId: 'vidGONEGONE', contentType: 'video' }, { externalId: 'UgxGONE123', contentType: 'comment' }]);
    expect(r.records.map((x) => x.social!.engagement.viewCount)).toEqual([2000]);
    expect(r.missing.sort()).toEqual(['UgxGONE123', 'vidGONEGONE']);
    expect(r.usage.buckets.units).toEqual({ requests: 2, units: 2 });
  });

  it('connection test uses one videos.list unit', async () => {
    const { http, calls } = fakeHttp({ videos: () => ({ body: { items: [{ id: 'vidAAAAAAAA' }] } }) });
    const r = await yt.testConnection(ctx(http));
    expect(r.usage.buckets).toEqual({ units: { requests: 1, units: 1 } });
    expect(new URL(calls[0]!.url).searchParams.get('chart')).toBe('mostPopular');
  });

  it('rejects malformed items instead of inventing fields', () => {
    expect(yt.normalizeVideo({ id: 'bad id!', snippet: { title: 'x' } })).toBeNull();
    expect(yt.normalizeVideo({ id: 'vidAAAAAAAA', snippet: { title: '' } })).toBeNull();
    expect(yt.normalizeComment({ id: 'UgxCOMMENT1', snippet: { textOriginal: '   ' } }, 'vidAAAAAAAA')).toBeNull();
  });
});

describe('metrics and hashtags', () => {
  it('keeps only metrics the provider returned', () => {
    expect(presentMetrics({ viewCount: '5', likeCount: undefined, commentCount: '', favoriteCount: '-1', dislikeCount: '3' }, ['viewCount', 'likeCount', 'commentCount', 'favoriteCount'])).toEqual({ viewCount: 5 });
    expect(presentMetrics(undefined, ['viewCount'])).toEqual({});
  });
  it('extracts written hashtags only (Unicode, de-duplicated, not from URLs or HTML entities)', () => {
    expect(extractHashtags('Banjir #Jakarta #jakarta #Pemprov_DKI', 'lihat https://x.test/#anchor dan &#39; #KotaTua2026')).toEqual(['jakarta', 'pemprov_dki', 'kotatua2026']);
    expect(extractHashtags('tanpa tagar')).toEqual([]);
  });
  it('computes the Pacific-time quota day across daylight-saving changes', () => {
    expect(youtubeQuotaDay(new Date('2026-10-20T06:59:00Z'))).toEqual({ day: '2026-10-19', resetsAt: new Date('2026-10-20T07:00:00Z') });
    expect(youtubeQuotaDay(new Date('2026-12-01T08:30:00Z'))).toEqual({ day: '2026-12-01', resetsAt: new Date('2026-12-02T08:00:00Z') });
  });
});

describe('provider descriptors', () => {
  it('every implemented provider has a registered connector with matching declared capabilities', () => {
    for (const p of PROVIDERS.filter((x) => x.implementation === 'implemented')) {
      const c = getConnector(p.kind!);
      expect(c).toBeDefined();
      expect(p.operations.length).toBeGreaterThan(0);
      expect(p.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.docs.length).toBeGreaterThan(0);
      if (p.operations.includes('refresh')) expect(typeof c!.refresh).toBe('function');
      if (p.operations.includes('connection_test')) expect(typeof c!.testConnection).toBe('function');
      for (const op of Object.keys(p.unsupported)) expect(p.operations).not.toContain(op);
      expect(p.liveVerified).toBe(false);      // no live credentials were available in this milestone
    }
  });
  it('providers without a connector declare no operations and say why', () => {
    for (const p of PROVIDERS.filter((x) => x.implementation === 'not_implemented')) {
      expect(p.kind).toBeNull(); expect(p.operations).toEqual([]);
      expect(Object.values(p.unsupported).every((r) => typeof r === 'string' && r.length > 10)).toBe(true);
    }
  });
  it('YouTube declares the verified storage and analysis terms', () => {
    expect(providerForKind('youtube')!.rights).toMatchObject({ storageMaxDays: 30, refreshWithinDays: 30, deletionOnRequestDays: 7, derivedAnalysis: 'requires_approval', metricAggregation: 'restricted' });
    expect(providerForKind('youtube')!.quota.buckets.map((b) => [b.key, b.perDay])).toEqual([['search', 100], ['units', 10_000]]);
  });
  it('derived analysis needs a recorded approval where the provider requires one', () => {
    expect(derivedAnalysisAllowed({ rights: {}, derived_analysis_approved_at: null })).toBe(true);           // news sources
    expect(derivedAnalysisAllowed({ rights: { derivedAnalysis: 'requires_approval' }, derived_analysis_approved_at: null })).toBe(false);
    expect(derivedAnalysisAllowed({ rights: { derivedAnalysis: 'requires_approval' }, derived_analysis_approved_at: new Date() })).toBe(true);
    expect(derivedAnalysisAllowed({ rights: { derivedAnalysis: 'unverified' }, derived_analysis_approved_at: new Date() })).toBe(false);
  });
  it('quota shortfall compares the worst case with what is left per bucket', () => {
    const q = { provider: 'youtube', day: 'd', resetsAt: null, exhausted: false, buckets: [
      { key: 'search', label: 's', limit: 100, used: 99, remaining: 1, requests: 99 }, { key: 'units', label: 'u', limit: 10_000, used: 0, remaining: 10_000, requests: 0 }] };
    expect(quotaShortfall(q, { search: 2, units: 3 })).toEqual([{ bucket: 'search', need: 2, remaining: 1 }]);
    expect(quotaShortfall(q, { search: 1 })).toEqual([]);
  });
  it('empty usage report starts at zero', () => { expect(emptyUsage()).toEqual({ buckets: {}, rateLimited: 0 }); });
});
