import type { PoolClient } from 'pg';
import { AppError } from '../common/errors';
import { DEFAULT_THRESHOLDS, FEATURE_KEYS, METRICS, METRIC_KEYS, type Feature, type Metric, type PlanSettings, type QuotaSpec } from './catalog';
import { accessFor, type Access, type SubStatus } from './lifecycle';
import { usageDay, usagePeriod, type UsagePeriod } from './periods';

/**
 * Server-side entitlement and quota service. Every check runs inside the caller's tenant transaction, so RLS scopes
 * every read to that tenant. Counter consumption is atomic (idempotent ledger insert + row-locked period total);
 * gauge checks take a per-tenant, per-metric transaction advisory lock so concurrent creations cannot overshoot.
 */

export interface EffectiveQuota { limit: number | null; enforcement: 'hard' | 'soft' | 'none'; overage: string; source: 'plan' | 'override' | 'not_in_plan' }
export interface Entitlements {
  tenantId: string;
  subscription: null | {
    id: string; status: SubStatus; planCode: string; planName: string; planVersionId: string; version: number; billingMode: string;
    trialEndsAt: Date | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; usageAnchor: Date;
  };
  access: Access;
  features: Record<Feature, boolean>;
  quotas: Record<Metric, EffectiveQuota>;
  settings: PlanSettings;
  timezone: string;
  /** Time zone of the usage periods (frozen with the anchor). */
  periodTimezone: string;
  period: UsagePeriod;
}

export const commercialError = (code: 'quota_exceeded' | 'feature_not_in_plan' | 'subscription_inactive', message: string, details?: unknown) =>
  new AppError(402, code, message, details);

export async function loadEntitlements(c: PoolClient, tenantId: string, now = new Date()): Promise<Entitlements> {
  const s = (await c.query(`SELECT s.id, s.status, s.billing_mode, s.trial_ends_at, s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.usage_anchor, s.usage_timezone,
      pv.id AS pv_id, pv.version, pv.features, pv.quotas, pv.settings, p.code, p.name, t.settings->>'timezone' AS tz
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.ended_at IS NULL
      LEFT JOIN plan_versions pv ON pv.id = s.plan_version_id LEFT JOIN plans p ON p.id = pv.plan_id
    WHERE t.id = $1`, [tenantId])).rows[0];
  const timezone = s?.tz || 'Asia/Jakarta';
  // Usage periods use the time zone frozen when the anchor was set, so changing the organization's time zone cannot
  // move the current period (which would start a fresh, empty period and reset every counter).
  const periodTz: string = s?.usage_timezone || timezone;
  const overrides = (await c.query<{ metric: string; quota_limit: string | null; enforcement: 'hard' | 'soft' }>(
    `SELECT metric, quota_limit, enforcement FROM quota_overrides WHERE tenant_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`, [tenantId, now])).rows;
  const planQuotas = (s?.quotas ?? {}) as Record<string, QuotaSpec>;
  // A plan that lists no quotas at all (e.g. the legacy pilot plan) is unlimited; otherwise an unlisted metric is unlimited too,
  // except api_requests, which has no implementation and is never granted implicitly.
  const quotas = Object.fromEntries(METRIC_KEYS.map((m): [Metric, EffectiveQuota] => {
    const o = overrides.find((x) => x.metric === m);
    if (o) return [m, { limit: o.quota_limit === null ? null : Number(o.quota_limit), enforcement: o.enforcement, overage: o.enforcement === 'hard' ? 'block' : 'allow_and_flag', source: 'override' }];
    const q = planQuotas[m];
    if (q) return [m, { limit: q.limit, enforcement: q.enforcement, overage: q.overage ?? (q.enforcement === 'hard' ? 'block' : 'allow_and_flag'), source: 'plan' }];
    return [m, { limit: null, enforcement: 'none', overage: 'allow', source: 'not_in_plan' }];
  })) as Record<Metric, EffectiveQuota>;
  const f = (s?.features ?? {}) as Record<string, boolean>;
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, k === 'api_access' ? false : f[k] === true])) as Record<Feature, boolean>;
  const status = (s?.status ?? null) as SubStatus | null;
  // Without a subscription, usage still falls into stable calendar months (not a new period per request).
  const anchor: Date = s?.usage_anchor ?? new Date(Date.UTC(2000, 0, 1, 0, 0));
  return {
    tenantId,
    subscription: s?.id ? { id: s.id, status: s.status, planCode: s.code, planName: s.name, planVersionId: s.pv_id, version: s.version, billingMode: s.billing_mode,
      trialEndsAt: s.trial_ends_at, currentPeriodStart: s.current_period_start, currentPeriodEnd: s.current_period_end, cancelAtPeriodEnd: s.cancel_at_period_end, usageAnchor: anchor } : null,
    access: accessFor(status), features, quotas, settings: (s?.settings ?? {}) as PlanSettings, timezone, periodTimezone: periodTz, period: usagePeriod(anchor, now, periodTz),
  };
}

