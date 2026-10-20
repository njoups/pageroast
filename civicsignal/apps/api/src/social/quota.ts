import type { PoolClient } from 'pg';
import type { UsageReport } from '../ingestion/connectors/connector';
import { youtubeQuotaDay } from '../ingestion/connectors/youtube.connector';
import { providerForKind } from './providers';

/**
 * Provider quota and tenant budget accounting, shared by the ingestion pipeline (before and after each sync), the
 * lifecycle job and the social API. All functions run in the caller's tenant transaction (RLS applies).
 */

export interface QuotaBucketState { key: string; label: string; limit: number | null; used: number; remaining: number | null; requests: number }
export interface QuotaState { provider: string; day: string; resetsAt: string | null; buckets: QuotaBucketState[]; exhausted: boolean }

/** The provider's quota day for `now` (YouTube: Pacific Time); other providers: UTC day. */
export function providerDay(kind: string, now = new Date()): { day: string; resetsAt: Date | null } {
  if (kind === 'youtube') return youtubeQuotaDay(now);
  return { day: now.toISOString().slice(0, 10), resetsAt: null };
}

export async function recordProviderUsage(c: PoolClient, x: { tenantId: string; connectorId: string; kind: string; usage: UsageReport | undefined; retrieved?: number; rejected?: number; now?: Date }) {
  const provider = providerForKind(x.kind)?.provider ?? x.kind;
  const { day } = providerDay(x.kind, x.now);
  const buckets = Object.entries(x.usage?.buckets ?? {});
  // Records and rate-limit counts are attached to the first bucket used (or 'units'), so totals add up once.
  if (!buckets.length && (x.retrieved || x.rejected || x.usage?.rateLimited)) buckets.push(['units', { requests: 0, units: 0 }]);
  let first = true;
  for (const [bucket, b] of buckets) {
    await c.query(
      `INSERT INTO provider_usage (tenant_id, connector_id, provider, day, bucket, requests, units, records_retrieved, records_rejected, rate_limited)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (connector_id, day, bucket) DO UPDATE SET requests = provider_usage.requests + EXCLUDED.requests,
         units = provider_usage.units + EXCLUDED.units, records_retrieved = provider_usage.records_retrieved + EXCLUDED.records_retrieved,
         records_rejected = provider_usage.records_rejected + EXCLUDED.records_rejected, rate_limited = provider_usage.rate_limited + EXCLUDED.rate_limited,
         updated_at = now()`,
      [x.tenantId, x.connectorId, provider, day, bucket, b.requests, b.units, first ? x.retrieved ?? 0 : 0, first ? x.rejected ?? 0 : 0, first ? x.usage?.rateLimited ?? 0 : 0]);
    first = false;
  }
}

/** Quota limits per bucket: connector config overrides (approved extensions) else the provider's documented defaults. */
export function quotaLimits(kind: string, config: unknown): Record<string, number | null> {
  const d = providerForKind(kind);
  const out: Record<string, number | null> = {};
  for (const b of d?.quota.buckets ?? []) out[b.key] = b.perDay;
  const o = (config as { quotaPerDay?: Record<string, number> } | null)?.quotaPerDay;
  if (o) for (const [k, v] of Object.entries(o)) if (k in out && typeof v === 'number') out[k] = v;
  return out;
}

export async function quotaState(c: PoolClient, connectorId: string, kind: string, config: unknown, now = new Date()): Promise<QuotaState> {
  const d = providerForKind(kind);
  const { day, resetsAt } = providerDay(kind, now);
  const used = new Map((await c.query<{ bucket: string; units: string; requests: number }>(
    'SELECT bucket, units, requests FROM provider_usage WHERE connector_id = $1 AND day = $2', [connectorId, day])).rows.map((r) => [r.bucket, r]));
  const limits = quotaLimits(kind, config);
  const buckets = (d?.quota.buckets ?? []).map((b) => {
    const u = Number(used.get(b.key)?.units ?? 0); const limit = limits[b.key] ?? null;
    return { key: b.key, label: b.label, limit, used: u, remaining: limit === null ? null : Math.max(limit - u, 0), requests: used.get(b.key)?.requests ?? 0 };
  });
  return { provider: d?.provider ?? kind, day, resetsAt: resetsAt?.toISOString() ?? null, buckets, exhausted: buckets.some((b) => b.remaining === 0) };
}

