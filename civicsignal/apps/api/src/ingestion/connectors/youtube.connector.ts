import { localParts, zonedToUtc, addDays } from '../../analytics/tz';
import {
  addUsage, Connector, ConnectorError, emptyUsage, errorForStatus, FetchContext, FetchResult, RawRecord, RefreshResult, UsageReport,
} from './connector';
import { httpErrorToConnector } from './feed.connector';

/**
 * YouTube Data API v3 (public data, API key). Documentation read 2026-10-20 (see social/providers.ts):
 *  - search.list costs 1 call from the "Search Queries" bucket (default 100/day); videos.list, channels.list,
 *    playlistItems.list, commentThreads.list and comments.list cost 1 unit each from the 10,000 units/day bucket.
 *  - Quotas reset at midnight Pacific Time.
 * The key travels in the X-Goog-Api-Key header, never in a URL, so it cannot end up in logs or run records.
 * Only public resources are requested. 401/403 are never retried or worked around.
 */
export interface YoutubeConfig {
  mode: 'search' | 'channel';
  query: string | null;
  channelIds: string[];
  regionCode: string | null;
  relevanceLanguage: string | null;
  lookbackHours: number;
  maxResults: number;
  maxPages: number;
  includeComments: boolean;
  maxVideosForComments: number;
  maxCommentThreads: number;
  /** Daily quota per bucket when the Google Cloud project has an approved quota extension; defaults from the docs. */
  quotaPerDay: { search: number; units: number };
}

export const YOUTUBE_DEFAULT_QUOTA = { search: 100, units: 10_000 } as const;
export const YOUTUBE_QUOTA_TZ = 'America/Los_Angeles';
const DEFAULT_BASE = 'https://www.googleapis.com/youtube/v3';
const KEYS = ['mode', 'query', 'channelIds', 'regionCode', 'relevanceLanguage', 'lookbackHours', 'maxResults', 'maxPages',
  'includeComments', 'maxVideosForComments', 'maxCommentThreads', 'quotaPerDay'];

/** Test-only override of the API base URL (refused in production by config validation). */
export const youtubeBaseUrl = () => process.env.YOUTUBE_API_BASE_URL || DEFAULT_BASE;

/** The provider quota day (YYYY-MM-DD in Pacific Time) containing `t`, and when it ends. */
export function youtubeQuotaDay(t = new Date()): { day: string; resetsAt: Date } {
  const p = localParts(t, YOUTUBE_QUOTA_TZ);
  const n = addDays(p.y, p.m, p.d, 1);
  return { day: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, resetsAt: zonedToUtc(n.y, n.m, n.d, 0, 0, YOUTUBE_QUOTA_TZ) };
}