// ── Gauges ─────────────────────────────────────────────────────────────────────────────────────────
const GAUGE_SQL: Partial<Record<Metric, string>> = {
  seats: `SELECT (SELECT count(*) FROM memberships) + (SELECT count(*) FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS n`,
  projects: `SELECT count(*) AS n FROM projects WHERE archived_at IS NULL`,
  monitoring_queries: `SELECT count(*) AS n FROM monitoring_queries WHERE is_active`,
  active_connectors: `SELECT count(*) AS n FROM sources WHERE enabled`,
  report_schedules: `SELECT count(*) AS n FROM report_schedules WHERE is_active AND cancelled_at IS NULL`,
  alert_rules: `SELECT count(*) AS n FROM alert_rules WHERE is_active AND deleted_at IS NULL`,
  notification_channels: `SELECT count(*) AS n FROM webhook_endpoints`,
  // Approximate: text columns of stored mentions plus stored report files. Soft only; never blocks anything.
  storage_mb: `SELECT ((SELECT coalesce(sum(octet_length(coalesce(title,'')) + octet_length(coalesce(excerpt,'')) + octet_length(coalesce(body,''))), 0) FROM mentions)
                + (SELECT coalesce(sum(size_bytes), 0) FROM report_artifacts WHERE data IS NOT NULL)) / 1048576.0 AS n`,
};

export async function gaugeUsage(c: PoolClient, metric: Metric): Promise<number> {
  const sql = GAUGE_SQL[metric];
  if (!sql) throw new Error(`${metric} is not a gauge`);
  return Number((await c.query<{ n: string }>(sql)).rows[0]!.n);
}

export async function counterUsage(c: PoolClient, tenantId: string, metric: Metric, period: UsagePeriod): Promise<number> {
  const r = (await c.query<{ quantity: string }>('SELECT quantity FROM usage_period_totals WHERE tenant_id = $1 AND metric = $2 AND period_start = $3', [tenantId, metric, period.start])).rows[0];
  return Number(r?.quantity ?? 0);
}

export interface QuotaDecision {
  metric: Metric; allowed: boolean; used: number; requested: number; limit: number | null; remaining: number | null;
  enforcement: EffectiveQuota['enforcement']; source: EffectiveQuota['source']; overage: boolean;
  behaviour: 'unlimited' | 'within_limit' | 'soft_overage' | 'blocked' | 'inactive';
  planCode: string | null; reason?: string;
}

export function decide(ent: Entitlements, metric: Metric, used: number, requested: number): QuotaDecision {
  const q = ent.quotas[metric];
  const base = { metric, used, requested, limit: q.limit, enforcement: q.enforcement, source: q.source, planCode: ent.subscription?.planCode ?? null };
  if (q.limit === null || q.enforcement === 'none') return { ...base, allowed: true, remaining: null, overage: false, behaviour: 'unlimited' };
  const remaining = Math.max(0, q.limit - used);
  const over = used + requested > q.limit;
  if (!over) return { ...base, allowed: true, remaining, overage: false, behaviour: 'within_limit' };
  if (q.enforcement === 'soft') return { ...base, allowed: true, remaining, overage: true, behaviour: 'soft_overage' };
  return { ...base, allowed: false, remaining, overage: true, behaviour: 'blocked',
    reason: `${METRICS[metric].label}: ${used} of ${q.limit} ${METRICS[metric].unit} used${METRICS[metric].kind === 'counter' ? ' in this usage period' : ''}` };
}

