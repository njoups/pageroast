import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { RequirePermission, TenantGuard } from '../authz/guards';
import { AppConfig, CONFIG } from '../config';
import { AppError, badRequest, conflict, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta, Tenant, TenantContext } from '../common/request';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { EmailChannel } from '../alerts/channels/email';
import { BILLING_PROVIDER, type BillingProvider } from './billing-provider';
import { FEATURES, METRICS, isMetric } from './catalog';
import { invoiceDetail, invoiceOut, INVOICE_NOTICE } from './invoices';
import { allowedEvents, lockSubscription, recordEvent } from './lifecycle';
import { onboardingState, setStep, STEPS, type Step } from './onboarding';
import { loadEntitlements, usageSummary } from './quota';
import { currentVersion, setCancelAtPeriodEnd } from './subscriptions';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw badRequest('validation_failed', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
};

const CheckoutSchema = z.object({ planCode: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) }).strict();
const SalesSchema = z.object({
  kind: z.enum(['quote', 'plan_change', 'contract', 'other']), planCode: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
  message: z.string().trim().min(1).max(4000), contactPhone: z.string().max(50).optional(),
}).strict();
const StepSchema = z.object({ status: z.enum(['done', 'skipped', 'todo']) }).strict();

export const planOut = (p: Record<string, any>) => ({
  code: p.code, name: p.name, category: p.category, description: p.description, versionId: p.id, version: p.version,
  price: p.price_amount === null ? null : { amount: Number(p.price_amount), currency: p.currency, interval: p.billing_interval },
  priceStatus: p.price_amount === null ? 'contact_sales' : 'listed', billingInterval: p.billing_interval, trialDays: p.trial_days,
  features: Object.fromEntries(Object.keys(FEATURES).map((k) => [k, p.features?.[k] === true && k !== 'api_access'])),
  quotas: Object.fromEntries(Object.entries(p.quotas ?? {}).map(([k, v]) => [k, v])), settings: p.settings, effectiveFrom: p.effective_from,
});

@Injectable()
export class BillingService {
  constructor(private readonly db: Database, private readonly audit: AuditService, @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider) {}

  private providerStatus() {
    return { name: this.provider.name, configured: this.provider.configured, live: this.provider.live,
      onlinePayments: this.provider.configured ? (this.provider.live ? 'available' : 'test_mode') : 'not_configured' };
  }

