import type { PoolClient } from 'pg';
import { conflict } from '../common/errors';

/**
 * Subscription state machine. Every status change goes through `transition`, which checks this table, writes the new
 * state and appends a subscription_events row in the same transaction. Nothing else updates subscriptions.status.
 */
export type SubStatus = 'trialing' | 'pending_activation' | 'active' | 'pending_renewal' | 'past_due' | 'suspended' | 'canceled' | 'expired';
export const TERMINAL: SubStatus[] = ['canceled', 'expired'];

export type SubEvent =
  | 'activate'              // contract/payment confirmed (operator or verified provider event)
  | 'request_activation'    // contract signed; waiting for PO / first payment
  | 'payment_failed'        // provider reported a failed renewal payment, or a contract invoice became overdue
  | 'payment_recovered'     // the overdue amount was paid
  | 'suspend'               // operator action, or past-due grace elapsed
  | 'reinstate'             // operator lifts a suspension
  | 'renewal_due'           // contract end is near and no renewal is recorded
  | 'renew'                 // renewal recorded: new term
  | 'trial_expired'         // trial ended without activation
  | 'cancel_now'            // immediate cancellation (operator)
  | 'period_end_cancel'     // cancel-at-period-end reached the period end
  | 'term_expired';         // contract term ended without renewal

const T: Record<SubEvent, { from: SubStatus[]; to: SubStatus }> = {
  activate: { from: ['trialing', 'pending_activation', 'pending_renewal'], to: 'active' },
  request_activation: { from: ['trialing'], to: 'pending_activation' },
  payment_failed: { from: ['active', 'pending_renewal'], to: 'past_due' },
  payment_recovered: { from: ['past_due', 'suspended'], to: 'active' },
  suspend: { from: ['trialing', 'pending_activation', 'active', 'pending_renewal', 'past_due'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'active' },
  renewal_due: { from: ['active'], to: 'pending_renewal' },
  renew: { from: ['active', 'pending_renewal', 'past_due'], to: 'active' },
  trial_expired: { from: ['trialing'], to: 'expired' },
  cancel_now: { from: ['trialing', 'pending_activation', 'active', 'pending_renewal', 'past_due', 'suspended'], to: 'canceled' },
  period_end_cancel: { from: ['active', 'pending_renewal', 'past_due', 'trialing'], to: 'canceled' },
  term_expired: { from: ['pending_renewal', 'suspended', 'past_due'], to: 'expired' },
};

export function nextStatus(from: SubStatus, event: SubEvent): SubStatus | null {
  const t = T[event];
  return t.from.includes(from) ? t.to : null;
}
export const allowedEvents = (from: SubStatus) => (Object.keys(T) as SubEvent[]).filter((e) => T[e].from.includes(from));

/** What the organization may do in each state. Reading data, exports, governance and security work are always allowed. */
export type Access = 'full' | 'limited' | 'read_only';
export function accessFor(status: SubStatus | null): Access {
  if (status === 'trialing' || status === 'active' || status === 'pending_renewal' || status === 'past_due') return 'full';
  if (status === 'pending_activation') return 'limited';      // configure, invite, set up; no metered processing yet
  return 'read_only';                                         // suspended, canceled, expired, or no subscription
}

export interface Actor { type: 'user' | 'platform_admin' | 'system' | 'billing_provider'; userId?: string | null; reason?: string | null }

export interface SubscriptionRow {
  id: string; tenant_id: string; status: SubStatus; plan_code: string; plan_version_id: string | null; billing_mode: 'self_service' | 'contract' | 'manual';
  trial_ends_at: Date | null; current_period_start: Date | null; current_period_end: Date | null; cancel_at_period_end: boolean;
  scheduled_plan_version_id: string | null; scheduled_change_at: Date | null; past_due_since: Date | null; usage_anchor: Date; contract_id: string | null;
  suspended_reason: string | null; canceled_at: Date | null; ended_at: Date | null; billing_provider: string | null; billing_reference: string | null; provider_customer_ref: string | null;
}

export async function lockSubscription(c: PoolClient, tenantId: string): Promise<SubscriptionRow | null> {
  return (await c.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE tenant_id = $1 AND ended_at IS NULL FOR UPDATE', [tenantId])).rows[0] ?? null;
}

export async function recordEvent(c: PoolClient, sub: { id: string; tenant_id: string }, e: {
  event: string; from?: SubStatus | null; to?: SubStatus | null; fromPlan?: string | null; toPlan?: string | null; actor: Actor; metadata?: Record<string, unknown>;
}) {
  await c.query(`INSERT INTO subscription_events (tenant_id, subscription_id, event, from_status, to_status, from_plan_version_id, to_plan_version_id, actor_type, actor_user_id, reason, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [sub.tenant_id, sub.id, e.event, e.from ?? null, e.to ?? null, e.fromPlan ?? null, e.toPlan ?? null, e.actor.type, e.actor.userId ?? null, e.actor.reason ?? null, JSON.stringify(e.metadata ?? {})]);
}

/**
 * Applies a lifecycle event to a locked subscription row. `patch` sets extra columns (periods, cancel flags) in the same
 * UPDATE. Rejects transitions not in the table with 409 invalid_transition.
 */
export async function transition(c: PoolClient, sub: SubscriptionRow, event: SubEvent, actor: Actor,
  patch: Partial<Record<'current_period_start' | 'current_period_end' | 'trial_ends_at' | 'plan_version_id' | 'plan_code' | 'usage_anchor', unknown>> = {},
  metadata: Record<string, unknown> = {}): Promise<SubscriptionRow> {
  const to = nextStatus(sub.status, event);
  if (!to) throw conflict('invalid_transition', `A ${sub.status} subscription cannot ${event.replace(/_/g, ' ')}`);
  const sets: string[] = ['status = $2']; const vals: unknown[] = [sub.id, to];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const [k, v] of Object.entries(patch)) add(k, v);
  if (to === 'past_due' && !sub.past_due_since) sets.push('past_due_since = now()');
  if (to === 'active') sets.push('past_due_since = NULL', 'suspended_reason = NULL');
  if (to === 'suspended') add('suspended_reason', actor.reason ?? event);
  if (to === 'canceled') sets.push('canceled_at = coalesce(canceled_at, now())');
  if (TERMINAL.includes(to)) sets.push('ended_at = now()', 'scheduled_plan_version_id = NULL', 'scheduled_change_at = NULL');
  const row = (await c.query<SubscriptionRow>(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)).rows[0]!;
  await recordEvent(c, sub, { event, from: sub.status, to, fromPlan: sub.plan_version_id, toPlan: row.plan_version_id, actor, metadata });
  return row;
}