// A hashtag starts the text or follows a character that cannot be part of a URL or entity ("/#frag", "?a=#x", "&#39;").
const HASHTAG = /(?:^|[^\p{L}\p{N}_&/=?#])#([\p{L}\p{N}_]{2,100})/gu;
/** Hashtags written in the text (lower-cased, unique, at most 30). Nothing is inferred. */
export function extractHashtags(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(HASHTAG)) { out.add(m[1]!.toLowerCase()); if (out.size >= 30) break; }
  return [...out];
}

/** Only numeric statistics actually present in the response; hidden or missing counts are omitted, never zeroed. */
export function presentMetrics(stats: Record<string, unknown> | undefined, names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of names) {
    const v = stats?.[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

const VIDEO_METRICS = ['viewCount', 'likeCount', 'commentCount', 'favoriteCount'];
const isoOrNull = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : new Date(t); };
const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider JSON, every field is validated where it is read
type Json = Record<string, any>;

export class YoutubeConnector implements Connector<YoutubeConfig> {
  readonly kind = 'youtube' as const;
  readonly version = 'youtube-data-v3/1.0.0';
  readonly requiresCredentials = true;
  readonly requiresUrl = false;
  readonly apiHost = 'www.googleapis.com';

  validateConfig(raw: unknown): YoutubeConfig {
    const c = (raw ?? {}) as Record<string, unknown>;
    const bad = (m: string) => new ConnectorError('unconfigured', m);
    const extra = Object.keys(c).filter((k) => !KEYS.includes(k));
    if (extra.length) throw bad(`Unknown YouTube settings: ${extra.join(', ')}`);
    const mode = c.mode === undefined ? 'search' : c.mode;
    if (mode !== 'search' && mode !== 'channel') throw bad('mode must be "search" or "channel"');
    const query = typeof c.query === 'string' ? c.query.trim() : null;
    const channelIds = c.channelIds === undefined ? [] : c.channelIds;
    if (!Array.isArray(channelIds) || channelIds.length > 20 || !channelIds.every((x) => typeof x === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(x))) {
      throw bad('channelIds must be up to 20 YouTube channel ids (UC followed by 22 characters)');
    }
    if (mode === 'search' && (!query || query.length < 2 || query.length > 200)) throw bad('A keyword search needs a query of 2–200 characters');
    if (mode === 'channel' && !channelIds.length) throw bad('Channel monitoring needs at least one channel id');
    if (mode === 'channel' && query) throw bad('Channel monitoring does not take a query; project queries are matched after collection');
    const str = (v: unknown, re: RegExp, name: string, dflt: string | null) => {
      if (v === undefined) return dflt; if (v === null) return null;
      if (typeof v !== 'string' || !re.test(v)) throw bad(`${name} is invalid`); return v;
    };
    const int = (v: unknown, lo: number, hi: number, dflt: number, name: string) => {
      const n = v === undefined ? dflt : Number(v);
      if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name} must be an integer ${lo}–${hi}`); return n;
    };
    const includeComments = c.includeComments === undefined ? false : c.includeComments;
    if (typeof includeComments !== 'boolean') throw bad('includeComments must be true or false');
    const q = (c.quotaPerDay ?? {}) as Record<string, unknown>;
    if (typeof q !== 'object' || Object.keys(q).some((k) => !['search', 'units'].includes(k))) throw bad('quotaPerDay takes search and units');
    return {
      mode, query: mode === 'search' ? query : null, channelIds: channelIds as string[],
      regionCode: str(c.regionCode, /^[A-Z]{2}$/, 'regionCode', 'ID'),
      relevanceLanguage: str(c.relevanceLanguage, /^[a-z]{2}(-[A-Za-z]{2,4})?$/, 'relevanceLanguage', 'id'),
      lookbackHours: int(c.lookbackHours, 1, 720, 48, 'lookbackHours'),
      maxResults: int(c.maxResults, 1, 50, 25, 'maxResults'),
      maxPages: int(c.maxPages, 1, 4, 1, 'maxPages'),
      includeComments,
      maxVideosForComments: int(c.maxVideosForComments, 1, 10, 5, 'maxVideosForComments'),
      maxCommentThreads: int(c.maxCommentThreads, 1, 100, 20, 'maxCommentThreads'),
      quotaPerDay: { search: int(q.search, 1, 1_000_000, YOUTUBE_DEFAULT_QUOTA.search, 'quotaPerDay.search'), units: int(q.units, 1, 100_000_000, YOUTUBE_DEFAULT_QUOTA.units, 'quotaPerDay.units') },
    };
  }

  estimateSyncUsage(c: YoutubeConfig): Record<string, number> {
    const comments = c.includeComments ? c.maxVideosForComments : 0;
    if (c.mode === 'search') return { search: c.maxPages, units: c.maxPages + comments };
    const channelCalls = Math.ceil(c.channelIds.length / 50);
    return { search: 0, units: channelCalls + c.channelIds.length * c.maxPages * 2 + comments };
  }

  private async call(ctx: FetchContext<YoutubeConfig>, path: string, params: Record<string, string | number | undefined>, usage: UsageReport, bucket: 'search' | 'units') {
    const u = new URL(`${youtubeBaseUrl()}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    if (!ctx.credentials) throw new ConnectorError('unconfigured', 'YouTube API key is not configured', { usage });
    addUsage(usage, bucket);
    let res;
    try { res = await ctx.http.get(u.toString(), { accept: 'application/json', 'x-goog-api-key': ctx.credentials }, ctx.signal); }
    catch (e) { const err = httpErrorToConnector(e); throw new ConnectorError(err.kind, err.message, { ...err.opts, usage }); }
    const text = res.body.toString('utf8');
    let data: Json | null = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.status !== 200) throw this.providerError(res.status, data, res.headers['retry-after'], usage);
    if (!data || typeof data !== 'object') throw new ConnectorError('malformed', 'YouTube returned a non-JSON response', { httpStatus: res.status, usage });
    return data;
  }

  /** Maps YouTube error reasons; messages never echo request URLs or keys. */
  providerError(status: number, data: Json | null, retryAfter: string | string[] | undefined, usage: UsageReport): ConnectorError {
    const reason = String(data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? '');
    if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) {
      const { resetsAt } = youtubeQuotaDay();
      return new ConnectorError('quota', 'YouTube daily quota for this API key is exhausted; collection pauses until the quota resets (midnight Pacific Time)',
        { httpStatus: status, usage, resumeAt: resetsAt, retryAfterMs: Math.max(resetsAt.getTime() - Date.now(), 0) });
    }
    if (/rateLimitExceeded|userRateLimitExceeded/i.test(reason)) { usage.rateLimited++; return new ConnectorError('rate_limited', 'YouTube rate-limited the request', { httpStatus: status, usage, retryAfterMs: 60_000 }); }
    if (/keyInvalid|API_KEY_INVALID|keyExpired/i.test(reason) || (status === 400 && /API key/i.test(String(data?.error?.message ?? '')))) {
      return new ConnectorError('auth', 'YouTube rejected the API key (invalid, expired or restricted)', { httpStatus: status, usage });
    }
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason)) return new ConnectorError('forbidden', 'YouTube Data API v3 is not enabled for this API key’s Google Cloud project', { httpStatus: status, usage });
    if (/channelNotFound|videoNotFound|playlistNotFound/i.test(reason)) return new ConnectorError('not_found', `YouTube: ${reason}`, { httpStatus: status, usage });
    if (status === 429) usage.rateLimited++;
    const e = errorForStatus(status, retryAfter, 'YouTube');
    return new ConnectorError(e.kind, reason ? `${e.message} (${reason})` : e.message, { ...e.opts, usage });
  }

  async fetch(ctx: FetchContext<YoutubeConfig>): Promise<FetchResult> {
    const c = ctx.config; const usage = emptyUsage();
    const publishedAfter = new Date(Date.now() - c.lookbackHours * 3_600_000).toISOString();
    const ids: string[] = [];
    if (c.mode === 'search') {
      let pageToken: string | undefined;
      for (let page = 0; page < c.maxPages; page++) {
        const d = await this.call(ctx, 'search', { part: 'snippet', type: 'video', q: c.query!, order: 'date', maxResults: c.maxResults, publishedAfter,
          regionCode: c.regionCode ?? undefined, relevanceLanguage: c.relevanceLanguage ?? undefined, pageToken }, usage, 'search');
        for (const it of Array.isArray(d.items) ? d.items : []) { const v = it?.id?.videoId; if (typeof v === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(v)) ids.push(v); }
        pageToken = typeof d.nextPageToken === 'string' ? d.nextPageToken : undefined;
        if (!pageToken) break;
      }
    } else {
      const ch = await this.call(ctx, 'channels', { part: 'contentDetails', id: c.channelIds.join(','), maxResults: 50 }, usage, 'units');
      const uploads = (Array.isArray(ch.items) ? ch.items : []).map((i: Json) => i?.contentDetails?.relatedPlaylists?.uploads).filter((x: unknown): x is string => typeof x === 'string');
      for (const playlistId of uploads) {
        let pageToken: string | undefined;
        for (let page = 0; page < c.maxPages; page++) {
          const d = await this.call(ctx, 'playlistItems', { part: 'contentDetails', playlistId, maxResults: c.maxResults, pageToken }, usage, 'units');
          let older = false;
          for (const it of Array.isArray(d.items) ? d.items : []) {
            const v = it?.contentDetails?.videoId; const at = isoOrNull(it?.contentDetails?.videoPublishedAt);
            if (at && at.toISOString() < publishedAfter) { older = true; continue; }
            if (typeof v === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(v)) ids.push(v);
          }
          pageToken = typeof d.nextPageToken === 'string' ? d.nextPageToken : undefined;
          if (!pageToken || older) break;
        }
      }
    }
    const unique = [...new Set(ids)];
    const { records, rejected } = await this.videos(ctx, unique, usage);
    if (c.includeComments) {
      for (const r of records.slice(0, c.maxVideosForComments)) records.push(...await this.comments(ctx, r.social!.externalId, c.maxCommentThreads, usage, rejected));
    }
    return {
      status: 'ok', httpStatus: 200, records, rejected,
      cache: { etag: null, lastModified: null, validUntil: null },
      meta: { title: c.mode === 'search' ? `YouTube search: ${c.query}` : `YouTube channels (${c.channelIds.length})`, language: null, format: 'youtube-data-v3' },
      usage,
    };
  }

  private async videos(ctx: FetchContext<YoutubeConfig>, ids: string[], usage: UsageReport) {
    const records: RawRecord[] = []; const rejected: FetchResult['rejected'] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const d = await this.call(ctx, 'videos', { part: 'snippet,statistics', id: ids.slice(i, i + 50).join(','), maxResults: 50 }, usage, 'units');
      (Array.isArray(d.items) ? d.items : []).forEach((v: Json, k: number) => {
        const r = this.normalizeVideo(v);
        if (r) records.push(r); else rejected.push({ index: i + k, reason: 'invalid_video_item' });
      });
    }
    return { records, rejected };
  }

  normalizeVideo(v: Json): RawRecord | null {
    const id = typeof v?.id === 'string' ? v.id : null; const s = v?.snippet ?? {};
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id) || !title) return null;
    const description = typeof s.description === 'string' ? s.description : null;
    const live = s.liveBroadcastContent === 'live' || s.liveBroadcastContent === 'upcoming';
    return {
      url: `https://www.youtube.com/watch?v=${id}`, title, summary: description, content: null,
      author: typeof s.channelTitle === 'string' ? s.channelTitle : null,
      categories: Array.isArray(s.tags) ? s.tags.filter((t: unknown) => typeof t === 'string').slice(0, 30) : [],
      publishedAt: isoOrNull(s.publishedAt), publishedRaw: typeof s.publishedAt === 'string' ? s.publishedAt : null, guid: id,
      language: typeof s.defaultLanguage === 'string' ? s.defaultLanguage : typeof s.defaultAudioLanguage === 'string' ? s.defaultAudioLanguage : null,
      publisher: typeof s.channelTitle === 'string' ? s.channelTitle : null,
      extra: { platform: 'youtube', liveBroadcastContent: s.liveBroadcastContent ?? null },
      social: {
        platform: 'youtube', contentType: live ? 'live_stream' : 'video', externalId: id, parentExternalId: null,
        authorRef: typeof s.channelId === 'string' ? s.channelId : null,
        hashtags: extractHashtags(title, description),
        engagement: presentMetrics(v.statistics, VIDEO_METRICS),
      },
    };
  }

  private async comments(ctx: FetchContext<YoutubeConfig>, videoId: string, max: number, usage: UsageReport, rejected: FetchResult['rejected']): Promise<RawRecord[]> {
    let d: Json;
    try { d = await this.call(ctx, 'commentThreads', { part: 'snippet', videoId, maxResults: max, order: 'time', textFormat: 'plainText' }, usage, 'units'); }
    catch (e) {
      // Comments disabled on one video is not a collection failure.
      if (e instanceof ConnectorError && (e.kind === 'forbidden' || /commentsDisabled/.test(e.message))) { rejected.push({ index: -1, reason: `comments_unavailable:${videoId}` }); return []; }
      throw e;
    }
    const out: RawRecord[] = [];
    for (const th of Array.isArray(d.items) ? d.items : []) {
      const r = this.normalizeComment(th?.snippet?.topLevelComment, videoId, th?.snippet?.totalReplyCount);
      if (r) out.push(r); else rejected.push({ index: -1, reason: 'invalid_comment_item' });
    }
    return out;
  }

  normalizeComment(cm: Json, videoId: string, totalReplyCount?: unknown): RawRecord | null {
    const id = typeof cm?.id === 'string' ? cm.id : null; const s = cm?.snippet ?? {};
    const text = typeof s.textOriginal === 'string' ? s.textOriginal : typeof s.textDisplay === 'string' ? s.textDisplay : '';
    if (!id || !/^[A-Za-z0-9_.-]{6,100}$/.test(id) || !text.trim()) return null;
    const engagement = presentMetrics({ likeCount: s.likeCount, totalReplyCount }, ['likeCount', 'totalReplyCount']);
    return {
      url: `https://www.youtube.com/watch?v=${videoId}&lc=${id}`, title: oneLine(text, 200), summary: text, content: null,
      author: typeof s.authorDisplayName === 'string' ? s.authorDisplayName : null, categories: [],
      publishedAt: isoOrNull(s.publishedAt), publishedRaw: typeof s.publishedAt === 'string' ? s.publishedAt : null, guid: id, language: null, publisher: null,
      extra: { platform: 'youtube' },
      social: {
        platform: 'youtube', contentType: 'comment', externalId: id, parentExternalId: videoId,
        authorRef: typeof s.authorChannelId?.value === 'string' ? s.authorChannelId.value : null,
        hashtags: extractHashtags(text), engagement,
      },
    };
  }

  async refresh(ctx: FetchContext<YoutubeConfig>, items: Array<{ externalId: string; contentType: string }>): Promise<RefreshResult> {
    const usage = emptyUsage(); const records: RawRecord[] = []; const missing: string[] = [];
    const videos = items.filter((i) => i.contentType !== 'comment').map((i) => i.externalId);
    const comments = items.filter((i) => i.contentType === 'comment').map((i) => i.externalId);
    for (let i = 0; i < videos.length; i += 50) {
      const batch = videos.slice(i, i + 50);
      const d = await this.call(ctx, 'videos', { part: 'snippet,statistics', id: batch.join(','), maxResults: 50 }, usage, 'units');
      const found = new Set<string>();
      for (const v of Array.isArray(d.items) ? d.items : []) { const r = this.normalizeVideo(v); if (r) { records.push(r); found.add(r.social!.externalId); } }
      missing.push(...batch.filter((x) => !found.has(x)));
    }
    for (let i = 0; i < comments.length; i += 50) {
      const batch = comments.slice(i, i + 50);
      const d = await this.call(ctx, 'comments', { part: 'snippet', id: batch.join(','), textFormat: 'plainText', maxResults: 50 }, usage, 'units');
      const found = new Set<string>();
      for (const cm of Array.isArray(d.items) ? d.items : []) {
        const vid = typeof cm?.snippet?.videoId === 'string' ? cm.snippet.videoId : null;
        const r = vid ? this.normalizeComment(cm, vid) : null;
        if (r) { records.push(r); found.add(r.social!.externalId); }
      }
      missing.push(...batch.filter((x) => !found.has(x)));
    }
    return { records, missing, usage };
  }

  async testConnection(ctx: FetchContext<YoutubeConfig>) {
    const usage = emptyUsage();
    const d = await this.call(ctx, 'videos', { part: 'id', chart: 'mostPopular', regionCode: ctx.config.regionCode ?? 'ID', maxResults: 1 }, usage, 'units');
    const n = Array.isArray(d.items) ? d.items.length : 0;
    return { detail: `API key accepted by YouTube (videos.list returned ${n} item${n === 1 ? '' : 's'}; 1 quota unit used)`, usage };
  }
}
