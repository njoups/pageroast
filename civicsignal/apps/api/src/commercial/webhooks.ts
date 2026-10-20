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

  private async tenantBySubscriptionRef(ref: string) {
    return this.db.withSystem(async (c) => (await c.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM subscriptions WHERE billing_provider = $1 AND billing_reference = $2 ORDER BY created_at DESC LIMIT 1', [this.provider.name, ref])).rows[0]?.tenant_id ?? null);
  }

  private async apply(ev: BillingEvent): Promise<WebhookOutcome & { tenantId?: string; status: 'processed' | 'ignored' }> {
    switch (ev.type) {
      case 'checkout.completed': {
        const started = await this.db.withSystem(async (c) => (await c.query<{ tenant_id: string; metadata: { planVersionId: string } }>(
          `SELECT tenant_id, metadata FROM subscription_events WHERE event = 'checkout_started' AND metadata->>'provider' = $1 AND metadata->>'sessionRef' = $2 LIMIT 1`,
          [this.provider.name, ev.sessionRef])).rows[0]);
        if (!started) return { status: 'ignored', detail: 'unknown checkout session' };
        return this.db.withTenant(started.tenant_id, SYS, async (c) => {
          const sub = await lockSubscription(c, started.tenant_id);
          if (sub?.billing_reference === ev.subscriptionRef && sub.plan_version_id === started.metadata.planVersionId) return { status: 'ignored' as const, detail: 'already applied', tenantId: started.tenant_id };
          const pv = await versionById(c, started.metadata.planVersionId);
          if (!pv) return { status: 'ignored' as const, detail: 'plan version missing', tenantId: started.tenant_id };
          let s: SubscriptionRow;
          if (!sub) {
            s = await assignPlan(c, started.tenant_id, { planVersionId: pv.id, billingMode: 'self_service', status: 'active', periodStart: ev.periodStart, periodEnd: ev.periodEnd, resetUsageAnchor: true }, PROVIDER_ACTOR);
          } else if (nextStatus(sub.status, 'activate')) {
            s = await transition(c, sub, 'activate', PROVIDER_ACTOR, { plan_version_id: pv.id, plan_code: pv.code, current_period_start: ev.periodStart, current_period_end: ev.periodEnd, usage_anchor: ev.periodStart }, { checkout: ev.sessionRef });
          } else {
            s = await changePlanNow(c, sub, pv.id, PROVIDER_ACTOR);
          }
          await c.query(`UPDATE subscriptions SET billing_provider = $2, billing_reference = $3, provider_customer_ref = $4, billing_mode = 'self_service' WHERE id = $1`,
            [s.id, this.provider.name, ev.subscriptionRef, ev.customerRef]);
          await this.audit.record(c, { tenantId: started.tenant_id, actorUserId: null, action: 'commercial.checkout_completed', targetType: 'subscription', targetId: s.id, metadata: { plan: pv.code, provider: this.provider.name } });
          return { status: 'processed' as const, tenantId: started.tenant_id };
        });
      }
      case 'invoice.paid': case 'invoice.payment_failed': {
        const tenantId = await this.tenantBySubscriptionRef(ev.subscriptionRef);
        if (!tenantId) return { status: 'ignored', detail: 'unknown subscription' };
        return this.db.withTenant(tenantId, SYS, async (c) => {
          const sub = await lockSubscription(c, tenantId);
          const paid = ev.type === 'invoice.paid';
          const inv = (await c.query(`INSERT INTO invoices (tenant_id, subscription_id, number, source, provider, provider_invoice_ref, status, currency, subtotal, total, amount_paid, issued_at, paid_at, period_start, period_end)
            VALUES ($1,$2,$3,'provider',$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (provider, provider_invoice_ref) WHERE provider_invoice_ref IS NOT NULL
              DO UPDATE SET status = EXCLUDED.status, amount_paid = EXCLUDED.amount_paid, paid_at = EXCLUDED.paid_at RETURNING id`,
            [tenantId, sub?.id ?? null, `${this.provider.name}:${ev.invoiceRef}`, this.provider.name, ev.invoiceRef, paid ? 'paid' : 'overdue', ev.currency, ev.amount,
              paid ? ev.amount : 0, ev.occurredAt, paid ? ev.occurredAt : null,
              paid ? ev.periodStart.toISOString().slice(0, 10) : null, paid ? ev.periodEnd.toISOString().slice(0, 10) : null])).rows[0];
          if (paid && ev.amount > 0) {
            await c.query(`INSERT INTO payments (tenant_id, invoice_id, amount, currency, method, reference, received_at, source) VALUES ($1,$2,$3,$4,'provider',$5,$6,'provider_webhook')
              ON CONFLICT (invoice_id, reference) DO NOTHING`, [tenantId, inv.id, ev.amount, ev.currency, ev.paymentRef, ev.occurredAt]);
          }
          if (sub && paid) {
            await c.query('UPDATE subscriptions SET current_period_start = $2, current_period_end = $3 WHERE id = $1', [sub.id, ev.periodStart, ev.periodEnd]);
            const fresh = (await lockSubscription(c, tenantId))!;
            if (nextStatus(fresh.status, 'payment_recovered')) await transition(c, fresh, 'payment_recovered', PROVIDER_ACTOR, {}, { invoice: ev.invoiceRef });
            else if (fresh.status === 'pending_renewal') await transition(c, fresh, 'renew', PROVIDER_ACTOR, {}, { invoice: ev.invoiceRef });
          } else if (sub && !paid && nextStatus(sub.status, 'payment_failed')) {
            await transition(c, sub, 'payment_failed', PROVIDER_ACTOR, {}, { invoice: ev.invoiceRef });
          }
          await this.audit.record(c, { tenantId, actorUserId: null, action: paid ? 'commercial.provider_invoice_paid' : 'commercial.provider_payment_failed', targetType: 'invoice', targetId: inv.id,
            metadata: { amount: ev.amount, currency: ev.currency } });
          return { status: 'processed' as const, tenantId };
        });
      }
      case 'subscription.canceled': {
        const tenantId = await this.tenantBySubscriptionRef(ev.subscriptionRef);
        if (!tenantId) return { status: 'ignored', detail: 'unknown subscription' };
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
