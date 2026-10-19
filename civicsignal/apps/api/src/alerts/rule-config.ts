import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { parseQuery, QuerySyntaxError } from '../ingestion/query';
import { SEVERITIES } from './levels';

export const RULE_TYPES = ['volume_spike', 'negative_shift', 'emerging_topic', 'keyword', 'story_velocity', 'source_concentration'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const topicKey = z.string().regex(/^(custom:)?[a-z0-9_]{2,40}$/);

/**
 * Rule configuration. Stored as an immutable version per edit; validated here on every write. Nothing in it is
 * executed: the keyword expression is parsed by the same bounded parser as monitoring queries.
 */
export const RuleConfigSchema = z.object({
  filters: z.object({
    entityIds: z.array(uuid).max(20).default([]),
    sourceIds: z.array(uuid).max(50).default([]),
    topics: z.array(topicKey).max(20).default([]),
    keywords: z.string().trim().max(500).nullable().default(null),   // query-language expression
  }).strict().prefault({}),
  window: z.object({
    minutes: z.number().int().min(15).max(10_080).default(60),
    comparison: z.enum(['previous_windows', 'same_time_previous_days']).default('same_time_previous_days'),
    baselineWindows: z.number().int().min(3).max(60).default(14),
  }).strict().prefault({}),
  thresholds: z.object({
    minMentions: z.number().int().min(1).max(100_000).default(5),
    relativeChange: z.number().min(1).max(1000).default(2),          // observed / baseline median
    robustZ: z.number().min(0).max(50).default(3),
    minBaselineWindows: z.number().int().min(3).max(60).default(5),  // covered windows needed before any volume alert
    minPublishers: z.number().int().min(1).max(1000).default(1),
    negativeShift: z.number().min(0.01).max(1).default(0.15),         // percentage-point increase in negative share
    minClassified: z.number().int().min(5).max(100_000).default(20),  // confident classifications needed in each window
    maxUncertainShare: z.number().min(0).max(1).default(0.5),
    zThreshold: z.number().min(0).max(10).default(1.96),
    uncommonMaxPerWindow: z.number().min(0).max(1000).default(1),     // emerging topic: baseline median at most this
    minIndependentPublishers: z.number().int().min(2).max(1000).default(3),
    concentrationShare: z.number().min(0.3).max(1).default(0.6),
  }).strict().prefault({}),
  severity: z.object({
    minimum: z.enum(SEVERITIES).default('low'),                    // computed severity below this → no alert
    floor: z.enum(SEVERITIES).nullable().default(null),            // e.g. critical keywords: never below this
  }).strict().prefault({}),
  notify: z.object({
    channels: z.array(z.enum(['in_app', 'email', 'whatsapp'])).max(3).default(['in_app']),
    recipientUserIds: z.array(uuid).max(50).default([]),
    webhookEndpointIds: z.array(uuid).max(10).default([]),
  }).strict().prefault({}),
  cooldownMinutes: z.number().int().min(0).max(10_080).default(120),
  quietHours: z.object({
    start: hhmm, end: hhmm, timezone: z.string().min(1).max(64), allowCritical: z.boolean().default(true),
  }).strict().nullable().default(null),
  escalation: z.object({
    steps: z.array(z.object({ afterMinutes: z.number().int().min(5).max(10_080), notifyUserIds: z.array(uuid).min(1).max(20) }).strict()).max(3),
  }).strict().nullable().default(null),
}).strict();
export type RuleConfig = z.infer<typeof RuleConfigSchema>;

export class RuleConfigError extends Error {
  constructor(readonly problems: Array<{ field: string; problems: string[] }>) { super('Invalid alert rule configuration'); }
}

/** Parses, applies defaults and checks rule-type-specific constraints. Throws RuleConfigError with field paths. */
export function validateRuleConfig(type: RuleType, input: unknown): RuleConfig {
  const r = RuleConfigSchema.safeParse(input ?? {});
  if (!r.success) {
    throw new RuleConfigError(r.error.issues.map((i) => ({ field: i.path.join('.') || 'config', problems: [i.message] })));
  }
  const c = r.data;
  const problems: Array<{ field: string; problems: string[] }> = [];
  const add = (field: string, msg: string) => problems.push({ field, problems: [msg] });
  if (c.filters.keywords) {
    try { parseQuery(c.filters.keywords); } catch (e) {
      add('filters.keywords', e instanceof QuerySyntaxError ? e.message : 'Invalid expression');
    }
  }
  if (type === 'keyword' && !c.filters.keywords) add('filters.keywords', 'A keyword rule needs a keyword expression');
  if (type === 'emerging_topic' && c.filters.topics.length === 0) {
    // Without topic filters every topic is considered; allowed, but the window must be at least a day for stable baselines.
    if (c.window.minutes < 1440) add('window.minutes', 'Emerging-topic rules over all topics need a window of at least 1440 minutes');
  }
  if (c.window.comparison === 'same_time_previous_days' && c.window.minutes > 1440) {
    add('window.comparison', 'Same-time-of-day comparison needs a window of at most 1440 minutes');
  }
  if (c.thresholds.minBaselineWindows > c.window.baselineWindows) add('thresholds.minBaselineWindows', 'Cannot exceed window.baselineWindows');
  if (c.window.minutes * (c.window.baselineWindows + 1) > 90 * 1440) add('window.baselineWindows', 'Look-back may not exceed 90 days');
  if (c.notify.channels.includes('email') || c.notify.channels.includes('whatsapp')) {
    if (c.notify.recipientUserIds.length === 0) add('notify.recipientUserIds', 'Email and WhatsApp need at least one recipient');
  }
  if (c.quietHours) {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: c.quietHours.timezone }); } catch { add('quietHours.timezone', 'Unknown time zone'); }
  }
  if (c.escalation) {
    const mins = c.escalation.steps.map((s) => s.afterMinutes);
    if (mins.some((m, i) => i > 0 && m <= mins[i - 1]!)) add('escalation.steps', 'Escalation steps must have increasing afterMinutes');
  }
  if (problems.length) throw new RuleConfigError(problems);
  return c;
}

export const configSha = (c: RuleConfig) => createHash('sha256').update(JSON.stringify(c)).digest('hex');

/** IDs referenced by a config, so the service can check they exist in the tenant (and the user may see them). */
export function referencedIds(c: RuleConfig) {
  return {
    entityIds: c.filters.entityIds, sourceIds: c.filters.sourceIds, webhookEndpointIds: c.notify.webhookEndpointIds,
    userIds: [...new Set([...c.notify.recipientUserIds, ...(c.escalation?.steps.flatMap((s) => s.notifyUserIds) ?? [])])],
  };
}