export function assertAccess(ent: Entitlements, need: 'write' | 'metered') {
  if (ent.access === 'full') return;
  if (ent.access === 'limited' && need === 'write') return;
  const status = ent.subscription?.status ?? 'none';
  throw commercialError('subscription_inactive', need === 'metered' && ent.access === 'limited'
    ? 'The subscription is waiting for activation; collection, analysis and reports start once it is active'
    : `The subscription is ${status === 'none' ? 'missing' : status}; data stays readable and exportable, but new work cannot start`, { status });
}

export function assertFeature(ent: Entitlements, feature: Feature) {
  if (!ent.features[feature]) throw commercialError('feature_not_in_plan', `Your plan does not include this feature (${feature})`, { feature, plan: ent.subscription?.planCode ?? null });
}

/**
 * Gauge check before creating a resource (or enabling one). Locks per tenant+metric for the rest of the transaction,
 * so two concurrent creations cannot both see the last free slot. Throws 402 quota_exceeded on a hard limit.
 */
export async function assertCapacity(c: PoolClient, ent: Entitlements, metric: Metric, adding = 1): Promise<QuotaDecision> {
  assertAccess(ent, 'write');
  if (ent.quotas[metric].limit === null || ent.quotas[metric].enforcement === 'none') return decide(ent, metric, 0, adding);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quota:${ent.tenantId}:${metric}`]);
  const d = decide(ent, metric, await gaugeUsage(c, metric), adding);
  if (!d.allowed) throw commercialError('quota_exceeded', `Plan limit reached. ${d.reason}`, d);
  return d;
}

export async function requireCapacity(c: PoolClient, tenantId: string, metric: Metric, adding = 1, feature?: Feature) {
  const ent = await loadEntitlements(c, tenantId);
  if (feature) assertFeature(ent, feature);
  return assertCapacity(c, ent, metric, adding);
}

// ── Counters (usage ledger) ────────────────────────────────────────────────────────────────────────
export interface UsageEvent {
  metric: Metric; quantity: number; idempotencyKey: string; source: string;
  occurredAt?: Date; projectId?: string | null; measurement?: 'estimated' | 'confirmed'; metadata?: Record<string, unknown>;
}
export interface ConsumeResult { recorded: boolean; duplicate: boolean; decision: QuotaDecision; notices: number[] }

/**
 * Records usage in the ledger and the period/daily aggregates, idempotently: the same (metric, idempotency key) is
 * counted once however often a job retries or a message is redelivered. With `enforce`, a hard limit is checked under
 * the period-total row lock and nothing is written when the event would exceed it (the caller then refuses the work).
 * Without `enforce` (work already done, e.g. records already fetched), usage is always recorded, as overage if needed.
 * Late events are attributed to the usage period of `occurredAt`, not of the time they arrive.
 */
export async function consume(c: PoolClient, tenantId: string, ev: UsageEvent, opts: { enforce?: boolean; ent?: Entitlements } = {}): Promise<ConsumeResult> {
  if (!(ev.quantity >= 0) || !Number.isFinite(ev.quantity)) throw new Error('usage quantity must be a non-negative number');
  if (!/^[A-Za-z0-9._:@/-]{3,200}$/.test(ev.idempotencyKey)) throw new Error('invalid usage idempotency key');
  const occurredAt = ev.occurredAt ?? new Date();
  const ent = opts.ent ?? await loadEntitlements(c, tenantId, occurredAt);
  const period = usagePeriod(ent.subscription?.usageAnchor ?? new Date(Date.UTC(2000, 0, 1)), occurredAt, ent.periodTimezone);
  // Shared with other consumers; exclusive for reconciliation, which must not recompute while a consumer is mid-write.
  await usageLock(c, tenantId, 'shared');
  const dup = (await c.query('SELECT 1 FROM usage_records WHERE tenant_id = $1 AND metric = $2 AND idempotency_key = $3', [tenantId, ev.metric, ev.idempotencyKey])).rowCount;
  if (dup) return { recorded: false, duplicate: true, decision: decide(ent, ev.metric, await counterUsage(c, tenantId, ev.metric, period), 0), notices: [] };
  // Lock (creating if needed) the period total: concurrent consumers of this metric serialise here.
  await c.query(`INSERT INTO usage_period_totals (tenant_id, metric, period_start, period_end) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, ev.metric, period.start, period.end]);
  const used = Number((await c.query<{ quantity: string }>('SELECT quantity FROM usage_period_totals WHERE tenant_id = $1 AND metric = $2 AND period_start = $3 FOR UPDATE',
    [tenantId, ev.metric, period.start])).rows[0]!.quantity);
  const decision = decide(ent, ev.metric, used, ev.quantity);
  if (opts.enforce && !decision.allowed) return { recorded: false, duplicate: false, decision, notices: [] };
  const ins = await c.query(`INSERT INTO usage_records (tenant_id, metric, quantity, period_start, usage_period_start, occurred_at, idempotency_key, source, measurement, project_id, subscription_id, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (tenant_id, metric, idempotency_key) DO NOTHING RETURNING id`,
    [tenantId, ev.metric, ev.quantity, usageDay(occurredAt, ent.timezone), period.start, occurredAt, ev.idempotencyKey, ev.source, ev.measurement ?? 'confirmed',
      ev.projectId ?? null, ent.subscription?.id ?? null, JSON.stringify({ ...(ev.metadata ?? {}), ...(decision.overage ? { overage: true } : {}) })]);
  if (!ins.rowCount) return { recorded: false, duplicate: true, decision: decide(ent, ev.metric, used, 0), notices: [] };
  await applyAggregates(c, tenantId, ev.metric, ev.quantity, period, usageDay(occurredAt, ent.timezone));
  const notices = await thresholdNotices(c, ent, ev.metric, period, used, used + ev.quantity);
  return { recorded: true, duplicate: false, decision, notices };
}

