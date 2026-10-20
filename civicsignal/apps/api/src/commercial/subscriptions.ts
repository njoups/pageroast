import type { PoolClient } from 'pg';
import { AppError, conflict, notFound } from '../common/errors';
import { lockSubscription, recordEvent, transition, type Actor, type SubscriptionRow } from './lifecycle';
import { addMonths } from './periods';

export interface PlanVersionRow {
  id: string; plan_id: string; code: string; name: string; category: string; is_public: boolean; is_active: boolean; version: number;
  effective_from: Date; effective_to: Date | null; currency: string | null; price_amount: string | null; billing_interval: 'month' | 'year' | 'custom';
  trial_days: number; features: Record<string, boolean>; quotas: Record<string, unknown>; settings: Record<string, unknown>;
}

const PV_SELECT = `SELECT pv.*, p.code, p.name, p.category, p.is_public, p.is_active FROM plan_versions pv JOIN plans p ON p.id = pv.plan_id`;

/** The version of a plan in effect at `at` (latest effective_from that has started and not ended). */
export async function currentVersion(c: PoolClient, planCode: string, at = new Date()): Promise<PlanVersionRow | null> {
  return (await c.query<PlanVersionRow>(`${PV_SELECT} WHERE p.code = $1 AND pv.effective_from <= $2 AND (pv.effective_to IS NULL OR pv.effective_to > $2)
    ORDER BY pv.effective_from DESC, pv.version DESC LIMIT 1`, [planCode, at])).rows[0] ?? null;
}
export async function versionById(c: PoolClient, id: string): Promise<PlanVersionRow | null> {
  return (await c.query<PlanVersionRow>(`${PV_SELECT} WHERE pv.id = $1`, [id])).rows[0] ?? null;
}

