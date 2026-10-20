import { createHash, randomUUID } from 'node:crypto';
import { Controller, HttpCode, Inject, Injectable, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppError, notFound } from '../common/errors';
import { RateLimit, RateLimitGuard } from '../common/rate-limit';
import type { AppRequest } from '../common/request';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { BILLING_PROVIDER, WebhookRejected, type BillingEvent, type BillingProvider } from './billing-provider';
import { lockSubscription, nextStatus, transition, type Actor, type SubscriptionRow } from './lifecycle';
import { assignPlan, changePlanNow, versionById } from './subscriptions';

const SYS = '00000000-0000-0000-0000-000000000000';
const PROVIDER_ACTOR: Actor = { type: 'billing_provider' };

export type WebhookOutcome = { status: 'processed' | 'ignored' | 'duplicate' | 'failed'; detail?: string };

/**
 * Verified, idempotent, replay-safe processing of billing-provider events:
 *  1. the adapter verifies the signature and timestamp; unverified requests are logged (without payload) and rejected;
 *  2. the event id is unique per provider, so a replayed or redelivered event is acknowledged without effect;
 *  3. state changes happen only here, never from a browser redirect or the checkout return page.
 */
@Injectable()
export class BillingWebhookService {
  constructor(private readonly db: Database, private readonly audit: AuditService, @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider) {}

  async receive(providerName: string, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
    if (providerName !== this.provider.name || !this.provider.configured) throw notFound('Webhook endpoint');
    if (!raw?.length) throw new AppError(400, 'webhook_rejected', 'Empty body');
    let ev: BillingEvent;
    try { ev = this.provider.verifyWebhook(raw, headers); } catch (e) {
      const reason = e instanceof WebhookRejected ? e.reason : 'verification error';
      await this.db.withSystem((c) => c.query(`INSERT INTO billing_webhook_events (provider, event_id, event_type, signature_valid, status, error, payload)
        VALUES ($1,$2,'unverified',false,'rejected',$3,NULL)`, [providerName, `rejected:${randomUUID()}`, `${reason} (body sha256 ${createHash('sha256').update(raw).digest('hex').slice(0, 16)})`]));
      logEvent('warn', 'billing.webhook_rejected', { provider: providerName, reason });
      throw new AppError(400, 'webhook_rejected', 'Webhook verification failed');
    }
    // Claim the event id. A processed/ignored event is a replay; a failed one may be retried by the provider.
    const claim = await this.db.withSystem(async (c) => {
      const ins = await c.query(`INSERT INTO billing_webhook_events (provider, event_id, event_type, signature_valid, status, payload)
        VALUES ($1,$2,$3,true,'received',$4) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`, [providerName, ev.id, ev.type, JSON.parse(raw.toString('utf8'))]);
      if (ins.rowCount) return { id: ins.rows[0].id as string, replay: false };
      const prev = (await c.query(`SELECT id, status FROM billing_webhook_events WHERE provider = $1 AND event_id = $2 FOR UPDATE`, [providerName, ev.id])).rows[0];
      if (prev.status === 'failed' || prev.status === 'received') {
        await c.query(`UPDATE billing_webhook_events SET status = 'received', error = NULL WHERE id = $1`, [prev.id]);
        return { id: prev.id as string, replay: false };
      }
      return { id: prev.id as string, replay: true };
    });
    if (claim.replay) return { status: 'duplicate' };
    try {
      const r = await this.apply(ev);
      await this.db.withSystem((c) => c.query(`UPDATE billing_webhook_events SET status = $2, error = $3, tenant_id = $4, processed_at = now() WHERE id = $1`,
        [claim.id, r.status, r.detail ?? null, r.tenantId ?? null]));
      return { status: r.status, detail: r.detail };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await this.db.withSystem((c) => c.query(`UPDATE billing_webhook_events SET status = 'failed', error = $2, processed_at = now() WHERE id = $1`, [claim.id, msg]));
      logEvent('error', 'billing.webhook_failed', { provider: providerName, eventId: ev.id, type: ev.type, message: msg });
      throw new AppError(500, 'webhook_failed', 'Event could not be processed; it can be redelivered');
    }
  }

