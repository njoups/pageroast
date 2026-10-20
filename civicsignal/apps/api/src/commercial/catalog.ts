import { z } from 'zod';

/**
 * Commercial vocabulary: the metrics a plan can limit and the features it can include. Limits and prices are data
 * (plan_versions, quota_overrides); this file only names what can be limited and how each metric is measured.
 */

/** counter: consumed per usage period (ledger). gauge: number of resources that exist right now. */
export type MetricKind = 'counter' | 'gauge';

export interface MetricDef { key: string; label: string; unit: string; kind: MetricKind; description: string }

export const METRICS = {
  seats: { label: 'Seats', unit: 'members', kind: 'gauge', description: 'Members plus open invitations' },
  projects: { label: 'Projects', unit: 'projects', kind: 'gauge', description: 'Projects that are not archived' },
  monitoring_queries: { label: 'Monitoring queries', unit: 'queries', kind: 'gauge', description: 'Active monitoring queries' },
  active_connectors: { label: 'Active sources and connectors', unit: 'sources', kind: 'gauge', description: 'Enabled sources (news feeds and social connectors)' },
  report_schedules: { label: 'Report schedules', unit: 'schedules', kind: 'gauge', description: 'Active report schedules' },
  alert_rules: { label: 'Alert rules', unit: 'rules', kind: 'gauge', description: 'Active alert rules' },
  notification_channels: { label: 'Webhook channels', unit: 'endpoints', kind: 'gauge', description: 'Configured webhook endpoints' },
  storage_mb: { label: 'Stored data', unit: 'MB', kind: 'gauge', description: 'Approximate size of stored mentions and report files (soft limit only)' },
  mentions_ingested: { label: 'Mentions collected', unit: 'mentions', kind: 'counter', description: 'New records stored by collection in the usage period' },
  ai_analyses: { label: 'AI analyses', unit: 'analyses', kind: 'counter', description: 'Completed mention analyses in the usage period' },
  ai_tokens: { label: 'AI tokens', unit: 'tokens', kind: 'counter', description: 'Provider-reported input + output tokens in the usage period' },
  reports_generated: { label: 'Reports generated', unit: 'reports', kind: 'counter', description: 'Report runs started (manual and scheduled) in the usage period' },
  exports: { label: 'Exports and downloads', unit: 'downloads', kind: 'counter', description: 'Report file downloads in the usage period' },
  social_api_units: { label: 'Social API units', unit: 'units', kind: 'counter', description: 'Provider quota units used by social connectors in the usage period' },
  api_requests: { label: 'API requests', unit: 'requests', kind: 'counter', description: 'Public API requests (no public API exists yet)' },
} satisfies Record<string, Omit<MetricDef, 'key'>>;
export type Metric = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as Metric[];
export const isMetric = (s: string): s is Metric => s in METRICS;

export const FEATURES = {
  ai_analysis: 'LLM analysis of mentions (without it the rule-based baseline is used)',
  social_listening: 'Authorized social connectors (e.g. YouTube)',
  scheduled_reports: 'Scheduled report delivery',
  executive_analytics: 'Executive report templates (monthly performance, policy monitoring)',
  webhooks: 'Webhook notification channels',
  whatsapp: 'WhatsApp notification channel',
  white_label_reports: 'Custom brand colour on reports',
  api_access: 'Public API access (not available: no public API exists yet)',
} as const;
export type Feature = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

export const QuotaSpec = z.object({
  limit: z.number().nonnegative().nullable(),          // null = unlimited
  enforcement: z.enum(['hard', 'soft', 'none']).default('hard'),
  overage: z.enum(['block', 'allow_and_flag', 'bill']).optional(),
}).strict();
export type QuotaSpec = z.infer<typeof QuotaSpec>;

export const PlanSettings = z.object({
  max_retention_days: z.number().int().positive().optional(),
  audit_retention_days: z.number().int().positive().optional(),
  support_level: z.string().min(2).max(40).optional(),
  notice_thresholds: z.array(z.number().int().min(1).max(1000)).max(10).optional(),
  past_due_grace_days: z.number().int().min(0).max(120).optional(),
}).strict();
export type PlanSettings = z.infer<typeof PlanSettings>;

export const PlanVersionInput = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  priceAmount: z.number().nonnegative().max(1e12).nullable().optional(),
  billingInterval: z.enum(['month', 'year', 'custom']),
  trialDays: z.number().int().min(0).max(365).default(0),
  features: z.record(z.string(), z.boolean()).refine((f) => Object.keys(f).every((k) => k in FEATURES), 'Unknown feature'),
  quotas: z.record(z.string(), QuotaSpec).refine((q) => Object.keys(q).every(isMetric), 'Unknown metric'),
  settings: PlanSettings.default({}),
  effectiveFrom: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
}).strict().refine((v) => v.priceAmount == null || !!v.currency, { message: 'A price needs a currency', path: ['currency'] });
export type PlanVersionInput = z.infer<typeof PlanVersionInput>;

export const DEFAULT_THRESHOLDS = [70, 85, 95, 100];

/** Report templates that need the executive_analytics feature. */
export const EXECUTIVE_TEMPLATES: ReadonlySet<string> = new Set(['monthly_performance', 'policy_monitoring']);

/**
 * Work that a commercial limit must never stop: security, audit, retention, deletion, legal hold, provider
 * refresh-or-delete obligations, exports of a customer's own data for governance requests. These paths do not call the
 * quota service at all; the list documents the rule and is asserted in tests.
 */
export const NEVER_BLOCKED = ['audit', 'retention', 'deletion_requests', 'legal_hold', 'social_lifecycle', 'session_security', 'password_reset'] as const;
