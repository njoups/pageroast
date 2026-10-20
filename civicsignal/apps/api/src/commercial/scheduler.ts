import type { PoolClient } from 'pg';
import type { AppConfig } from '../config';
import type { Database } from '../database/database.service';
import { EmailChannel } from '../alerts/channels/email';
import { logEvent } from '../ingestion/log';
import { METRICS, isMetric } from './catalog';
import { lockSubscription, nextStatus, transition, type Actor, type SubscriptionRow } from './lifecycle';
import { changePlanNow, rollPeriod, tenantTimezone } from './subscriptions';

const SYS = '00000000-0000-0000-0000-000000000000';
const SYSTEM: Actor = { type: 'system' };
const RENEWAL_NOTICE_DAYS = 30;

export interface CommercialTickResult { trialsExpired: number; suspended: number; scheduledApplied: number; canceled: number; renewed: number; renewalDue: number; termExpired: number; invoicesOverdue: number; noticesEmailed: number }

/**
 * Commercial scheduler (worker, every 5 minutes). Each step selects candidates in system context, then re-locks and
 * re-checks the subscription inside the tenant's transaction, so concurrent workers and restarts apply each change
 * once. Never touches tenant content, never deletes data.
 */
export async function commercialTick(db: Database, config: AppConfig, now = new Date(), email: EmailChannel = new EmailChannel(config.email)): Promise<CommercialTickResult> {
  const r: CommercialTickResult = { trialsExpired: 0, suspended: 0, scheduledApplied: 0, canceled: 0, renewed: 0, renewalDue: 0, termExpired: 0, invoicesOverdue: 0, noticesEmailed: 0 };
  const candidates = (sql: string, params: unknown[] = [now]) => db.withSystem(async (c) => (await c.query<{ tenant_id: string }>(sql, params)).rows.map((x) => x.tenant_id));
  const each = async (tenants: string[], fn: (c: PoolClient, sub: SubscriptionRow) => Promise<boolean>) => eachTenant(tenants, async (c, t) => {
    const sub = await lockSubscription(c, t); return sub ? fn(c, sub) : false;
  });
  const eachTenant = async (tenants: string[], fn: (c: PoolClient, tenantId: string) => Promise<boolean>) => {
    let n = 0;
    for (const t of tenants) {
      try {
        if (await db.withTenant(t, SYS, (c) => fn(c, t))) n++;
      } catch (e) { logEvent('error', 'commercial.tick_error', { tenantId: t, message: (e as Error).message }); }
    }
    return n;
  };

  // 1. Invoices past their due date become overdue; an overdue invoice on a contract/manual subscription marks it past due.
  r.invoicesOverdue = await eachTenant(await candidates(`SELECT DISTINCT tenant_id FROM invoices WHERE status IN ('issued','partially_paid') AND due_at < $1 LIMIT 500`), async (c, tenantId) => {
    const n = (await c.query(`UPDATE invoices SET status = 'overdue' WHERE tenant_id = $1 AND status IN ('issued','partially_paid') AND due_at < $2 RETURNING id`, [tenantId, now])).rowCount ?? 0;
    const sub = await lockSubscription(c, tenantId);
    if (n && sub && sub.billing_mode !== 'self_service' && nextStatus(sub.status, 'payment_failed')) await transition(c, sub, 'payment_failed', { ...SYSTEM, reason: 'invoice_overdue' });
    return n > 0;
  });

  // 2. Trials that ended without activation expire (data is kept; the organization becomes read-only).
  r.trialsExpired = await each(await candidates(`SELECT tenant_id FROM subscriptions WHERE status = 'trialing' AND ended_at IS NULL AND trial_ends_at <= $1 LIMIT 500`), async (c, sub) => {
    if (sub.status !== 'trialing' || !sub.trial_ends_at || sub.trial_ends_at > now) return false;
    await transition(c, sub, sub.cancel_at_period_end ? 'period_end_cancel' : 'trial_expired', SYSTEM);
    return true;
  });

  // 3. Past-due grace elapsed → suspended.
  r.suspended = await each(await candidates(`SELECT s.tenant_id FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id
      WHERE s.status = 'past_due' AND s.ended_at IS NULL AND s.past_due_since + make_interval(days => coalesce((pv.settings->>'past_due_grace_days')::int, 14)) <= $1 LIMIT 500`), async (c, sub) => {
    if (sub.status !== 'past_due') return false;
    await transition(c, sub, 'suspend', { ...SYSTEM, reason: 'past_due_grace_elapsed' });
    return true;
  });

  // 4. Scheduled plan changes (downgrades at period end).
  r.scheduledApplied = await each(await candidates(`SELECT tenant_id FROM subscriptions WHERE scheduled_change_at <= $1 AND ended_at IS NULL LIMIT 500`), async (c, sub) => {
    if (!sub.scheduled_plan_version_id || !sub.scheduled_change_at || sub.scheduled_change_at > now) return false;
    await changePlanNow(c, sub, sub.scheduled_plan_version_id, { ...SYSTEM, reason: 'scheduled_change' });
    return true;
  });

  // 5. Period end: cancel-at-period-end, otherwise roll manual/contract periods forward. Self-service periods are moved
  //    by the provider's paid-invoice events, never by the clock.
  const ends = await candidates(`SELECT tenant_id FROM subscriptions WHERE status IN ('active','past_due','pending_renewal') AND ended_at IS NULL AND current_period_end <= $1 LIMIT 500`);
  for (const t of ends) {
    try {
      const out = await db.withTenant(t, SYS, async (c) => {
        let sub = await lockSubscription(c, t);
        if (!sub?.current_period_end || sub.current_period_end > now) return null;
        if (sub.cancel_at_period_end) { await transition(c, sub, 'period_end_cancel', SYSTEM); return 'canceled' as const; }
        if (sub.billing_mode === 'self_service') return null;
        if (sub.contract_id) {
          const k = (await c.query<{ end_date: string }>('SELECT end_date FROM contracts WHERE id = $1', [sub.contract_id])).rows[0];
          if (k && new Date(`${k.end_date}T23:59:59Z`) < now) return null;     // contract term ended: handled in step 6
        }
        const tz = await tenantTimezone(c, t);
        let guard = 0;
        while (sub.current_period_end && sub.current_period_end <= now && guard++ < 24) sub = await rollPeriod(c, sub, tz, SYSTEM);
        return 'renewed' as const;
      });
      if (out === 'canceled') r.canceled++; else if (out === 'renewed') r.renewed++;
    } catch (e) { logEvent('error', 'commercial.tick_error', { tenantId: t, message: (e as Error).message }); }
  }

  // 6. Contract terms: renewal due 30 days before the end; expired after the end plus the plan's grace days.
  r.renewalDue = await each(await candidates(`SELECT s.tenant_id FROM subscriptions s JOIN contracts k ON k.id = s.contract_id
      WHERE s.status = 'active' AND s.ended_at IS NULL AND k.status = 'active' AND k.end_date <= ($1::timestamptz + make_interval(days => ${RENEWAL_NOTICE_DAYS}))::date LIMIT 500`), async (c, sub) => {
    if (sub.status !== 'active') return false;
    await transition(c, sub, 'renewal_due', SYSTEM);
    return true;
  });
  r.termExpired = await each(await candidates(`SELECT s.tenant_id FROM subscriptions s JOIN contracts k ON k.id = s.contract_id JOIN plan_versions pv ON pv.id = s.plan_version_id
      WHERE s.status IN ('pending_renewal','past_due','suspended') AND s.ended_at IS NULL
        AND k.end_date + coalesce((pv.settings->>'past_due_grace_days')::int, 14) < $1::date LIMIT 500`), async (c, sub) => {
    if (!nextStatus(sub.status, 'term_expired')) return false;
    await transition(c, sub, 'term_expired', SYSTEM);
    await c.query(`UPDATE contracts SET status = 'expired' WHERE id = $1 AND status = 'active'`, [sub.contract_id]);
    return true;
  });

  // 7. Usage threshold notices by email to owners and admins (each notice once; stored in-app regardless).
  const pending = await db.withSystem(async (c) => (await c.query<{ id: string; tenant_id: string; metric: string; threshold: number; message: string; tenant_name: string }>(
    `SELECT n.id, n.tenant_id, n.metric, n.threshold, n.message, t.name AS tenant_name FROM usage_notices n JOIN tenants t ON t.id = n.tenant_id
     WHERE n.email_status = 'pending' ORDER BY n.created_at LIMIT 200`)).rows);
  for (const n of pending) {
    await db.withTenant(n.tenant_id, SYS, async (c) => {
      if (!email.configured) { await c.query(`UPDATE usage_notices SET email_status = 'not_configured' WHERE id = $1`, [n.id]); return; }
      const to = (await c.query<{ email: string }>(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role IN ('owner','admin')`)).rows;
      const label = isMetric(n.metric) ? METRICS[n.metric].label : n.metric;
      let ok = 0;
      for (const u of to) {
        try {
          await email.send({ to: u.email, subject: `[CivicSignal] ${label}: ${n.threshold}% of plan limit — ${n.tenant_name}`, text: `${n.message}\n\nBilling and usage: ${config.appBaseUrl}/o/${n.tenant_id}/billing`,
            html: `<p>${escapeHtml(n.message)}</p><p><a href="${config.appBaseUrl}/o/${n.tenant_id}/billing">Billing and usage</a></p>` });
          ok++;
        } catch (e) { logEvent('warn', 'commercial.notice_email_failed', { tenantId: n.tenant_id, message: (e as Error).message }); }
      }
      await c.query(`UPDATE usage_notices SET email_status = $2, emailed_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END WHERE id = $1`, [n.id, ok > 0 ? 'sent' : 'failed']);
      if (ok) r.noticesEmailed++;
    });
  }
  return r;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