  /** What every member may know: plan name, access level and included features (used to explain disabled actions). */
  entitlements(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const e = await loadEntitlements(c, t.orgId);
      return { plan: e.subscription ? { code: e.subscription.planCode, name: e.subscription.planName } : null, status: e.subscription?.status ?? 'none', access: e.access, features: e.features };
    });
  }

  overview(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const e = await loadEntitlements(c, t.orgId);
      const sub = e.subscription ? (await c.query('SELECT * FROM subscriptions WHERE id = $1', [e.subscription.id])).rows[0] : null;
      const scheduled = sub?.scheduled_plan_version_id ? (await c.query(`SELECT p.code, p.name FROM plan_versions pv JOIN plans p ON p.id = pv.plan_id WHERE pv.id = $1`, [sub.scheduled_plan_version_id])).rows[0] : null;
      const pv = e.subscription ? (await c.query(`SELECT pv.*, p.code, p.name, p.category, p.description FROM plan_versions pv JOIN plans p ON p.id = pv.plan_id WHERE pv.id = $1`, [e.subscription.planVersionId])).rows[0] : null;
      const contract = sub?.contract_id ? (await c.query(`SELECT contract_reference, po_reference, start_date, end_date, billing_frequency, payment_terms_days, renewal_date, status, contact_name, contact_email
        FROM contracts WHERE id = $1`, [sub.contract_id])).rows[0] : null;
      const notices = (await c.query(`SELECT id, metric, threshold, used, quota_limit, message, created_at, acknowledged_at FROM usage_notices WHERE period_start = $1 ORDER BY created_at DESC LIMIT 50`,
        [e.period.start])).rows;
      const openInvoices = (await c.query(`SELECT count(*)::int AS n, coalesce(sum(total - amount_paid), 0) AS balance, min(currency) AS currency, count(DISTINCT currency)::int AS currencies
        FROM invoices WHERE status IN ('issued','partially_paid','overdue')`)).rows[0];
      const selfService = sub?.billing_mode === 'self_service';
      return {
        organizationId: t.orgId,
        subscription: e.subscription && sub ? {
          status: sub.status, access: e.access, billingMode: sub.billing_mode, trialEndsAt: sub.trial_ends_at,
          currentPeriodStart: sub.current_period_start, currentPeriodEnd: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end, canceledAt: sub.canceled_at,
          pastDueSince: sub.past_due_since, suspendedReason: sub.suspended_reason, scheduledChange: scheduled ? { plan: scheduled, at: sub.scheduled_change_at } : null,
          paymentMethodOnFile: !!sub.provider_customer_ref, provider: sub.billing_provider,
        } : null,
        plan: pv ? planOut(pv) : null,
        usagePeriod: { start: e.period.start, end: e.period.end, timezone: e.timezone },
        usage: await usageSummary(c, e),
        notices: notices.map((n) => ({ id: n.id, metric: n.metric, threshold: n.threshold, used: Number(n.used), limit: Number(n.quota_limit), message: n.message, createdAt: n.created_at, acknowledgedAt: n.acknowledged_at })),
        invoices: { open: openInvoices.n, balance: openInvoices.currencies === 1 ? { amount: Number(openInvoices.balance), currency: openInvoices.currency } : null },
        contract,
        payments: this.providerStatus(),
        actions: {
          checkout: this.provider.configured && (!sub || selfService || sub.status === 'trialing'),
          cancelAtPeriodEnd: !!sub && !sub.cancel_at_period_end && (selfService || sub.status === 'trialing') && ['trialing', 'active', 'past_due'].includes(sub.status),
          resume: !!sub && sub.cancel_at_period_end && !['canceled', 'expired'].includes(sub.status),
          portal: this.provider.configured && !!sub?.provider_customer_ref,
          contactSales: true,
        },
        notice: INVOICE_NOTICE,
      };
    });
  }

  plans(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const rows = (await c.query(`SELECT DISTINCT ON (p.id) pv.*, p.code, p.name, p.category, p.description, p.sort_order FROM plans p JOIN plan_versions pv ON pv.plan_id = p.id
        WHERE p.is_public AND p.is_active AND pv.effective_from <= now() AND (pv.effective_to IS NULL OR pv.effective_to > now())
        ORDER BY p.id, pv.effective_from DESC, pv.version DESC`)).rows.sort((a, b) => a.sort_order - b.sort_order);
      return { plans: rows.map(planOut), metrics: Object.entries(METRICS).map(([key, m]) => ({ key, ...m })), features: Object.entries(FEATURES).map(([key, description]) => ({ key, description })),
        payments: this.providerStatus() };
    });
  }

  history(auth: AuthContext, t: TenantContext, periods: number) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const rows = (await c.query(`SELECT period_start, period_end, metric, quantity FROM usage_period_totals
        WHERE period_start IN (SELECT DISTINCT period_start FROM usage_period_totals ORDER BY period_start DESC LIMIT $1) ORDER BY period_start DESC, metric`, [periods])).rows;
      const by = new Map<string, { start: Date; end: Date; usage: Record<string, number> }>();
      for (const r of rows) {
        const k = r.period_start.toISOString();
        if (!by.has(k)) by.set(k, { start: r.period_start, end: r.period_end, usage: {} });
        by.get(k)!.usage[r.metric] = Number(r.quantity);
      }
      return { periods: [...by.values()] };
    });
  }

  daily(auth: AuthContext, t: TenantContext, metric: string, days: number) {
    if (!isMetric(metric) || METRICS[metric].kind !== 'counter') throw badRequest('validation_failed', 'metric must be a counter metric');
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({
      metric, days: (await c.query(`SELECT day, quantity, events FROM usage_daily WHERE metric = $1 AND day > current_date - $2::int ORDER BY day`, [metric, days])).rows
        .map((r) => ({ day: r.day, quantity: Number(r.quantity), events: r.events })),
    }));
  }

  invoices(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({
      invoices: (await c.query(`SELECT * FROM invoices WHERE status <> 'draft' ORDER BY coalesce(issued_at, created_at) DESC LIMIT 200`)).rows.map(invoiceOut), notice: INVOICE_NOTICE,
    }));
  }

  invoice(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const inv = await invoiceDetail(c, t.orgId, id);
      if (inv.status === 'draft') throw notFound('Invoice');            // drafts are internal to the operator
      return inv;
    });
  }

  events(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({
      events: (await c.query(`SELECT e.event, e.from_status, e.to_status, e.actor_type, e.reason, e.created_at, fp.code AS from_plan, tp.code AS to_plan
        FROM subscription_events e LEFT JOIN plan_versions fv ON fv.id = e.from_plan_version_id LEFT JOIN plans fp ON fp.id = fv.plan_id
        LEFT JOIN plan_versions tv ON tv.id = e.to_plan_version_id LEFT JOIN plans tp ON tp.id = tv.plan_id ORDER BY e.created_at DESC LIMIT 100`)).rows,
    }));
  }

  /**
   * Starts a hosted checkout. The subscription changes only when the provider's signed checkout event arrives
   * (webhooks.ts); the browser returning from checkout proves nothing.
   */
  async checkout(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(CheckoutSchema, body);
    if (!this.provider.configured) throw new AppError(503, 'billing_provider_not_configured', 'Online payment is not available: no payment provider is configured. Use "Contact sales" for a quote or invoice billing.');
    const prep = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const pv = await currentVersion(c, dto.planCode);
      if (!pv || !pv.is_active || !pv.is_public) throw notFound('Plan');
      if (pv.price_amount === null || !pv.currency) throw conflict('contact_sales', 'This plan has no list price; request a quote from sales');
      const sub = await lockSubscription(c, t.orgId);
      if (sub && sub.billing_mode !== 'self_service' && sub.status !== 'trialing') throw conflict('contract_billing', 'This organization is billed by contract; plan changes go through sales');
      if (sub?.plan_version_id === pv.id && sub.status === 'active') throw conflict('already_on_plan', 'The organization is already on this plan');
      return { pv, sub };
    });
    const session = await this.provider.createCheckout({ tenantId: t.orgId, planVersionId: prep.pv.id, planCode: prep.pv.code, amount: Number(prep.pv.price_amount), currency: prep.pv.currency!,
      interval: prep.pv.billing_interval, customerRef: prep.sub?.provider_customer_ref ?? null, returnUrl: `${this.config.appBaseUrl}/o/${t.orgId}/billing?checkout=returned` });
    await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const sub = await lockSubscription(c, t.orgId);
      if (sub) await recordEvent(c, sub, { event: 'checkout_started', from: sub.status, to: sub.status, toPlan: prep.pv.id, actor: { type: 'user', userId: auth.userId },
        metadata: { provider: this.provider.name, sessionRef: session.sessionRef, planVersionId: prep.pv.id } });
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'commercial.checkout_started', targetType: 'plan', targetId: prep.pv.code, metadata: { provider: this.provider.name }, meta });
    });
    return { url: session.url, expiresAt: session.expiresAt, note: 'Your plan changes once the payment provider confirms the payment. Returning from the checkout page does not change it.' };
  }

  async cancel(auth: AuthContext, t: TenantContext, value: boolean, meta: RequestMeta) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const sub = await lockSubscription(c, t.orgId);
      if (!sub) throw notFound('Subscription');
      if (sub.billing_mode !== 'self_service' && sub.status !== 'trialing') throw conflict('contract_billing', 'Contract subscriptions are canceled or not renewed through your account manager');
      if (value && !['trialing', 'active', 'past_due'].includes(sub.status)) throw conflict('invalid_transition', `A ${sub.status} subscription cannot be canceled`);
      // Provider first: if it refuses, nothing changes here.
      if (sub.billing_reference && sub.billing_provider) {
        if (sub.billing_provider !== this.provider.name) throw new AppError(503, 'billing_provider_not_configured', 'The payment provider of this subscription is not configured');
        if (value) await this.provider.cancelSubscription(sub.billing_reference, true); else await this.provider.resumeSubscription(sub.billing_reference);
      }
      const s = await setCancelAtPeriodEnd(c, sub, value, { type: 'user', userId: auth.userId });
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: value ? 'commercial.cancel_scheduled' : 'commercial.cancel_withdrawn', targetType: 'subscription', targetId: sub.id, meta });
      return { status: s.status, cancelAtPeriodEnd: s.cancel_at_period_end, endsAt: s.status === 'trialing' ? s.trial_ends_at : s.current_period_end };
    });
  }

  async portal(auth: AuthContext, t: TenantContext) {
    const sub = await this.db.withTenant(t.orgId, auth.userId, (c) => lockSubscription(c, t.orgId));
    if (!this.provider.configured) throw new AppError(503, 'billing_provider_not_configured', 'No payment provider is configured');
    if (!sub?.provider_customer_ref) throw conflict('no_billing_account', 'There is no payment-provider account for this organization');
    return this.provider.createPortalSession(sub.provider_customer_ref, `${this.config.appBaseUrl}/o/${t.orgId}/billing`);
  }

  async salesRequest(auth: AuthContext, t: TenantContext, body: unknown, meta: RequestMeta) {
    const dto = parse(SalesSchema, body);
    const r = await this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const open = (await c.query(`SELECT count(*)::int AS n FROM sales_requests WHERE status = 'open' AND created_at > now() - interval '1 day'`)).rows[0].n;
      if (open >= 10) throw new AppError(429, 'rate_limited', 'Too many open requests today; our team will contact you');
      const row = (await c.query(`INSERT INTO sales_requests (tenant_id, requested_by, kind, plan_code, message, contact_phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, plan_code, status, created_at`,
        [t.orgId, auth.userId, dto.kind, dto.planCode ?? null, dto.message, dto.contactPhone ?? null])).rows[0];
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'commercial.sales_request_created', targetType: 'sales_request', targetId: row.id, metadata: { kind: dto.kind, plan: dto.planCode ?? null }, meta });
      const org = (await c.query('SELECT name FROM tenants WHERE id = $1', [t.orgId])).rows[0];
      return { row, org: org.name as string };
    });
    let emailed = false;
    const email = new EmailChannel(this.config.email);
    if (this.config.billing.salesEmail && email.configured) {
      try {
        await email.send({ to: this.config.billing.salesEmail, subject: `Sales request (${dto.kind}) from ${r.org}`,
          text: `Organization: ${r.org} (${t.orgId})\nFrom: ${auth.email}\nKind: ${dto.kind}\nPlan: ${dto.planCode ?? '-'}\nPhone: ${dto.contactPhone ?? '-'}\n\n${dto.message}`,
          html: `<p>Organization: ${esc(r.org)} (${t.orgId})<br>From: ${esc(auth.email)}<br>Kind: ${dto.kind}<br>Plan: ${esc(dto.planCode ?? '-')}<br>Phone: ${esc(dto.contactPhone ?? '-')}</p><p>${esc(dto.message)}</p>` });
        emailed = true;
      } catch (e) { logEvent('warn', 'billing.sales_email_failed', { tenantId: t.orgId, message: (e as Error).message }); }
    }
    return { ...r.row, delivery: emailed ? 'emailed' : 'stored', note: emailed ? 'Our team has been notified.' : 'Your request is stored and visible to our team in the operator console.' };
  }

  salesRequests(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => ({
      requests: (await c.query('SELECT id, kind, plan_code, message, status, handled_note, created_at, updated_at FROM sales_requests ORDER BY created_at DESC LIMIT 50')).rows,
    }));
  }

  acknowledge(auth: AuthContext, t: TenantContext, id: string) {
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await c.query('UPDATE usage_notices SET acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $2) WHERE id = $1 RETURNING id', [id, auth.userId]);
      if (!r.rowCount) throw notFound('Notice');
    });
  }

  onboarding(auth: AuthContext, t: TenantContext) {
    return this.db.withTenant(t.orgId, auth.userId, (c) => onboardingState(c, t.orgId));
  }

  setStep(auth: AuthContext, t: TenantContext, step: string, body: unknown, meta: RequestMeta) {
    if (!(STEPS as readonly string[]).includes(step)) throw notFound('Onboarding step');
    const dto = parse(StepSchema, body);
    return this.db.withTenant(t.orgId, auth.userId, async (c) => {
      const r = await setStep(c, t.orgId, step as Step, dto.status, auth.userId);
      if ('error' in r) throw conflict(r.error!, r.error === 'not_skippable' ? 'This step cannot be skipped' : 'This step completes itself when the corresponding setup exists');
      await this.audit.record(c, { tenantId: t.orgId, actorUserId: auth.userId, action: 'onboarding.step_updated', targetType: 'onboarding', targetId: step, metadata: { status: dto.status }, meta });
      return r.state;
    });
  }

  allowed(sub: { status: string }) { return allowedEvents(sub.status as never); }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