async function applyAggregates(c: PoolClient, tenantId: string, metric: string, qty: number, period: UsagePeriod, day: string) {
  await c.query(`UPDATE usage_period_totals SET quantity = quantity + $4, updated_at = now() WHERE tenant_id = $1 AND metric = $2 AND period_start = $3`, [tenantId, metric, period.start, qty]);
  await c.query(`INSERT INTO usage_daily (tenant_id, metric, day, quantity, events) VALUES ($1,$2,$3,$4,1)
    ON CONFLICT (tenant_id, metric, day) DO UPDATE SET quantity = usage_daily.quantity + EXCLUDED.quantity, events = usage_daily.events + 1, updated_at = now()`, [tenantId, metric, day, qty]);
}

/**
 * Emits each configured threshold (default 70/85/95/100 %) once per tenant, metric and usage period. The unique key
 * makes concurrent consumers and retries harmless. Returns the thresholds newly crossed.
 */
export async function thresholdNotices(c: PoolClient, ent: Entitlements, metric: Metric, period: UsagePeriod, before: number, after: number): Promise<number[]> {
  const q = ent.quotas[metric];
  if (q.limit === null || q.enforcement === 'none' || q.limit <= 0) return [];
  const thresholds = ent.settings.notice_thresholds ?? DEFAULT_THRESHOLDS;
  const crossed = thresholds.filter((t) => after >= (q.limit! * t) / 100 && before < (q.limit! * t) / 100);
  const created: number[] = [];
  for (const t of crossed) {
    const msg = `${METRICS[metric].label}: ${t}% of the plan limit used (${Math.round(after)} of ${q.limit} ${METRICS[metric].unit}${METRICS[metric].kind === 'counter' ? ' this usage period' : ''}).`
      + (t >= 100 ? (q.enforcement === 'hard' ? ' New work of this kind is paused until the period resets or the plan changes; collected data is kept.' : ' Usage above the limit is recorded as overage.') : '');
    const r = await c.query(`INSERT INTO usage_notices (tenant_id, metric, period_start, threshold, used, quota_limit, message) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, metric, period_start, threshold) DO NOTHING RETURNING id`, [ent.tenantId, metric, period.start, t, after, q.limit, msg]);
    if (r.rowCount) created.push(t);
  }
  return created;
}

