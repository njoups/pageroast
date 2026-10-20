/**
 * Social and licensed-data provider descriptors: the single source of truth for what each provider can do here, what
 * its terms require, and how far that has been verified. The API, the UI and docs/SOCIAL_CONNECTORS.md render these.
 *
 * Rules:
 *  - `implementation: 'implemented'` only when a connector exists in ingestion/connectors and passes contract tests.
 *  - `liveVerified` stays false until a run against the real provider with real credentials succeeded.
 *  - Every quota, price or policy statement carries the URL it was read from and the date it was read. Anything not
 *    read from official documentation is `null` / 'unverified', never guessed.
 */

export type Operation =
  | 'keyword_search' | 'hashtag_search' | 'channel_monitoring' | 'account_monitoring' | 'comments'
  | 'date_range' | 'engagement_metrics' | 'refresh' | 'connection_test';

export const OPERATION_LABELS: Record<Operation, string> = {
  keyword_search: 'Keyword search', hashtag_search: 'Hashtag search', channel_monitoring: 'Channel monitoring',
  account_monitoring: 'Account monitoring', comments: 'Public comments', date_range: 'Date range filter',
  engagement_metrics: 'Engagement metrics', refresh: 'Refresh and deletion checks', connection_test: 'Connection test',
};

export interface QuotaBucket { key: string; label: string; perDay: number | null; costNote: string }

export interface ProviderRights {
  /** Max days a record (text, statistics) may be stored without a refresh; null = provider sets no limit known to us. */
  storageMaxDays: number | null;
  /** Records must be refreshed (or deleted) within this many days of retrieval. */
  refreshWithinDays: number | null;
  /** Days to complete deletion after a deletion request or revocation. */
  deletionOnRequestDays: number | null;
  /** Whether derived analysis (sentiment, topics, entities, summaries) is allowed, needs a recorded approval, or is not allowed. */
  derivedAnalysis: 'permitted' | 'requires_approval' | 'not_permitted' | 'unverified';
  derivedAnalysisNote: string;
  /** Whether provider metrics may be summed across accounts or content. */
  metricAggregation: 'permitted' | 'restricted' | 'unverified';
  redistribution: string;
  attribution: string;
  commercialUse: string;
}

export interface ProviderDescriptor {
  provider: string;
  displayName: string;
  /** Connector kind in ingestion/connectors when implemented. */
  kind: string | null;
  implementation: 'implemented' | 'not_implemented';
  access: 'available' | 'requires_credentials' | 'requires_contract' | 'research_only' | 'unverified';
  liveVerified: boolean;
  relevance: string;
  auth: { method: 'api_key' | 'oauth2' | 'bearer_token' | 'contract' | 'unknown'; credentialLabel: string | null; setup: string[]; scopes: string[] };
  operations: Operation[];
  /** Operations users may expect but this provider/connector does not offer, with the reason shown in the UI. */
  unsupported: Partial<Record<Operation, string>>;
  contentTypes: string[];
  fields: string[];
  metrics: string[];
  historicalCoverage: string;
  limits: { maxResultsPerRequest: number | null; maxPagesPerSync: number | null; minRefreshIntervalSeconds: number };
  quota: { buckets: QuotaBucket[]; resetTimeZone: string | null; resetNote: string };
  pricing: { model: string; note: string };
  rights: ProviderRights;
  limitations: string[];
  docs: Array<{ title: string; url: string }>;
  verifiedAt: string | null;   // date the documentation above was read (YYYY-MM-DD)
}

const YT_DOCS = [
  { title: 'Quota costs (last updated 2026-10-15)', url: 'https://developers.google.com/youtube/v3/determine_quota_cost' },
  { title: 'search.list (last updated 2026-10-15)', url: 'https://developers.google.com/youtube/v3/docs/search/list' },
  { title: 'Developer Policies (last updated 2026-10-15)', url: 'https://developers.google.com/youtube/terms/developer-policies' },
  { title: 'Derived metrics and data storage policy (last updated 2026-09-14)', url: 'https://developers.google.com/youtube/terms/derived-metrics-policy' },
  { title: 'Google API system parameters: X-Goog-Api-Key (last updated 2026-10-14)', url: 'https://docs.cloud.google.com/apis/docs/system-parameters' },
];