@ApiTags('billing')
@Controller('organizations/:orgId')
@UseGuards(SessionGuard, TenantGuard)
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get('entitlements') @RequirePermission('org:read')
  entitlements(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.entitlements(a, t); }

  @Get('billing') @RequirePermission('billing:read')
  overview(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.overview(a, t); }

  @Get('billing/plans') @RequirePermission('billing:read')
  plans(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.plans(a, t); }

  @Get('billing/usage/history') @RequirePermission('billing:read')
  history(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query('periods') periods?: string) {
    return this.svc.history(a, t, Math.min(Math.max(Number(periods) || 6, 1), 24));
  }

  @Get('billing/usage/daily') @RequirePermission('billing:read')
  daily(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Query('metric') metric: string, @Query('days') days?: string) {
    return this.svc.daily(a, t, String(metric ?? ''), Math.min(Math.max(Number(days) || 30, 1), 400));
  }

  @Get('billing/invoices') @RequirePermission('billing:read')
  invoices(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.invoices(a, t); }

  @Get('billing/invoices/:id') @RequirePermission('billing:read')
  invoice(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.invoice(a, t, id); }

  @Get('billing/events') @RequirePermission('billing:read')
  events(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.events(a, t); }

  @Post('billing/checkout') @HttpCode(200) @RequirePermission('billing:manage')
  checkout(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) { return this.svc.checkout(a, t, body, m); }

  @Post('billing/cancel') @HttpCode(200) @RequirePermission('billing:manage')
  cancel(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Meta() m: RequestMeta) { return this.svc.cancel(a, t, true, m); }

  @Post('billing/resume') @HttpCode(200) @RequirePermission('billing:manage')
  resume(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Meta() m: RequestMeta) { return this.svc.cancel(a, t, false, m); }

  @Post('billing/portal') @HttpCode(200) @RequirePermission('billing:manage')
  portal(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.portal(a, t); }

  @Get('billing/sales-requests') @RequirePermission('billing:read')
  salesRequests(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.salesRequests(a, t); }

  @Post('billing/sales-requests') @RequirePermission('billing:read')
  salesRequest(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) { return this.svc.salesRequest(a, t, body, m); }

  @Post('billing/notices/:id/acknowledge') @HttpCode(204) @RequirePermission('billing:read')
  acknowledge(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.acknowledge(a, t, id); }

  @Get('onboarding') @RequirePermission('org:read')
  onboarding(@Auth() a: AuthContext, @Tenant() t: TenantContext) { return this.svc.onboarding(a, t); }

  @Put('onboarding/steps/:step') @RequirePermission('org:update')
  setStep(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('step') step: string, @Body() body: unknown, @Meta() m: RequestMeta) { return this.svc.setStep(a, t, step, body, m); }
}