/** Gauge notices are evaluated after a successful creation (the count includes the new resource). */
export async function gaugeNotices(c: PoolClient, ent: Entitlements, metric: Metric) {
  const q = ent.quotas[metric];
  if (q.limit === null || q.enforcement === 'none') return [];
  const now = await gaugeUsage(c, metric);
  return thresholdNotices(c, ent, metric, ent.period, now - 1, now);
}

/** Recomputes the period totals and daily aggregates of one tenant from the ledger (reconciliation; repairs drift). */
const usageLock = (c: PoolClient, tenantId: string, mode: 'shared' | 'exclusive') =>
  c.query(mode === 'shared' ? 'SELECT pg_advisory_xact_lock_shared(hashtext($1))' : 'SELECT pg_advisory_xact_lock(hashtext($1))', [`usage:${tenantId}`]);

export async function reconcileAggregates(c: PoolClient, tenantId: string): Promise<{ periodRowsFixed: number; dailyRowsFixed: number }> {
  // Waits for in-flight consumers to commit and keeps new ones out; the sums below then read a snapshot taken after that.
  await usageLock(c, tenantId, 'exclusive');
  const p = await c.query(`WITH l AS (SELECT metric, usage_period_start AS ps, sum(quantity) AS q FROM usage_records WHERE tenant_id = $1 AND usage_period_start IS NOT NULL GROUP BY 1, 2)
    UPDATE usage_period_totals t SET quantity = l.q, updated_at = now() FROM l WHERE t.tenant_id = $1 AND t.metric = l.metric AND t.period_start = l.ps AND t.quantity <> l.q RETURNING 1`, [tenantId]);
  const d = await c.query(`WITH l AS (SELECT metric, period_start AS day, sum(quantity) AS q, count(*) AS n FROM usage_records WHERE tenant_id = $1 AND usage_period_start IS NOT NULL GROUP BY 1, 2)
    UPDATE usage_daily t SET quantity = l.q, events = l.n, updated_at = now() FROM l WHERE t.tenant_id = $1 AND t.metric = l.metric AND t.day = l.day AND (t.quantity <> l.q OR t.events <> l.n) RETURNING 1`, [tenantId]);
  return { periodRowsFixed: p.rowCount ?? 0, dailyRowsFixed: d.rowCount ?? 0 };
}

/**
 * A traceable correction: a new ledger row (kind 'correction', possibly negative) referencing the corrected entry, with
 * a reason and the operator. The original row is never changed.
 */