/** Buckets in which `need` would exceed what is left today. */
export function quotaShortfall(q: QuotaState, need: Record<string, number>): Array<{ bucket: string; need: number; remaining: number }> {
  return q.buckets.filter((b) => b.remaining !== null && (need[b.key] ?? 0) > b.remaining).map((b) => ({ bucket: b.key, need: need[b.key]!, remaining: b.remaining! }));
}

// ── Cost estimates ─────────────────────────────────────────────────────────────────────────────────

export interface CostEstimate { status: 'estimated' | 'not_priced' | 'incomplete'; amount: number | null; currency: string | null; basis: string[]; verifiedAt: string | null }

/**
 * Estimated provider charges from configured pricing rows only. A provider without pricing rows is 'not_priced' (no
 * figure is shown); usage items without a matching price make the estimate 'incomplete'.
 */
export async function estimateCost(c: PoolClient, provider: string, usage: { requests: number; recordsRetrieved: number }): Promise<CostEstimate> {
  const rows = (await c.query<{ item: string; unit_price: string; currency: string; verified_at: Date; source_url: string }>(
    'SELECT item, unit_price, currency, verified_at, source_url FROM provider_pricing WHERE provider = $1', [provider])).rows;
  if (!rows.length) return { status: 'not_priced', amount: null, currency: null, basis: ['No pricing is configured for this provider.'], verifiedAt: null };
  const qty: Record<string, number> = { request: usage.requests, record_read: usage.recordsRetrieved, post_read: usage.recordsRetrieved };
  const currencies = new Set(rows.map((r) => r.currency));
  let amount = 0; const basis: string[] = []; let complete = currencies.size === 1;
  for (const r of rows) {
    if (!(r.item in qty)) { complete = false; basis.push(`${r.item}: no usage counter for this item`); continue; }
    amount += qty[r.item]! * Number(r.unit_price);
    basis.push(`${qty[r.item]} × ${r.item} at ${r.unit_price} ${r.currency} (verified ${r.verified_at.toISOString().slice(0, 10)}, ${r.source_url})`);
  }
  const verified = rows.map((r) => r.verified_at.toISOString().slice(0, 10)).sort()[0] ?? null;
  return { status: complete ? 'estimated' : 'incomplete', amount: complete ? Math.round(amount * 10_000) / 10_000 : null, currency: complete ? [...currencies][0]! : null, basis, verifiedAt: verified };
}

// ── Budgets ────────────────────────────────────────────────────────────────────────────────────────

export type BudgetLevel = 'none' | 'warn' | 'soft' | 'hard';
export interface BudgetCheck { level: BudgetLevel; items: Array<{ budgetId: string; metric: string; period: string; value: number; warnAt: number | null; softLimit: number | null; hardLimit: number | null; level: BudgetLevel; costStatus?: string }> }

const RANK: Record<BudgetLevel, number> = { none: 0, warn: 1, soft: 2, hard: 3 };

/** Usage totals for budgets: per provider day (period 'day') or calendar month of provider days (period 'month'). */
async function usageTotals(c: PoolClient, connectorIds: string[] | null, kind: string, period: 'day' | 'month', now: Date) {
  const { day } = providerDay(kind, now);
  const r = (await c.query<{ units: string; requests: number; records: number }>(
    `SELECT coalesce(sum(units),0) AS units, coalesce(sum(requests),0)::int AS requests, coalesce(sum(records_retrieved),0)::int AS records
     FROM provider_usage WHERE ($1::uuid[] IS NULL OR connector_id = ANY($1::uuid[])) AND ${period === 'day' ? 'day = $2::date' : `to_char(day, 'YYYY-MM') = substr($2, 1, 7)`}`,
    [connectorIds, day])).rows[0]!;
  return { units: Number(r.units), requests: r.requests, records: r.records, periodKey: period === 'day' ? day : day.slice(0, 7) };
}