export async function tenantTimezone(c: PoolClient, tenantId: string): Promise<string> {
  return (await c.query<{ tz: string | null }>(`SELECT settings->>'timezone' AS tz FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.tz || 'Asia/Jakarta';
}

export function periodEnd(start: Date, interval: string, tz: string): Date {
  return addMonths(start, interval === 'year' ? 12 : 1, tz);
}

/**
 * Starts the configured trial for a new organization (called inside the organization-creation transaction). A trial plan
 * without trial days starts as an active manually billed subscription instead.
 */
export async function startTrial(c: PoolClient, tenantId: string, planCode: string, actor: Actor, now = new Date()) {
  const pv = await currentVersion(c, planCode, now);
  if (!pv || !pv.is_active) throw new AppError(500, 'trial_plan_missing', `The configured trial plan "${planCode}" has no active version`);
  const tz = await tenantTimezone(c, tenantId);
  const trial = pv.trial_days > 0;
  const end = trial ? new Date(now.getTime() + pv.trial_days * 86_400_000) : periodEnd(now, pv.billing_interval, tz);
  const s = (await c.query<SubscriptionRow>(`INSERT INTO subscriptions (tenant_id, plan_code, status, plan_version_id, billing_mode, trial_ends_at, current_period_start, current_period_end, usage_anchor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7) RETURNING *`,
    [tenantId, pv.code, trial ? 'trialing' : 'active', pv.id, trial ? 'self_service' : 'manual', trial ? end : null, now, end])).rows[0]!;
  await recordEvent(c, s, { event: trial ? 'trial_started' : 'subscription_created', to: s.status, toPlan: pv.id, actor, metadata: { trialDays: pv.trial_days } });
  return s;
}

/**
 * Operator assignment of a plan (manual provisioning, contract activation). Ends the current subscription if it is in
 * a terminal state, otherwise changes its plan in place (history is kept in subscription_events).
 */
export async function assignPlan(c: PoolClient, tenantId: string, input: {
  planVersionId: string; billingMode: 'self_service' | 'contract' | 'manual'; status: 'trialing' | 'pending_activation' | 'active';
  periodStart?: Date; periodEnd?: Date; trialEndsAt?: Date; contractId?: string | null; resetUsageAnchor?: boolean;
}, actor: Actor, now = new Date()) {
  const pv = await versionById(c, input.planVersionId);
  if (!pv) throw notFound('Plan version');
  if (!pv.is_active) throw conflict('plan_inactive', 'This plan is not available for assignment');
  if (input.status === 'trialing' && !input.trialEndsAt) throw new AppError(400, 'validation_failed', 'A trial needs trialEndsAt');
  const tz = await tenantTimezone(c, tenantId);
  const start = input.periodStart ?? now;
  const end = input.periodEnd ?? (input.status === 'trialing' ? input.trialEndsAt! : periodEnd(start, pv.billing_interval, tz));
  if (end <= start) throw new AppError(400, 'validation_failed', 'The period must end after it starts');
  const cur = await lockSubscription(c, tenantId);
  if (!cur) {
    const s = (await c.query<SubscriptionRow>(`INSERT INTO subscriptions (tenant_id, plan_code, status, plan_version_id, billing_mode, trial_ends_at, current_period_start, current_period_end, usage_anchor, contract_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9) RETURNING *`,
      [tenantId, pv.code, input.status, pv.id, input.billingMode, input.trialEndsAt ?? null, start, end, input.contractId ?? null])).rows[0]!;
    await recordEvent(c, s, { event: 'plan_assigned', to: s.status, toPlan: pv.id, actor, metadata: { billingMode: input.billingMode } });
    return s;
  }
  const s = (await c.query<SubscriptionRow>(`UPDATE subscriptions SET plan_code = $2, plan_version_id = $3, billing_mode = $4, status = $5, trial_ends_at = $6, current_period_start = $7,
      current_period_end = $8, contract_id = coalesce($9, contract_id), cancel_at_period_end = false, canceled_at = NULL, scheduled_plan_version_id = NULL, scheduled_change_at = NULL,
      past_due_since = NULL, suspended_reason = NULL, usage_anchor = CASE WHEN $10 THEN $7 ELSE usage_anchor END
    WHERE id = $1 RETURNING *`,
    [cur.id, pv.code, pv.id, input.billingMode, input.status, input.trialEndsAt ?? null, start, end, input.contractId ?? null, input.resetUsageAnchor === true])).rows[0]!;
  await recordEvent(c, cur, { event: 'plan_assigned', from: cur.status, to: s.status, fromPlan: cur.plan_version_id, toPlan: pv.id, actor, metadata: { billingMode: input.billingMode } });
  return s;
}

/** Immediate plan change keeping the status and period (upgrade). */
export async function changePlanNow(c: PoolClient, sub: SubscriptionRow, planVersionId: string, actor: Actor) {
  const pv = await versionById(c, planVersionId);
  if (!pv) throw notFound('Plan version');
  if (sub.status === 'canceled' || sub.status === 'expired') throw conflict('invalid_transition', 'An ended subscription cannot change plan; assign a new plan instead');
  const s = (await c.query<SubscriptionRow>(`UPDATE subscriptions SET plan_code = $2, plan_version_id = $3, scheduled_plan_version_id = NULL, scheduled_change_at = NULL WHERE id = $1 RETURNING *`,
    [sub.id, pv.code, pv.id])).rows[0]!;
  await recordEvent(c, sub, { event: 'plan_changed', from: sub.status, to: s.status, fromPlan: sub.plan_version_id, toPlan: pv.id, actor });
  return s;
}

/** Plan change at a future moment (downgrade at period end). Applied by the commercial scheduler. */
export async function scheduleChange(c: PoolClient, sub: SubscriptionRow, planVersionId: string, at: Date, actor: Actor) {
  if (!(await versionById(c, planVersionId))) throw notFound('Plan version');
  if (sub.status === 'canceled' || sub.status === 'expired') throw conflict('invalid_transition', 'An ended subscription cannot schedule a change');
  const s = (await c.query<SubscriptionRow>('UPDATE subscriptions SET scheduled_plan_version_id = $2, scheduled_change_at = $3 WHERE id = $1 RETURNING *', [sub.id, planVersionId, at])).rows[0]!;
  await recordEvent(c, sub, { event: 'change_scheduled', from: sub.status, to: sub.status, fromPlan: sub.plan_version_id, toPlan: planVersionId, actor, metadata: { at: at.toISOString() } });
  return s;
}

export async function setCancelAtPeriodEnd(c: PoolClient, sub: SubscriptionRow, value: boolean, actor: Actor) {
  if (sub.status === 'canceled' || sub.status === 'expired') throw conflict('invalid_transition', 'The subscription has already ended');
  if (sub.cancel_at_period_end === value) return sub;
  const s = (await c.query<SubscriptionRow>('UPDATE subscriptions SET cancel_at_period_end = $2 WHERE id = $1 RETURNING *', [sub.id, value])).rows[0]!;
  await recordEvent(c, sub, { event: value ? 'cancel_scheduled' : 'cancel_withdrawn', from: sub.status, to: sub.status, actor });
  return s;
}

/** Rolls a manual/contract subscription into its next billing period (no status change). */
export async function rollPeriod(c: PoolClient, sub: SubscriptionRow, tz: string, actor: Actor) {
  const pv = sub.plan_version_id ? await versionById(c, sub.plan_version_id) : null;
  const start = sub.current_period_end!;
  const end = periodEnd(start, pv?.billing_interval ?? 'month', tz);
  const s = (await c.query<SubscriptionRow>('UPDATE subscriptions SET current_period_start = $2, current_period_end = $3 WHERE id = $1 RETURNING *', [sub.id, start, end])).rows[0]!;
  await recordEvent(c, sub, { event: 'period_renewed', from: sub.status, to: sub.status, actor, metadata: { start: start.toISOString(), end: end.toISOString() } });
  return s;
}

export { transition };