export const PROVIDERS: ProviderDescriptor[] = [
  {
    provider: 'youtube', displayName: 'YouTube Data API v3', kind: 'youtube', implementation: 'implemented', access: 'requires_credentials',
    liveVerified: false,
    relevance: 'Widely used in Indonesia; ministries, regional governments and news outlets publish on YouTube. Public videos and comments are reachable with an API key.',
    auth: {
      method: 'api_key', credentialLabel: 'YouTube Data API key',
      setup: [
        'Create or choose a Google Cloud project owned by the customer or the operator.',
        'Enable "YouTube Data API v3" for the project (APIs & Services → Library).',
        'Create an API key (APIs & Services → Credentials) and restrict it to the YouTube Data API v3; add an IP restriction for the worker egress address.',
        'Paste the key into the connector here. It is encrypted with CREDENTIALS_KEY and never shown again.',
        'Optional, for sentiment/topic analysis: accept the derived-metrics amendment (Section 5, "Analytics & Reporting") and record the approval reference on the connector.',
      ],
      scopes: [],
    },
    operations: ['keyword_search', 'channel_monitoring', 'comments', 'date_range', 'engagement_metrics', 'refresh', 'connection_test'],
    unsupported: {
      hashtag_search: 'No dedicated hashtag endpoint. A keyword search for "#tag" is sent as an ordinary query; hashtags are read from titles and descriptions.',
      account_monitoring: 'YouTube has channels, not accounts: use channel monitoring.',
    },
    contentTypes: ['video', 'comment'],
    fields: ['video id', 'title', 'description (excerpt)', 'channel id and title', 'published time', 'tags/hashtags in text', 'default language', 'comment text and author channel (comments only)'],
    metrics: ['viewCount', 'likeCount', 'commentCount', 'favoriteCount (comments: likeCount)'],
    historicalCoverage: 'search.list accepts publishedAfter/publishedBefore; results are capped (about 500 per channel search) and non-relevance ordering may be incomplete per the documentation.',
    limits: { maxResultsPerRequest: 50, maxPagesPerSync: 4, minRefreshIntervalSeconds: 3600 },
    quota: {
      buckets: [
        { key: 'search', label: 'Search queries', perDay: 100, costNote: 'search.list: 1 call per page, from a separate default bucket of 100 calls/day' },
        { key: 'units', label: 'Quota units (other methods)', perDay: 10_000, costNote: 'videos.list, channels.list, playlistItems.list, commentThreads.list: 1 unit per call' },
      ],
      resetTimeZone: 'America/Los_Angeles', resetNote: 'Daily quotas reset at midnight Pacific Time. Quota is per Google Cloud project (API key), shared by every connector that uses the same key.',
    },
    pricing: { model: 'quota', note: 'Access is governed by daily quota; quota extensions require an API Compliance Audit. No per-request price was found in the documentation read; add a pricing row if your agreement has one.' },
    rights: {
      storageMaxDays: 30, refreshWithinDays: 30, deletionOnRequestDays: 7,
      derivedAnalysis: 'requires_approval',
      derivedAnalysisNote: 'III.E.4.h prohibits creating derived data or metrics from API Data. The derived-metrics amendment permits viewer sentiment analysis and content tagging for accepted analytics use cases; derived metrics must be labelled and kept distinct from YouTube data.',
      metricAggregation: 'restricted',
      redistribution: 'Must not sell, redistribute or sublicense API Data (III.G.1.a). Exports carry links, not copies of video data.',
      attribution: 'Link every item to its YouTube page; identify YouTube as the source; show the most recent API data available.',
      commercialUse: 'Allowed under the YouTube API Services Terms and Developer Policies; advertising restrictions apply to pages showing API Data (III.G.1).',
    },
    limitations: [
      'Public data fetched with an API key is "Non-Authorized Data": store only limited amounts and never longer than 30 days; statistics also at most 30 days.',
      'Text (titles, descriptions, comments) must be refreshed or deleted within 30 days even with the derived-metrics permission.',
      'No reach or impressions: view counts are cumulative counts reported by YouTube, not audience reach.',
      'Header authentication (X-Goog-Api-Key) is documented for Google APIs generally; it has not yet been confirmed against YouTube with a live key.',
    ],
    docs: YT_DOCS, verifiedAt: '2026-10-20',
  },
  {
    provider: 'x', displayName: 'X API v2', kind: null, implementation: 'not_implemented', access: 'requires_credentials', liveVerified: false,
    relevance: 'Used by Indonesian officials and agencies for announcements; fast-moving public conversation.',
    auth: { method: 'bearer_token', credentialLabel: 'App bearer token', setup: ['Requires a developer account, a Project and an App with purchased usage credits.'], scopes: [] },
    operations: [], unsupported: {
      keyword_search: 'Connector not built yet. Recent search (last 7 days) and full-archive search exist at the provider.',
      account_monitoring: 'Connector not built yet.',
    },
    contentTypes: ['post'], fields: [], metrics: [],
    historicalCoverage: 'Recent search: last 7 days. Full-archive search: back to March 2006 (pay-per-use and Enterprise).',
    limits: { maxResultsPerRequest: 100, maxPagesPerSync: null, minRefreshIntervalSeconds: 3600 },
    quota: { buckets: [], resetTimeZone: null, resetNote: 'Pay-per-use plans are capped at 3 million post reads per monthly billing cycle.' },
    pricing: { model: 'pay_per_use', note: 'Pricing page read 2026-10-20: $0.005 per Post read; Counts: Recent $0.005 per request. Enter as provider_pricing rows when the connector is built.' },
    rights: {
      storageMaxDays: null, refreshWithinDays: null, deletionOnRequestDays: null, derivedAnalysis: 'unverified',
      derivedAnalysisNote: 'Developer Agreement and Policy not reviewed in this milestone.', metricAggregation: 'unverified',
      redistribution: 'Unverified', attribution: 'Unverified', commercialUse: 'Unverified (paid access; terms not reviewed)',
    },
    limitations: ['Developer Agreement, deletion-compliance obligations and display requirements not yet reviewed.'],
    docs: [
      { title: 'Pricing (read 2026-10-20, no date on page)', url: 'https://docs.x.com/x-api/getting-started/pricing' },
      { title: 'Search introduction (read 2026-10-20)', url: 'https://docs.x.com/x-api/posts/search/introduction' },
    ],
    verifiedAt: '2026-10-20',
  },
  {
    provider: 'reddit', displayName: 'Reddit Data API', kind: null, implementation: 'not_implemented', access: 'unverified', liveVerified: false,
    relevance: 'Limited Indonesian public-sector relevance compared with YouTube, X and Meta platforms.',
    auth: { method: 'oauth2', credentialLabel: null, setup: [], scopes: [] },
    operations: [], unsupported: { keyword_search: 'Not evaluated: Reddit documentation could not be read from this environment (HTTP 403).' },
    contentTypes: [], fields: [], metrics: [], historicalCoverage: 'Unverified',
    limits: { maxResultsPerRequest: null, maxPagesPerSync: null, minRefreshIntervalSeconds: 3600 },
    quota: { buckets: [], resetTimeZone: null, resetNote: 'Unverified' },
    pricing: { model: 'unverified', note: 'Unverified' },
    rights: { storageMaxDays: null, refreshWithinDays: null, deletionOnRequestDays: null, derivedAnalysis: 'unverified', derivedAnalysisNote: 'Unverified',
      metricAggregation: 'unverified', redistribution: 'Unverified', attribution: 'Unverified', commercialUse: 'Unverified' },
    limitations: ['Terms and commercial-use conditions not verified.'],
    docs: [{ title: 'Data API Wiki (HTTP 403 from this environment on 2026-10-20)', url: 'https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki' }],
    verifiedAt: null,
  },
  {
    provider: 'meta_content_library', displayName: 'Meta Content Library and API', kind: null, implementation: 'not_implemented', access: 'research_only', liveVerified: false,
    relevance: 'Facebook and Instagram are heavily used in Indonesia, but this access route is a controlled research environment.',
    auth: { method: 'contract', credentialLabel: null, setup: ['Application approved via ICPSR or CASD and acceptance of the Meta Research Tools Terms.'], scopes: [] },
    operations: [], unsupported: { keyword_search: 'Not usable for commercial monitoring: access is for approved research in a secure environment; raw data cannot be exported through the API.' },
    contentTypes: ['post', 'comment'], fields: [], metrics: [], historicalCoverage: 'Not applicable',
    limits: { maxResultsPerRequest: null, maxPagesPerSync: null, minRefreshIntervalSeconds: 3600 },
    quota: { buckets: [], resetTimeZone: null, resetNote: 'Not applicable' },
    pricing: { model: 'not_applicable', note: 'Not applicable' },
    rights: { storageMaxDays: null, refreshWithinDays: null, deletionOnRequestDays: null, derivedAnalysis: 'not_permitted',
      derivedAnalysisNote: 'Analysis happens inside Meta’s Secure Research Environment only.', metricAggregation: 'unverified',
      redistribution: 'Only research outputs, under agreed terms', attribution: 'Unverified', commercialUse: 'Research access; not a commercial monitoring channel' },
    limitations: ['No Meta API for commercial keyword monitoring of public posts was identified in the documentation read. Pages a customer administers could be connected via the Graph API with the Page owner’s authorization (not built).'],
    docs: [{ title: 'Content Library and API (read 2026-10-20)', url: 'https://developers.facebook.com/docs/content-library-and-api' }],
    verifiedAt: '2026-10-20',
  },
  {
    provider: 'licensed_provider', displayName: 'Licensed social listening provider', kind: null, implementation: 'not_implemented', access: 'requires_contract', liveVerified: false,
    relevance: 'Commercial aggregators can cover platforms whose own APIs are closed to monitoring (Facebook, Instagram, TikTok).',
    auth: { method: 'contract', credentialLabel: null, setup: ['Sign a data licence that covers government monitoring, storage, derived analysis and reporting; then a connector can be built against the provider’s API.'], scopes: [] },
    operations: [], unsupported: { keyword_search: 'No provider contracted; no connector built.' },
    contentTypes: [], fields: [], metrics: [], historicalCoverage: 'Per contract',
    limits: { maxResultsPerRequest: null, maxPagesPerSync: null, minRefreshIntervalSeconds: 3600 },
    quota: { buckets: [], resetTimeZone: null, resetNote: 'Per contract' },
    pricing: { model: 'contract', note: 'Per contract' },
    rights: { storageMaxDays: null, refreshWithinDays: null, deletionOnRequestDays: null, derivedAnalysis: 'unverified', derivedAnalysisNote: 'Per contract',
      metricAggregation: 'unverified', redistribution: 'Per contract', attribution: 'Per contract', commercialUse: 'Per contract' },
    limitations: ['Requires procurement and legal review.'], docs: [], verifiedAt: null,
  },
];

export const getProvider = (provider: string) => PROVIDERS.find((p) => p.provider === provider);
export const providerForKind = (kind: string) => PROVIDERS.find((p) => p.kind === kind);
export const SOCIAL_KINDS = PROVIDERS.filter((p) => p.kind).map((p) => p.kind!) as string[];
export const isSocialKind = (kind: string) => SOCIAL_KINDS.includes(kind);