  /**
   * Organization owning a provider subscription reference. An unknown reference is a retryable failure, not "ignored":
   * events can arrive before the event that creates the reference, and an ignored event would never be redelivered.
   */
  private async tenantBySubscriptionRef(ref: string): Promise<string> {
    const t = await this.db.withSystem(async (c) => (await c.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM subscriptions WHERE billing_provider = $1 AND billing_reference = $2 ORDER BY created_at DESC LIMIT 1', [this.provider.name, ref])).rows[0]?.tenant_id ?? null);
    if (!t) throw new Error('unknown provider subscription reference (not yet recorded); retry later');
    return t;
  }

  private async apply(ev: BillingEvent): Promise<WebhookOutcome & { tenantId?: string; status: 'processed' | 'ignored' }> {
    switch (ev.type) {
      case 'checkout.completed': {
        // Sessions are recorded before the provider is called and do not depend on a live subscription, so an expired or
        // canceled organization can be reactivated by paying. Unknown sessions are retryable (the record may still be committing).
        const started = await this.db.withSystem(async (c) => (await c.query<{ id: string; tenant_id: string; plan_version_id: string }>(
          `SELECT id, tenant_id, plan_version_id FROM checkout_sessions WHERE provider = $1 AND session_ref = $2`, [this.provider.name, ev.sessionRef])).rows[0]);
        if (!started) throw new Error('unknown checkout session (not yet recorded); retry later');
        return this.db.withTenant(started.tenant_id, SYS, async (c) => {
          await c.query(`UPDATE checkout_sessions SET status = 'completed', completed_at = coalesce(completed_at, now()) WHERE id = $1`, [started.id]);
          const sub = await lockSubscription(c, started.tenant_id);
          if (sub?.billing_reference === ev.subscriptionRef && sub.plan_version_id === started.plan_version_id) return { status: 'ignored' as const, detail: 'already applied', tenantId: started.tenant_id };
          const pv = await versionById(c, started.plan_version_id);
          if (!pv) return { status: 'ignored' as const, detail: 'plan version missing', tenantId: started.tenant_id };
          let s: SubscriptionRow;
          if (!sub) {
            s = await assignPlan(c, started.tenant_id, { planVersionId: pv.id, billingMode: 'self_service', status: 'active', periodStart: ev.periodStart, periodEnd: ev.periodEnd, resetUsageAnchor: true }, PROVIDER_ACTOR);
          } else if (nextStatus(sub.status, 'activate')) {
            s = await transition(c, sub, 'activate', PROVIDER_ACTOR, { plan_version_id: pv.id, plan_code: pv.code, current_period_start: ev.periodStart, current_period_end: ev.periodEnd, usage_anchor: ev.periodStart }, { checkout: ev.sessionRef });
          } else {
            s = await changePlanNow(c, sub, pv.id, PROVIDER_ACTOR);
          }
          await c.query(`UPDATE subscriptions SET billing_provider = $2, billing_reference = $3, provider_customer_ref = $4, billing_mode = 'self_service', contract_id = NULL WHERE id = $1`,
            [s.id, this.provider.name, ev.subscriptionRef, ev.customerRef]);
          await this.audit.record(c, { tenantId: started.tenant_id, actorUserId: null, action: 'commercial.checkout_completed', targetType: 'subscription', targetId: s.id, metadata: { plan: pv.code, provider: this.provider.name } });
          return { status: 'processed' as const, tenantId: started.tenant_id };
        });
      }
      case 'invoice.paid': case 'invoice.payment_failed': {
        const tenantId = await this.tenantBySubscriptionRef(ev.subscriptionRef);
        return this.db.withTenant(tenantId, SYS, async (c) => {
          const cur = await lockSubscription(c, tenantId);
          // Only the organization's *current* subscription is changed, and only when it is the one this provider
          // reference belongs to; events for an ended provider subscription are mirrored but change nothing.
          const sub = cur && cur.billing_provider === this.provider.name && cur.billing_reference === ev.subscriptionRef ? cur : null;
          const paid = ev.type === 'invoice.paid';
          // A paid invoice is never downgraded by a late failure event; a paid event also sets the final amount.
          let inv = (await c.query<{ id: string; status: string }>(`INSERT INTO invoices (tenant_id, subscription_id, number, source, provider, provider_invoice_ref, status, currency, subtotal, total, amount_paid, issued_at, paid_at, period_start, period_end)
            VALUES ($1,$2,$3,'provider',$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (provider, provider_invoice_ref) WHERE provider_invoice_ref IS NOT NULL
              DO UPDATE SET status = EXCLUDED.status, amount_paid = EXCLUDED.amount_paid, paid_at = EXCLUDED.paid_at,
                subtotal = CASE WHEN EXCLUDED.status = 'paid' THEN EXCLUDED.subtotal ELSE invoices.subtotal END,
                total = CASE WHEN EXCLUDED.status = 'paid' THEN EXCLUDED.total ELSE invoices.total END
              WHERE invoices.status <> 'paid' RETURNING id, status`,
            [tenantId, sub?.id ?? null, `${this.provider.name}:${ev.invoiceRef}`, this.provider.name, ev.invoiceRef, paid ? 'paid' : 'overdue', ev.currency, ev.amount,
              paid ? ev.amount : 0, ev.occurredAt, paid ? ev.occurredAt : null,
              paid ? ev.periodStart.toISOString().slice(0, 10) : null, paid ? ev.periodEnd.toISOString().slice(0, 10) : null])).rows[0];
          const alreadyPaid = !inv;
          inv ??= (await c.query<{ id: string; status: string }>('SELECT id, status FROM invoices WHERE provider = $1 AND provider_invoice_ref = $2', [this.provider.name, ev.invoiceRef])).rows[0]!;
          if (paid && ev.amount > 0 && !alreadyPaid) {
            await c.query(`INSERT INTO payments (tenant_id, invoice_id, amount, currency, method, reference, received_at, source) VALUES ($1,$2,$3,$4,'provider',$5,$6,'provider_webhook')
              ON CONFLICT (invoice_id, reference) DO NOTHING`, [tenantId, inv.id, ev.amount, ev.currency, ev.paymentRef, ev.occurredAt]);
          }
          if (sub && paid && !alreadyPaid) {
            // Periods only move forward (a late event for an older period does not rewind the subscription).
            await c.query('UPDATE subscriptions SET current_period_start = $2, current_period_end = $3 WHERE id = $1 AND (current_period_end IS NULL OR current_period_end < $3)', [sub.id, ev.periodStart, ev.periodEnd]);
            const fresh = (await lockSubscription(c, tenantId))!;
            // A payment lifts a suspension only when non-payment caused it, never an operator or abuse suspension.
            const recoverable = fresh.status === 'past_due' || (fresh.status === 'suspended' && fresh.suspended_reason === 'past_due_grace_elapsed');
            if (recoverable) await transition(c, fresh, 'payment_recovered', PROVIDER_ACTOR, {}, { invoice: ev.invoiceRef });
            else if (fresh.status === 'pending_renewal') await transition(c, fresh, 'renew', PROVIDER_ACTOR, {}, { invoice: ev.invoiceRef });
          } else if (sub && !paid && !alreadyPaid && nextStatus(sub.status, 'payment_failed')) {
            await transition(c, sub, 'payment_failed', PROVIDER_ACTOR, {}, { invoice: ev.invoiceRef });
          }
          if (alreadyPaid) return { status: 'ignored' as const, detail: 'invoice already paid', tenantId };
          await this.audit.record(c, { tenantId, actorUserId: null, action: paid ? 'commercial.provider_invoice_paid' : 'commercial.provider_payment_failed', targetType: 'invoice', targetId: inv.id,
            metadata: { amount: ev.amount, currency: ev.currency } });
          return { status: 'processed' as const, tenantId };
        });
      }
      case 'subscription.canceled': {
        const tenantId = await this.tenantBySubscriptionRef(ev.subscriptionRef);
        return this.db.withTenant(tenantId, SYS, async (c) => {
          const sub = await lockSubscription(c, tenantId);
          if (!sub || sub.billing_reference !== ev.subscriptionRef || !nextStatus(sub.status, 'cancel_now')) return { status: 'ignored' as const, detail: 'not applicable', tenantId };
          await transition(c, sub, 'cancel_now', PROVIDER_ACTOR);
          await this.audit.record(c, { tenantId, actorUserId: null, action: 'commercial.provider_subscription_canceled', targetType: 'subscription', targetId: sub.id });
          return { status: 'processed' as const, tenantId };
        });
      }
      case 'refund.created': {
        const t = await this.db.withSystem(async (c) => (await c.query<{ tenant_id: string; id: string }>(
          'SELECT tenant_id, id FROM invoices WHERE provider = $1 AND provider_invoice_ref = $2', [this.provider.name, ev.invoiceRef])).rows[0]);
        if (!t) return { status: 'ignored', detail: 'unknown invoice' };
        await this.db.withTenant(t.tenant_id, SYS, (c) => this.audit.record(c, { tenantId: t.tenant_id, actorUserId: null, action: 'commercial.provider_refund', targetType: 'invoice', targetId: t.id,
          metadata: { amount: ev.amount, currency: ev.currency, payment: ev.paymentRef } }));
        return { status: 'processed', tenantId: t.tenant_id, detail: 'refund recorded in the audit log' };
      }
      default:
        return { status: 'ignored', detail: `unsupported event type ${ev.providerType}` };
    }
  }
}

/** Public endpoint for provider callbacks: no session, no CSRF origin (server-to-server), verified by signature only. */
@ApiExcludeController()
@Controller('billing/webhooks')
@UseGuards(RateLimitGuard)
export class BillingWebhookController {
  constructor(private readonly svc: BillingWebhookService) {}

  @Post(':provider') @HttpCode(200) @RateLimit({ limit: 300, windowSeconds: 60 })
  async receive(@Param('provider') provider: string, @Req() req: RawBodyRequest<AppRequest>) {
    if (!/^[a-z]{2,20}$/.test(provider)) throw notFound('Webhook endpoint');
    const r = await this.svc.receive(provider, req.rawBody, req.headers);
    return { received: true, status: r.status };
  }
}