/**
 * Evaluates the tenant's budgets that apply to a connector and records each newly reached level once per period
 * (social_budget_events). Returns the highest level reached.
 */
export async function checkBudgets(c: PoolClient, x: { tenantId: string; connectorId: string; kind: string; now?: Date }): Promise<BudgetCheck> {
  const now = x.now ?? new Date();
  const budgets = (await c.query<{ id: string; connector_id: string | null; metric: string; period: 'day' | 'month'; warn_at: string | null; soft_limit: string | null; hard_limit: string | null }>(
    'SELECT * FROM social_budgets WHERE connector_id IS NULL OR connector_id = $1', [x.connectorId])).rows;
  const out: BudgetCheck = { level: 'none', items: [] };
  for (const b of budgets) {
    const ids = b.connector_id ? [b.connector_id] : null;
    const t = await usageTotals(c, ids, x.kind, b.period, now);
    let value: number; let costStatus: string | undefined;
    if (b.metric === 'quota_units') value = t.units;
    else if (b.metric === 'requests') value = t.requests;
    else if (b.metric === 'records_retrieved') value = t.records;
    else {
      const est = await estimateCost(c, providerForKind(x.kind)?.provider ?? x.kind, { requests: t.requests, recordsRetrieved: t.records });
      costStatus = est.status; value = est.amount ?? 0;
      if (est.status !== 'estimated') { out.items.push({ budgetId: b.id, metric: b.metric, period: b.period, value, warnAt: num(b.warn_at), softLimit: num(b.soft_limit), hardLimit: num(b.hard_limit), level: 'none', costStatus }); continue; }
    }
    const level: BudgetLevel = b.hard_limit !== null && value >= Number(b.hard_limit) ? 'hard'
      : b.soft_limit !== null && value >= Number(b.soft_limit) ? 'soft' : b.warn_at !== null && value >= Number(b.warn_at) ? 'warn' : 'none';
    out.items.push({ budgetId: b.id, metric: b.metric, period: b.period, value, warnAt: num(b.warn_at), softLimit: num(b.soft_limit), hardLimit: num(b.hard_limit), level, costStatus });
    if (RANK[level] > RANK[out.level]) out.level = level;
    if (level !== 'none') {
      const threshold = Number(level === 'hard' ? b.hard_limit : level === 'soft' ? b.soft_limit : b.warn_at);
      await c.query(`INSERT INTO social_budget_events (tenant_id, connector_id, budget_id, level, metric, period_key, value, threshold) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT DO NOTHING`, [x.tenantId, x.connectorId, b.id, level, b.metric, t.periodKey, value, threshold]);
    }
  }
  return out;
}
const num = (v: string | null) => (v === null ? null : Number(v));

/** Pauses scheduled collection for a connector until `until` (provider quota reset or budget period end). */
export async function pauseConnector(c: PoolClient, x: { tenantId: string; connectorId: string; sourceId: string; until: Date; reason: 'provider_quota' | 'budget_soft_limit' | 'budget_hard_limit'; metric?: string; value?: number; threshold?: number; periodKey?: string }) {
  await c.query(`UPDATE connectors SET paused_until = $2, paused_reason = $3 WHERE id = $1`, [x.connectorId, x.until, x.reason]);
  await c.query(`UPDATE ingestion_schedule SET next_due_at = greatest(next_due_at, $2) WHERE source_id = $1`, [x.sourceId, x.until]);
  if (x.reason === 'provider_quota') {
    await c.query(`INSERT INTO social_budget_events (tenant_id, connector_id, level, metric, period_key, value, threshold) VALUES ($1,$2,'provider_quota',$3,$4,$5,$6)
      ON CONFLICT DO NOTHING`, [x.tenantId, x.connectorId, x.metric ?? 'quota_units', x.periodKey ?? x.until.toISOString().slice(0, 10), x.value ?? 0, x.threshold ?? 0]);
  }
}

/** End of the budget period containing now (UTC day or month), used as the pause horizon for budget limits. */
export function budgetPeriodEnd(kind: string, period: 'day' | 'month', now = new Date()): Date {
  const pd = providerDay(kind, now);
  if (period === 'day') return pd.resetsAt ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
