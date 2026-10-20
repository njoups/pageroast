import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CLOCK, type Clock } from '../alerts/clock';
import { notFound } from '../common/errors';
import type { AuthContext, TenantContext } from '../common/request';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import * as E from '../analytics/engine';
import { PROVIDERS, providerForKind } from './providers';

export interface SocialAnalyticsQuery { from?: string; to?: string; days?: number; projectId?: string; platform?: string; granularity?: E.Granularity }

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
const LABELS = ['positive', 'neutral', 'negative', 'mixed', 'unknown'] as const;

/**
 * Social listening analytics over permitted, stored social records matched to the viewer's visible projects.
 * Principles (docs/SOCIAL_CONNECTORS.md, "Analytics"):
 *  - every share states its denominator; news-article and social-post sentiment are reported separately;
 *  - engagement uses only metrics the provider returned; providers whose terms restrict aggregation (YouTube) get
 *    per-record values as returned, never sums, averages or a cross-platform "engagement score";
 *  - nothing here is reach, impressions or audience size, and volume is not public opinion.
 */
@Injectable()
export class SocialAnalyticsService {
  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig, @Inject(CLOCK) private readonly clock: Clock) {}

  async overview(auth: AuthContext, t: TenantContext, q: SocialAnalyticsQuery) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const s = await E.resolveScope(c, { tenantId: t.orgId, userId: auth.userId, role: t.role }, { ...q, channel: 'social' },
        { now: this.clock.now(), maxPeriodDays: this.config.analytics.maxPeriodDays });
      const p: unknown[] = [s.from, s.to, s.projects];
      let w = `${E.T_EXPR} >= $1 AND ${E.T_EXPR} < $2 AND m.platform IS NOT NULL AND m.duplicate_status = 'original'
        AND EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = ANY($3::uuid[]))`;
      if (q.platform) { p.push(q.platform); w += ` AND m.platform = $${p.length}`; }
      const sr = `LEFT JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'article'`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typed per call site
      const rows = <T>(sql: string, extra: unknown[] = []) => c.query<T & Record<string, any>>(sql, [...p, ...extra]).then((r) => r.rows);

      const volume = await rows<{ platform: string; content_type: string; n: number }>(
        `SELECT m.platform, m.content_type, count(*)::int AS n FROM mentions m WHERE ${w} GROUP BY 1, 2 ORDER BY 3 DESC`);
      const total = volume.reduce((a, r) => a + r.n, 0);

      const bucket = `to_char(date_trunc($${p.length + 1}::text, ${E.T_EXPR} AT TIME ZONE $${p.length + 2}::text), 'YYYY-MM-DD')`;
      const trendRows = await rows<{ bucket: string; platform: string; n: number }>(`SELECT ${bucket} AS bucket, m.platform, count(*)::int AS n FROM mentions m WHERE ${w} GROUP BY 1, 2`, [s.granularity, s.tz]);
      const keys = E.bucketKeys(s.from, s.to, s.tz, s.granularity);
      const platforms = [...new Set(volume.map((v) => v.platform))];
      const trend = keys.map((k) => ({ bucket: k, ...Object.fromEntries(platforms.map((pl) => [pl, trendRows.find((r) => r.bucket === k && r.platform === pl)?.n ?? 0])) }));

      // Record-level tone per platform and content type (post vs comment), with the analysed denominator.
      const sent = await rows<{ platform: string; content_type: string; label: string | null; uncertain: boolean | null; analysed: boolean; status: string | null; n: number }>(
        `SELECT m.platform, m.content_type, sr.label, sr.uncertain, (m.analysis_id IS NOT NULL) AS analysed, a.content_status AS status, count(*)::int AS n
         FROM mentions m ${sr} LEFT JOIN LATERAL (SELECT content_status FROM mention_analyses x WHERE x.mention_id = m.id ORDER BY x.queued_at DESC LIMIT 1) a ON true
         WHERE ${w} GROUP BY 1, 2, 3, 4, 5, 6`);
      const groups = new Map<string, { platform: string; contentType: string; records: number; analysed: number; uncertain: number; notPermitted: number; shortText: number; counts: Record<string, number> }>();
      for (const r of sent) {
        const k = `${r.platform}|${r.content_type}`;
        const g = groups.get(k) ?? { platform: r.platform, contentType: r.content_type, records: 0, analysed: 0, uncertain: 0, notPermitted: 0, shortText: 0, counts: Object.fromEntries(LABELS.map((l) => [l, 0])) };
        g.records += r.n;
        if (r.status === 'not_permitted') g.notPermitted += r.n;
        if (r.analysed && r.label) {
          g.analysed += r.n; if (r.uncertain) g.uncertain += r.n; else g.counts[r.label] = (g.counts[r.label] ?? 0) + r.n;
          if (r.status === 'short_text') g.shortText += r.n;
        }
        groups.set(k, g);
      }
      const sentiment = [...groups.values()].map((g) => {
        const confident = g.analysed - g.uncertain;
        return { ...g, confident, shares: Object.fromEntries(Object.entries(g.counts).map(([l, n]) => [l, pct(n, confident)])) };
      });

      // Conversation-level: distribution of comment tones under one video/post (never collapsed into one label).
      const conv = await rows<{ parent: string; label: string | null; uncertain: boolean | null; n: number }>(
        `SELECT m.parent_external_id AS parent, sr.label, sr.uncertain, count(*)::int AS n FROM mentions m ${sr}
         WHERE ${w} AND m.content_type = 'comment' AND m.parent_external_id IS NOT NULL GROUP BY 1, 2, 3`);
      const byParent = new Map<string, { comments: number; analysed: number; uncertain: number; counts: Record<string, number> }>();
      for (const r of conv) {
        const g = byParent.get(r.parent) ?? { comments: 0, analysed: 0, uncertain: 0, counts: Object.fromEntries(LABELS.map((l) => [l, 0])) };
        g.comments += r.n; if (r.label) { g.analysed += r.n; if (r.uncertain) g.uncertain += r.n; else g.counts[r.label] = (g.counts[r.label] ?? 0) + r.n; }
        byParent.set(r.parent, g);
      }
      const parentIds = [...byParent.entries()].filter(([, g]) => g.analysed >= 3).sort((a, b) => b[1].comments - a[1].comments).slice(0, 10).map(([id]) => id);
      const parents = parentIds.length ? new Map((await c.query<{ external_id: string; title: string; url: string; platform: string }>(
        'SELECT external_id, title, url, platform FROM mentions WHERE external_id = ANY($1::text[])', [parentIds])).rows.map((r) => [r.external_id, r])) : new Map();
      const conversations = parentIds.map((id) => ({ parentExternalId: id, title: parents.get(id)?.title ?? null, url: parents.get(id)?.url ?? null, ...byParent.get(id)! }));

      const hashtags = await rows<{ tag: string; n: number }>(`SELECT h AS tag, count(*)::int AS n FROM mentions m, unnest(m.hashtags) h WHERE ${w} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 25`);
      const withTags = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM mentions m WHERE ${w} AND cardinality(m.hashtags) > 0`))[0]?.n ?? 0;

      const analysedTotal = sentiment.reduce((a, g) => a + g.analysed, 0);
      const topicRows = await rows<{ topic: string; n: number }>(`SELECT mt.topic_key AS topic, count(DISTINCT m.id)::int AS n FROM mentions m
        JOIN mention_topics mt ON mt.mention_id = m.id AND mt.analysis_id = m.analysis_id WHERE ${w} AND mt.topic_key <> 'unknown' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);

      // Engagement: per provider metric. Aggregates only where the provider's terms permit them.
      const engagement = [];
      for (const pl of platforms) {
        const d = PROVIDERS.find((x) => x.provider === pl);
        const metrics = (await rows<{ metric: string; with: number }>(`SELECT k AS metric, count(*)::int AS with FROM mentions m, jsonb_object_keys(m.engagement) k
          WHERE ${w} AND m.platform = $${p.length + 1} GROUP BY 1 ORDER BY 1`, [pl]));
        const records = volume.filter((v) => v.platform === pl).reduce((a, v) => a + v.n, 0);
        const sortMetric = metrics.find((m) => m.metric === 'viewCount')?.metric ?? metrics[0]?.metric ?? null;
        const top = sortMetric ? await rows<{ id: string; title: string; url: string; content_type: string; engagement: Record<string, number>; observed: Date }>(
          `SELECT m.id, m.title, m.url, m.content_type, m.engagement, m.engagement_observed_at AS observed FROM mentions m
           WHERE ${w} AND m.platform = $${p.length + 1} AND m.engagement ? $${p.length + 2}
           ORDER BY (m.engagement->>$${p.length + 2})::numeric DESC NULLS LAST LIMIT 10`, [pl, sortMetric]) : [];
        engagement.push({
          platform: pl, records, aggregation: d?.rights.metricAggregation ?? 'unverified',
          metrics: metrics.map((m) => ({ metric: m.metric, recordsWithMetric: m.with, recordsWithoutMetric: records - m.with })),
          sortedBy: sortMetric, top: top.map((r) => ({ ...r, observedAt: r.observed })),
          note: d?.rights.metricAggregation === 'permitted' ? null
            : `${d?.displayName ?? pl} terms restrict aggregating its metrics; values are shown per record as returned (with the time they were observed), not summed or averaged.`,
        });
      }

      const accounts = await rows<{ platform: string; accounts: number; with_ref: number; records: number }>(
        `SELECT m.platform, count(DISTINCT m.author_ref)::int AS accounts, count(*) FILTER (WHERE m.author_ref IS NOT NULL)::int AS with_ref, count(*)::int AS records
         FROM mentions m WHERE ${w} AND m.content_type <> 'comment' GROUP BY 1`);
      const connectors = (await c.query<{ id: string; name: string; kind: string; enabled: boolean; health_status: string; last_success_at: Date | null; records: number }>(
        `SELECT s.id, s.name, k.kind, s.enabled, s.health_status, s.last_success_at, (SELECT count(*)::int FROM mentions x WHERE x.source_id = s.id) AS records
         FROM sources s JOIN connectors k ON k.source_id = s.id WHERE k.kind = ANY($1::text[]) ORDER BY s.name`, [PROVIDERS.filter((x) => x.kind).map((x) => x.kind)])).rows;

      // Cross-platform entities: the same resolved entity in news articles vs social records (same projects and period).
      const ents = await c.query<{ id: string; name: string; channel: string; n: number }>(
        `SELECT e.id, e.display_name AS name, CASE WHEN m.platform IS NULL THEN 'news' ELSE 'social' END AS channel, count(DISTINCT m.id)::int AS n
         FROM mentions m JOIN mention_entities me ON me.mention_id = m.id AND me.analysis_id = m.analysis_id JOIN entities e ON e.id = me.entity_id
         WHERE ${E.T_EXPR} >= $1 AND ${E.T_EXPR} < $2 AND m.duplicate_status = 'original'
           AND EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = ANY($3::uuid[]))
         GROUP BY 1, 2, 3`, [s.from, s.to, s.projects]);
      const em = new Map<string, { entityId: string; name: string; news: number; social: number }>();
      for (const r of ents.rows) { const g = em.get(r.id) ?? { entityId: r.id, name: r.name, news: 0, social: 0 }; g[r.channel as 'news' | 'social'] += r.n; em.set(r.id, g); }
      const crossPlatformEntities = [...em.values()].filter((x) => x.social > 0).sort((a, b) => b.social + b.news - (a.social + a.news)).slice(0, 15);

      // Tone toward a monitored entity (entity-level results exist only from the AI-model path), social records only.
      const entTone = await rows<{ id: string; name: string; label: string; uncertain: boolean; n: number }>(
        `SELECT e.id, e.display_name AS name, sr.label, sr.uncertain, count(*)::int AS n FROM mentions m
         JOIN sentiment_results sr ON sr.analysis_id = m.analysis_id AND sr.target_type = 'entity' JOIN entities e ON e.id = sr.target_entity_id
         WHERE ${w} GROUP BY 1, 2, 3, 4`);
      const et = new Map<string, { entityId: string; name: string; results: number; uncertain: number; counts: Record<string, number> }>();
      for (const r of entTone) {
        const g = et.get(r.id) ?? { entityId: r.id, name: r.name, results: 0, uncertain: 0, counts: Object.fromEntries(LABELS.map((l) => [l, 0])) };
        g.results += r.n; if (r.uncertain) g.uncertain += r.n; else g.counts[r.label] = (g.counts[r.label] ?? 0) + r.n;
        et.set(r.id, g);
      }
      const entitySentiment = [...et.values()].sort((a, b) => b.results - a.results).slice(0, 15);

      const fresh = (await c.query<{ latest: Date | null; oldest_metrics: Date | null }>(
        `SELECT max(m.discovered_at) AS latest, min(m.engagement_observed_at) AS oldest_metrics FROM mentions m WHERE ${w}`, p)).rows[0]!;

      return {
        period: { from: s.from.toISOString(), to: s.to.toISOString(), timezone: s.tz, granularity: s.granularity },
        totals: { records: total, analysed: analysedTotal, withHashtags: withTags },
        volume: volume.map((v) => ({ platform: v.platform, contentType: v.content_type, records: v.n, share: pct(v.n, total) })),
        trend: { platforms, points: trend },
        sentiment, conversations, hashtags: hashtags.map((h) => ({ tag: h.tag, records: h.n, share: pct(h.n, withTags) })),
        topics: topicRows.map((r) => ({ topic: r.topic, label: E.topicLabels[r.topic] ?? r.topic, records: r.n, share: pct(r.n, analysedTotal) })),
        engagement, accounts: accounts.map((a) => ({ platform: a.platform, accounts: a.accounts, recordsWithAccountId: a.with_ref, records: a.records })),
        connectors, crossPlatformEntities, entitySentiment,
        freshness: { latestRecordDiscoveredAt: fresh.latest, oldestMetricsObservedAt: fresh.oldest_metrics },
        definitions: {
          records: 'Original social records (posts, videos, comments) matched to your visible projects, by publication time (discovery time when absent).',
          volumeShare: 'Records of the platform and content type ÷ all social records in the period.',
          sentiment: 'Record-level tone of each post or comment toward its main subject, from the configured analyser. Shares use confidently labelled records of the same platform and content type as the denominator; uncertain and unanalysed records are counted separately. News-article tone is reported in Analytics and is never mixed in here.',
          notPermitted: 'Records not analysed because the provider’s terms require an approval that is not recorded (or do not allow derived analysis).',
          conversation: 'Distribution of individual comment tones under one video/post (at least 3 analysed comments). It is not a single verdict on the conversation.',
          hashtagShare: 'Records containing the hashtag ÷ records containing any hashtag.',
          topicShare: 'Records with the topic ÷ analysed social records (a record can have several topics).',
          engagement: 'Only metrics returned by the provider, as of the time shown. Not reach, impressions or audience size. Different platforms’ metrics are never added together.',
          accounts: 'Distinct provider account/channel ids among posts (not comments); only stored when the author field is permitted.',
          crossPlatformEntities: 'Records mentioning the resolved entity, counted separately for news articles and social records.',
          entitySentiment: 'Tone expressed toward a specific entity in social records (only produced by the AI-model analyser; the rule-based baseline gives record-level tone only). Counts of entity-level results, uncertain ones separately; not combined with record-level tone.',
          caution: 'Volume and engagement show attention among collected records, not public opinion or consensus.',
        },
      };
    });
  }

  /** Cross-platform timeline for an issue: its evidence plus records in the same stories, split news vs social. */
  async issueTimeline(auth: AuthContext, t: TenantContext, issueId: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c: PoolClient) => {
      const issue = (await c.query<{ id: string; project_id: string; title: string; first_detected_at: Date; last_detected_at: Date }>(
        'SELECT id, project_id, title, first_detected_at, last_detected_at FROM detected_issues WHERE id = $1', [issueId])).rows[0];
      if (!issue) throw notFound('Issue');
      const s = await E.resolveScope(c, { tenantId: t.orgId, userId: auth.userId, role: t.role }, { projectId: issue.project_id, channel: 'all' },
        { now: this.clock.now(), maxPeriodDays: this.config.analytics.maxPeriodDays }).catch(() => { throw notFound('Issue'); });
      const from = new Date(issue.first_detected_at.getTime() - 3 * 86_400_000); const to = new Date(Math.min(issue.last_detected_at.getTime() + 3 * 86_400_000, Date.now()));
      const rows = (await c.query<{ bucket: string; channel: string; n: number }>(
        `WITH ev AS (SELECT mention_id FROM alert_evidence WHERE issue_id = $1),
              cl AS (SELECT DISTINCT cm.cluster_id FROM cluster_members cm JOIN ev ON ev.mention_id = cm.mention_id WHERE cm.removed_at IS NULL),
              recs AS (SELECT m.id, ${E.T_EXPR} AS t, m.platform FROM mentions m
                WHERE (m.id IN (SELECT mention_id FROM ev) OR m.id IN (SELECT cm.mention_id FROM cluster_members cm JOIN cl ON cl.cluster_id = cm.cluster_id WHERE cm.removed_at IS NULL))
                  AND EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = ANY($2::uuid[])))
         SELECT to_char(date_trunc('day', t AT TIME ZONE $5), 'YYYY-MM-DD') AS bucket, CASE WHEN platform IS NULL THEN 'news' ELSE platform END AS channel, count(*)::int AS n
         FROM recs WHERE t >= $3 AND t < $4 GROUP BY 1, 2 ORDER BY 1`, [issueId, s.projects, from, to, s.tz])).rows;
      const channels = [...new Set(rows.map((r) => r.channel))];
      const keys = E.bucketKeys(from, to, s.tz, 'day');
      return {
        issue: { id: issue.id, title: issue.title }, period: { from: from.toISOString(), to: to.toISOString(), timezone: s.tz },
        channels, points: keys.map((k) => ({ bucket: k, ...Object.fromEntries(channels.map((ch) => [ch, rows.find((r) => r.bucket === k && r.channel === ch)?.n ?? 0])) })),
        definition: 'Per day: the issue’s evidence records plus records in the same story clusters, counted separately for news ("news") and each social platform. Social records join a story only through clustering; detection itself uses the channels its rule selects.',
        providers: channels.filter((ch) => ch !== 'news').map((ch) => ({ platform: ch, name: providerForKind(ch)?.displayName ?? ch })),
      };
    });
  }
}