export async function correctUsage(c: PoolClient, tenantId: string, input: { correctsId: string; quantity: number; reason: string; userId: string; idempotencyKey?: string }) {
  await usageLock(c, tenantId, 'exclusive');   // serialises corrections of the same entry (the check below sees earlier ones)
  const orig = (await c.query<{ id: string; metric: Metric; quantity: string; usage_period_start: Date | null; occurred_at: Date; period_start: string }>(
    'SELECT id, metric, quantity, usage_period_start, occurred_at, period_start FROM usage_records WHERE tenant_id = $1 AND id = $2 AND kind = $3', [tenantId, input.correctsId, 'usage'])).rows[0];
  if (!orig) return null;
  if (!orig.usage_period_start) throw new AppError(409, 'legacy_record', 'Legacy usage records (before plans existed) are not part of any usage period and cannot be corrected');
  const key = `correction:${orig.id}:${input.idempotencyKey ?? Date.now()}`;
  const replay = (await c.query('SELECT id, metric, quantity, usage_period_start, recorded_at FROM usage_records WHERE tenant_id = $1 AND metric = $2 AND idempotency_key = $3', [tenantId, orig.metric, key])).rows[0];
  if (replay) return replay;
  const corrected = Number((await c.query<{ q: string }>('SELECT coalesce(sum(quantity), 0) AS q FROM usage_records WHERE tenant_id = $1 AND corrects_id = $2', [tenantId, orig.id])).rows[0]!.q);
  if (Number(orig.quantity) + corrected + input.quantity < 0) throw new AppError(400, 'validation_failed', 'A correction cannot make the corrected entry negative (earlier corrections included)');
  const ent = await loadEntitlements(c, tenantId, orig.occurred_at);
  const period = usagePeriod(ent.subscription?.usageAnchor ?? new Date(Date.UTC(2000, 0, 1)), orig.occurred_at, ent.periodTimezone);
  await c.query(`INSERT INTO usage_period_totals (tenant_id, metric, period_start, period_end) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, orig.metric, orig.usage_period_start, period.end]);
  await c.query('SELECT 1 FROM usage_period_totals WHERE tenant_id = $1 AND metric = $2 AND period_start = $3 FOR UPDATE', [tenantId, orig.metric, orig.usage_period_start]);
  const r = (await c.query(`INSERT INTO usage_records (tenant_id, metric, quantity, period_start, usage_period_start, occurred_at, idempotency_key, source, kind, measurement, corrects_id, reason, recorded_by, subscription_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'correction','correction','confirmed',$8,$9,$10,$11) RETURNING id, metric, quantity, usage_period_start, recorded_at`,
    [tenantId, orig.metric, input.quantity, orig.period_start, orig.usage_period_start, orig.occurred_at, key, orig.id, input.reason, input.userId, ent.subscription?.id ?? null])).rows[0];
  await applyAggregates(c, tenantId, orig.metric, input.quantity, { start: orig.usage_period_start, end: period.end }, orig.period_start);
  return r;
}

/** Usage of every metric for the current period, with remaining amounts (billing dashboard). */
export async function usageSummary(c: PoolClient, ent: Entitlements) {
  const totals = new Map((await c.query<{ metric: string; quantity: string }>('SELECT metric, quantity FROM usage_period_totals WHERE tenant_id = $1 AND period_start = $2',
    [ent.tenantId, ent.period.start])).rows.map((r) => [r.metric, Number(r.quantity)]));
  const out = [];
  for (const m of METRIC_KEYS) {
    const def = METRICS[m];
    const used = def.kind === 'gauge' ? await gaugeUsage(c, m) : totals.get(m) ?? 0;
    const d = decide(ent, m, used, 0);
    out.push({ metric: m, label: def.label, unit: def.unit, kind: def.kind, description: def.description, used: Math.round(used * 100) / 100, limit: d.limit, remaining: d.remaining,
      percentUsed: d.limit ? Math.round((used / d.limit) * 1000) / 10 : null, enforcement: d.enforcement, source: d.source, overLimit: d.limit !== null && used > d.limit,
      atLimit: d.limit !== null && used >= d.limit });
  }
  return out;
}

/**
 * Whether new collection may start for this tenant. A refusal pauses new collection only: records already collected
 * are kept, and provider refresh/delete obligations, retention and deletion keep running (they never call this).
 */
export async function collectionGate(c: PoolClient, ent: Entitlements, social: boolean): Promise<string | null> {
  if (ent.access !== 'full') return `Subscription is ${ent.subscription?.status ?? 'missing'}: new collection is paused (collected data is kept)`;
  if (social && !ent.features.social_listening) return 'Social listening is not included in the plan';
  const m = decide(ent, 'mentions_ingested', await counterUsage(c, ent.tenantId, 'mentions_ingested', ent.period), 1);
  if (!m.allowed) return `Plan limit reached. ${m.reason}. Collection resumes when the usage period resets (${ent.period.end.toISOString()}) or the plan changes`;
  if (social) {
    const s = decide(ent, 'social_api_units', await counterUsage(c, ent.tenantId, 'social_api_units', ent.period), 1);
    if (!s.allowed) return `Plan limit reached. ${s.reason}. Social collection resumes when the usage period resets (${ent.period.end.toISOString()}) or the plan changes`;
  }
  return null;
}
