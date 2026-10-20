import { Body, Controller, Delete, Get, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session.guard';
import { AppConfig, CONFIG } from '../config';
import { badRequest, conflict, notFound } from '../common/errors';
import { Auth, AuthContext, Meta, RequestMeta } from '../common/request';
import { Database } from '../database/database.service';
import { PlatformAdminGuard } from '../platform.controller';
import { BILLING_PROVIDER, type BillingProvider } from './billing-provider';
import { isMetric, METRIC_KEYS, PlanVersionInput } from './catalog';
import { tenantCostSummary } from './costs';
import { createDraftInvoice, invoiceDetail, invoiceOut, InvoiceInput, issueInvoice, PaymentInput, recordPayment, voidInvoice } from './invoices';
import { allowedEvents, lockSubscription, transition, type Actor, type SubEvent } from './lifecycle';
import { correctUsage, loadEntitlements, reconcileAggregates, usageSummary } from './quota';
import { assignPlan, changePlanNow, currentVersion, scheduleChange, setCancelAtPeriodEnd, versionById } from './subscriptions';
import { planOut } from './billing-api';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw badRequest('validation_failed', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
};
/** Every privileged commercial change carries a reason, stored in the audit log and the subscription history. */
const Reason = z.string().trim().min(5, 'A reason of at least 5 characters is required').max(1000);
const Code = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const PlanCreate = z.object({ code: Code, name: z.string().min(2).max(80), category: z.enum(['trial', 'self_service', 'sales_assisted', 'public_sector', 'internal']),
  description: z.string().max(2000).optional(), isPublic: z.boolean().default(false), sortOrder: z.number().int().min(0).max(10_000).default(100), reason: Reason }).strict();
const PlanPatch = z.object({ name: z.string().min(2).max(80).optional(), category: z.enum(['trial', 'self_service', 'sales_assisted', 'public_sector', 'internal']).optional(),
  description: z.string().max(2000).optional(), isPublic: z.boolean().optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).max(10_000).optional(), reason: Reason }).strict();
const VersionCreate = z.object({ version: PlanVersionInput, reason: Reason }).strict();
const Assign = z.object({ planCode: Code, billingMode: z.enum(['self_service', 'contract', 'manual']), status: z.enum(['trialing', 'pending_activation', 'active']),
  periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional(), trialEndsAt: z.string().datetime().optional(), contractId: z.string().uuid().optional(),
  resetUsagePeriod: z.boolean().default(false), reason: Reason }).strict();
const Transition = z.object({ event: z.enum(['activate', 'request_activation', 'payment_failed', 'payment_recovered', 'suspend', 'reinstate', 'renewal_due', 'renew', 'cancel_now', 'term_expired']),
  periodEnd: z.string().datetime().optional(), reason: Reason }).strict();
const ChangePlan = z.object({ planCode: Code, when: z.enum(['now', 'period_end', 'at']), at: z.string().datetime().optional(), reason: Reason }).strict();
const CancelFlag = z.object({ value: z.boolean(), reason: Reason }).strict();
const Override = z.object({ metric: z.string().refine(isMetric, 'Unknown metric'), limit: z.number().nonnegative().nullable(), enforcement: z.enum(['hard', 'soft']),
  expiresAt: z.string().datetime().optional(), reason: Reason }).strict();
const ReasonOnly = z.object({ reason: Reason }).strict();
const Correction = z.object({ recordId: z.string().regex(/^\d+$/), quantity: z.number().refine((n) => n !== 0 && Number.isFinite(n)), reason: Reason }).strict();
const ContractInput = z.object({
  customerName: z.string().min(2).max(300), contractReference: z.string().min(1).max(200), poReference: z.string().max(200).optional(), planCode: Code,
  startDate: Day, endDate: Day, billingFrequency: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'one_time']), paymentTermsDays: z.number().int().min(0).max(365).default(30),
  contractValue: z.number().nonnegative().max(1e14).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), renewalDate: Day.optional(),
  contactName: z.string().max(200).optional(), contactEmail: z.string().email().max(320).optional(), contactPhone: z.string().max(50).optional(),
  documentRefs: z.array(z.string().min(1).max(500)).max(20).default([]), notes: z.string().max(4000).optional(),
  activation: z.enum(['none', 'pending_activation', 'active']).default('none'), reason: Reason,
}).strict().refine((v) => v.endDate >= v.startDate, { message: 'endDate must not be before startDate', path: ['endDate'] })
  .refine((v) => v.contractValue === undefined || !!v.currency, { message: 'A contract value needs a currency', path: ['currency'] });
const ContractPatch = z.object({ status: z.enum(['draft', 'active', 'expired', 'terminated']).optional(), endDate: Day.optional(), renewalDate: Day.optional(), poReference: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(), contactEmail: z.string().email().max(320).optional(), contactPhone: z.string().max(50).optional(),
  documentRefs: z.array(z.string().min(1).max(500)).max(20).optional(), notes: z.string().max(4000).optional(), reason: Reason }).strict();
const InvoiceCreate = z.object({ invoice: InvoiceInput, reason: Reason }).strict();
const Issue = z.object({ dueDays: z.number().int().min(0).max(365).default(30), reason: Reason }).strict();
const Payment = z.object({ payment: PaymentInput, reason: Reason }).strict();
const CostEntry = z.object({ tenantId: z.string().uuid().nullable(), provider: z.string().min(2).max(60), service: z.string().min(2).max(120), periodStart: Day, periodEnd: Day,
  units: z.number().nonnegative().optional(), unit: z.string().max(40).optional(), amount: z.number().nonnegative().max(1e14), currency: z.string().regex(/^[A-Z]{3}$/),
  sourceReference: z.string().min(3).max(500), reason: Reason }).strict();
const SalesPatch = z.object({ status: z.enum(['open', 'in_progress', 'closed']), note: z.string().max(2000).optional() }).strict();

/**
 * Platform operator console for commercial operations. Guarded by session + platform-admin flag; tenant roles
 * (including tenant owners) never grant access. Writes to tenant records run in that tenant's RLS context and are
 * recorded in the tenant's audit log as commercial.* events with the operator and the reason.
 */
@Injectable()
export class PlatformCommercialService {
  constructor(private readonly db: Database, private readonly audit: AuditService, @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider) {}

  private async tenantExists(tenantId: string) {
    const ok = await this.db.withSystem(async (c) => (await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rowCount);
    if (!ok) throw notFound('Organization');
  }
  /** Runs `fn` in the tenant's context and audits it (same transaction). */
  private async inTenant<T>(a: AuthContext, m: RequestMeta, tenantId: string, action: string, target: { type: string; id: string | null }, reason: string,
    fn: (c: PoolClient, actor: Actor & { userId: string }) => Promise<T>, metadata: Record<string, unknown> = {}): Promise<T> {
    await this.tenantExists(tenantId);
    return this.db.withTenant(tenantId, a.userId, async (c) => {
      const out = await fn(c, { type: 'platform_admin', userId: a.userId, reason });
      await this.audit.record(c, { tenantId, actorUserId: a.userId, action: `commercial.${action}`, targetType: target.type, targetId: target.id ?? (out as any)?.id ?? null, metadata: { ...metadata, reason, platformAdmin: true }, meta: m });
      return out;
    });
  }
  private platformAudit(c: PoolClient, a: AuthContext, m: RequestMeta, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) {
    return this.audit.record(c, { tenantId: null, actorUserId: a.userId, action: `commercial.${action}`, targetType, targetId, metadata, meta: m });
  }

  // ── Plans ──
  plans() {
    return this.db.withSystem(async (c) => {
      const plans = (await c.query('SELECT * FROM plans ORDER BY sort_order, code')).rows;
      const versions = (await c.query('SELECT pv.*, p.code, p.name, p.category, p.description FROM plan_versions pv JOIN plans p ON p.id = pv.plan_id ORDER BY pv.version DESC')).rows;
      const used = new Map((await c.query(`SELECT plan_version_id, count(*)::int AS n FROM subscriptions WHERE ended_at IS NULL GROUP BY 1`)).rows.map((r) => [r.plan_version_id, r.n]));
      return { plans: plans.map((p) => ({ code: p.code, name: p.name, category: p.category, description: p.description, isPublic: p.is_public, isActive: p.is_active, sortOrder: p.sort_order,
        versions: versions.filter((v) => v.plan_id === p.id).map((v) => ({ ...planOut(v), effectiveTo: v.effective_to, notes: v.notes, subscriptions: used.get(v.id) ?? 0 })) })),
        metrics: METRIC_KEYS };
    });
  }
  createPlan(a: AuthContext, m: RequestMeta, body: unknown) {
    const d = parse(PlanCreate, body);
    return this.db.withSystem(async (c) => {
      const r = await c.query(`INSERT INTO plans (code, name, category, description, is_public, sort_order) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING RETURNING *`,
        [d.code, d.name, d.category, d.description ?? null, d.isPublic, d.sortOrder]);
      if (!r.rowCount) throw conflict('plan_exists', 'A plan with this code exists');
      await this.platformAudit(c, a, m, 'plan_created', 'plan', d.code, { reason: d.reason, category: d.category });
      return r.rows[0];
    });
  }
  updatePlan(a: AuthContext, m: RequestMeta, code: string, body: unknown) {
    const d = parse(PlanPatch, body);
    return this.db.withSystem(async (c) => {
      const r = await c.query(`UPDATE plans SET name = coalesce($2, name), category = coalesce($3, category), description = coalesce($4, description), is_public = coalesce($5, is_public),
        is_active = coalesce($6, is_active), sort_order = coalesce($7, sort_order) WHERE code = $1 RETURNING *`,
        [code, d.name ?? null, d.category ?? null, d.description ?? null, d.isPublic ?? null, d.isActive ?? null, d.sortOrder ?? null]);
      if (!r.rowCount) throw notFound('Plan');
      const { reason, ...fields } = d;
      await this.platformAudit(c, a, m, 'plan_updated', 'plan', code, { reason, fields });
      return r.rows[0];
    });
  }
  /** Adds a version (versions are immutable). The previous open version ends when the new one takes effect. */
  createVersion(a: AuthContext, m: RequestMeta, code: string, body: unknown) {
    const { version: v, reason } = parse(VersionCreate, body);
    return this.db.withSystem(async (c) => {
      const p = (await c.query('SELECT id FROM plans WHERE code = $1 FOR UPDATE', [code])).rows[0];
      if (!p) throw notFound('Plan');
      const from = v.effectiveFrom ? new Date(v.effectiveFrom) : new Date();
      const next = (await c.query<{ n: number }>('SELECT coalesce(max(version), 0) + 1 AS n FROM plan_versions WHERE plan_id = $1', [p.id])).rows[0]!.n;
      await c.query(`UPDATE plan_versions SET effective_to = $2 WHERE plan_id = $1 AND effective_to IS NULL AND effective_from < $2`, [p.id, from]);
      const r = (await c.query(`INSERT INTO plan_versions (plan_id, version, effective_from, currency, price_amount, billing_interval, trial_days, features, quotas, settings, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [p.id, next, from, v.currency ?? null, v.priceAmount ?? null, v.billingInterval, v.trialDays, JSON.stringify(v.features), JSON.stringify(v.quotas), JSON.stringify(v.settings), v.notes ?? null, a.userId])).rows[0];
      await this.platformAudit(c, a, m, 'plan_version_created', 'plan', `${code}@${next}`, { reason, price: v.priceAmount ?? null, currency: v.currency ?? null, effectiveFrom: from.toISOString() });
      return { id: r.id, version: next, effectiveFrom: from, note: 'Existing subscriptions keep their version until changed; new assignments use the version in effect.' };
    });
  }

  // ── Tenants and subscriptions ──
  tenants() {
    return this.db.withSystem(async (c) => ({
      tenants: (await c.query(`SELECT t.id, t.name, t.created_at, t.archived_at, s.status, s.plan_code, s.billing_mode, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end,
          (SELECT count(*)::int FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'overdue') AS overdue_invoices,
          (SELECT count(*)::int FROM sales_requests r WHERE r.tenant_id = t.id AND r.status <> 'closed') AS open_sales_requests
        FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.ended_at IS NULL ORDER BY t.created_at DESC`)).rows,
    }));
  }
  async tenant(tenantId: string) {
    await this.tenantExists(tenantId);
    // Tenant context gives the same view the tenant has of its commercial records (never its content).
    return this.db.withTenant(tenantId, '00000000-0000-0000-0000-000000000000', async (c) => {
      const ent = await loadEntitlements(c, tenantId);
      const sub = ent.subscription ? (await c.query('SELECT * FROM subscriptions WHERE id = $1', [ent.subscription.id])).rows[0] : null;
      return {
        tenant: (await c.query('SELECT id, name, slug, created_at, archived_at, settings->>\'timezone\' AS timezone FROM tenants WHERE id = $1', [tenantId])).rows[0],
        subscription: sub, entitlements: { access: ent.access, features: ent.features, quotas: ent.quotas, period: ent.period }, allowedEvents: sub ? allowedEvents(sub.status) : [],
        usage: await usageSummary(c, ent),
        events: (await c.query('SELECT * FROM subscription_events ORDER BY created_at DESC LIMIT 100')).rows,
        overrides: (await c.query('SELECT * FROM quota_overrides ORDER BY created_at DESC')).rows,
        contracts: (await c.query('SELECT * FROM contracts ORDER BY created_at DESC')).rows,
        invoices: (await c.query('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 100')).rows.map(invoiceOut),
        notices: (await c.query('SELECT * FROM usage_notices ORDER BY created_at DESC LIMIT 50')).rows,
        salesRequests: (await c.query('SELECT * FROM sales_requests ORDER BY created_at DESC LIMIT 50')).rows,
      };
    });
  }
  assign(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(Assign, body);
    return this.inTenant(a, m, tenantId, 'plan_assigned', { type: 'subscription', id: null }, d.reason, async (c, actor) => {
      const pv = await currentVersion(c, d.planCode);
      if (!pv) throw notFound('Plan');
      if (d.contractId && !(await c.query('SELECT 1 FROM contracts WHERE id = $1', [d.contractId])).rowCount) throw notFound('Contract');
      return assignPlan(c, tenantId, { planVersionId: pv.id, billingMode: d.billingMode, status: d.status, periodStart: d.periodStart ? new Date(d.periodStart) : undefined,
        periodEnd: d.periodEnd ? new Date(d.periodEnd) : undefined, trialEndsAt: d.trialEndsAt ? new Date(d.trialEndsAt) : undefined, contractId: d.contractId ?? null, resetUsageAnchor: d.resetUsagePeriod }, actor);
    }, { plan: d.planCode, billingMode: d.billingMode, status: d.status });
  }
  transition(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(Transition, body);
    return this.inTenant(a, m, tenantId, 'subscription_transition', { type: 'subscription', id: null }, d.reason, async (c, actor) => {
      const sub = await lockSubscription(c, tenantId);
      if (!sub) throw notFound('Subscription');
      const patch = d.periodEnd ? { current_period_start: sub.current_period_end ?? new Date(), current_period_end: new Date(d.periodEnd) } : {};
      return transition(c, sub, d.event as SubEvent, actor, patch);
    }, { event: d.event });
  }
  changePlan(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(ChangePlan, body);
    return this.inTenant(a, m, tenantId, 'plan_change', { type: 'subscription', id: null }, d.reason, async (c, actor) => {
      const sub = await lockSubscription(c, tenantId);
      if (!sub) throw notFound('Subscription');
      const pv = await currentVersion(c, d.planCode);
      if (!pv) throw notFound('Plan');
      if (d.when === 'now') return changePlanNow(c, sub, pv.id, actor);
      const at = d.when === 'at' ? (d.at ? new Date(d.at) : null) : sub.current_period_end;
      if (!at) throw badRequest('validation_failed', d.when === 'at' ? 'Give `at`' : 'The subscription has no period end');
      return scheduleChange(c, sub, pv.id, at, actor);
    }, { plan: d.planCode, when: d.when });
  }
  cancelFlag(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(CancelFlag, body);
    return this.inTenant(a, m, tenantId, d.value ? 'cancel_scheduled' : 'cancel_withdrawn', { type: 'subscription', id: null }, d.reason, async (c, actor) => {
      const sub = await lockSubscription(c, tenantId);
      if (!sub) throw notFound('Subscription');
      return setCancelAtPeriodEnd(c, sub, d.value, actor);
    });
  }
  addOverride(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(Override, body);
    return this.inTenant(a, m, tenantId, 'quota_override_set', { type: 'quota_override', id: null }, d.reason, async (c) => {
      await c.query('UPDATE quota_overrides SET revoked_at = now() WHERE tenant_id = $1 AND metric = $2 AND revoked_at IS NULL', [tenantId, d.metric]);
      return (await c.query(`INSERT INTO quota_overrides (tenant_id, metric, quota_limit, enforcement, reason, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [tenantId, d.metric, d.limit, d.enforcement, d.reason, d.expiresAt ?? null, a.userId])).rows[0];
    }, { metric: d.metric, limit: d.limit, enforcement: d.enforcement, expiresAt: d.expiresAt ?? null });
  }
  revokeOverride(a: AuthContext, m: RequestMeta, tenantId: string, id: string, body: unknown) {
    const d = parse(ReasonOnly, body);
    return this.inTenant(a, m, tenantId, 'quota_override_revoked', { type: 'quota_override', id }, d.reason, async (c) => {
      const r = await c.query('UPDATE quota_overrides SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id]);
      if (!r.rowCount) throw notFound('Override');
      return { id, revoked: true };
    });
  }
  ledger(tenantId: string, metric: string | undefined, limit: number) {
    if (metric && !isMetric(metric)) throw badRequest('validation_failed', 'Unknown metric');
    return this.db.withSystem(async (c) => ({
      entries: (await c.query(`SELECT id, metric, quantity, kind, measurement, source, idempotency_key, occurred_at, usage_period_start, period_start AS day, project_id, corrects_id, reason, recorded_by, recorded_at
        FROM usage_records WHERE tenant_id = $1 AND ($2::text IS NULL OR metric = $2) ORDER BY id DESC LIMIT $3`, [tenantId, metric ?? null, limit])).rows,
    }));
  }
  correct(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(Correction, body);
    return this.inTenant(a, m, tenantId, 'usage_corrected', { type: 'usage_record', id: d.recordId }, d.reason, async (c) => {
      const r = await correctUsage(c, tenantId, { correctsId: d.recordId, quantity: d.quantity, reason: d.reason, userId: a.userId });
      if (!r) throw notFound('Usage record');
      return r;
    }, { quantity: d.quantity });
  }
  reconcile(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(ReasonOnly, body);
    return this.inTenant(a, m, tenantId, 'usage_reconciled', { type: 'tenant', id: tenantId }, d.reason, (c) => reconcileAggregates(c, tenantId));
  }

  // ── Contracts ──
  createContract(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(ContractInput, body);
    return this.inTenant(a, m, tenantId, 'contract_created', { type: 'contract', id: null }, d.reason, async (c, actor) => {
      const pv = await currentVersion(c, d.planCode);
      if (!pv) throw notFound('Plan');
      const k = (await c.query(`INSERT INTO contracts (tenant_id, customer_name, contract_reference, po_reference, plan_version_id, start_date, end_date, billing_frequency, payment_terms_days,
          contract_value, currency, renewal_date, status, contact_name, contact_email, contact_phone, document_refs, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (tenant_id, contract_reference) DO NOTHING RETURNING *`,
        [tenantId, d.customerName, d.contractReference, d.poReference ?? null, pv.id, d.startDate, d.endDate, d.billingFrequency, d.paymentTermsDays, d.contractValue ?? null, d.currency ?? null,
          d.renewalDate ?? null, d.activation === 'none' ? 'draft' : 'active', d.contactName ?? null, d.contactEmail ?? null, d.contactPhone ?? null, d.documentRefs, d.notes ?? null, a.userId])).rows[0];
      if (!k) throw conflict('contract_exists', 'A contract with this reference exists for this organization');
      if (d.activation !== 'none') {
        await assignPlan(c, tenantId, { planVersionId: pv.id, billingMode: 'contract', status: d.activation, contractId: k.id,
          periodStart: new Date(`${d.startDate}T00:00:00Z`) < new Date() ? new Date() : new Date(`${d.startDate}T00:00:00Z`), resetUsageAnchor: true }, actor);
      }
      return k;
    }, { reference: d.contractReference, plan: d.planCode, activation: d.activation });
  }
  updateContract(a: AuthContext, m: RequestMeta, tenantId: string, id: string, body: unknown) {
    const d = parse(ContractPatch, body);
    return this.inTenant(a, m, tenantId, 'contract_updated', { type: 'contract', id }, d.reason, async (c) => {
      const r = await c.query(`UPDATE contracts SET status = coalesce($2, status), end_date = coalesce($3::date, end_date), renewal_date = coalesce($4::date, renewal_date), po_reference = coalesce($5, po_reference),
          contact_name = coalesce($6, contact_name), contact_email = coalesce($7, contact_email), contact_phone = coalesce($8, contact_phone), document_refs = coalesce($9, document_refs), notes = coalesce($10, notes)
        WHERE id = $1 RETURNING *`, [id, d.status ?? null, d.endDate ?? null, d.renewalDate ?? null, d.poReference ?? null, d.contactName ?? null, d.contactEmail ?? null, d.contactPhone ?? null, d.documentRefs ?? null, d.notes ?? null]);
      if (!r.rowCount) throw notFound('Contract');
      if (r.rows[0].end_date < r.rows[0].start_date) throw badRequest('validation_failed', 'endDate must not be before startDate');
      return r.rows[0];
    }, { fields: Object.keys(d).filter((k) => k !== 'reason') });
  }

  // ── Invoices ──
  listInvoices(status?: string) {
    return this.db.withSystem(async (c) => ({
      invoices: (await c.query(`SELECT i.*, t.name AS tenant_name FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE ($1::text IS NULL OR i.status = $1) ORDER BY i.created_at DESC LIMIT 300`,
        [status ?? null])).rows.map((r) => ({ ...invoiceOut(r), tenantId: r.tenant_id, tenantName: r.tenant_name })),
    }));
  }
  invoice(tenantId: string, id: string) { return this.db.withSystem((c) => invoiceDetail(c, tenantId, id)); }
  createInvoice(a: AuthContext, m: RequestMeta, tenantId: string, body: unknown) {
    const d = parse(InvoiceCreate, body);
    return this.inTenant(a, m, tenantId, 'invoice_drafted', { type: 'invoice', id: null }, d.reason, (c) => createDraftInvoice(c, tenantId, d.invoice, a.userId), { currency: d.invoice.currency });
  }
  issue(a: AuthContext, m: RequestMeta, tenantId: string, id: string, body: unknown) {
    const d = parse(Issue, body);
    return this.inTenant(a, m, tenantId, 'invoice_issued', { type: 'invoice', id }, d.reason, async (c) => invoiceOut(await issueInvoice(c, tenantId, id, { dueDays: d.dueDays }, this.config.billing.invoicePrefix)));
  }
  pay(a: AuthContext, m: RequestMeta, tenantId: string, id: string, body: unknown) {
    const d = parse(Payment, body);
    return this.inTenant(a, m, tenantId, 'payment_recorded', { type: 'invoice', id }, d.reason, async (c, actor) => {
      const r = await recordPayment(c, tenantId, id, d.payment, actor);
      return { invoice: invoiceOut(r.invoice), paymentId: r.paymentId };
    }, { amount: d.payment.amount, method: d.payment.method, reference: d.payment.reference });
  }
  void(a: AuthContext, m: RequestMeta, tenantId: string, id: string, body: unknown) {
    const d = parse(ReasonOnly, body);
    return this.inTenant(a, m, tenantId, 'invoice_voided', { type: 'invoice', id }, d.reason, async (c) => invoiceOut(await voidInvoice(c, tenantId, id)));
  }

  // ── Costs, health, audit, sales ──
  costs(from?: string, to?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : `${today.slice(0, 7)}-01`;
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today;
    if (t < f) throw badRequest('validation_failed', '`to` must not be before `from`');
    return this.db.withSystem((c) => tenantCostSummary(c, f, t));
  }
  addCost(a: AuthContext, m: RequestMeta, body: unknown) {
    const d = parse(CostEntry, body);
    if (d.periodEnd < d.periodStart) throw badRequest('validation_failed', 'periodEnd must not be before periodStart');
    return this.db.withSystem(async (c) => {
      if (d.tenantId && !(await c.query('SELECT 1 FROM tenants WHERE id = $1', [d.tenantId])).rowCount) throw notFound('Organization');
      const r = (await c.query(`INSERT INTO provider_cost_entries (tenant_id, provider, service, period_start, period_end, units, unit, amount, currency, source_reference, recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [d.tenantId, d.provider, d.service, d.periodStart, d.periodEnd, d.units ?? null, d.unit ?? null, d.amount, d.currency, d.sourceReference, a.userId])).rows[0];
      await this.platformAudit(c, a, m, 'provider_cost_recorded', 'provider_cost_entry', r.id, { reason: d.reason, provider: d.provider, amount: d.amount, currency: d.currency, tenantId: d.tenantId });
      return r;
    });
  }
  health() {
    return this.db.withSystem(async (c) => ({
      provider: { name: this.provider.name, configured: this.provider.configured, live: this.provider.live },
      subscriptions: (await c.query(`SELECT status, count(*)::int AS n FROM subscriptions WHERE ended_at IS NULL GROUP BY 1 ORDER BY 1`)).rows,
      tenantsWithoutSubscription: (await c.query(`SELECT count(*)::int AS n FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id AND s.ended_at IS NULL)`)).rows[0].n,
      trialsEndingIn7Days: (await c.query(`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'trialing' AND ended_at IS NULL AND trial_ends_at < now() + interval '7 days'`)).rows[0].n,
      invoices: (await c.query(`SELECT status, count(*)::int AS n FROM invoices GROUP BY 1 ORDER BY 1`)).rows,
      webhooks: (await c.query(`SELECT status, count(*)::int AS n, max(received_at) AS last FROM billing_webhook_events WHERE received_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1`)).rows,
      failedWebhooks: (await c.query(`SELECT id, provider, event_id, event_type, status, error, received_at FROM billing_webhook_events WHERE status IN ('failed','rejected') ORDER BY received_at DESC LIMIT 50`)).rows,
      noticesPendingEmail: (await c.query(`SELECT email_status, count(*)::int AS n FROM usage_notices GROUP BY 1`)).rows,
      openSalesRequests: (await c.query(`SELECT count(*)::int AS n FROM sales_requests WHERE status <> 'closed'`)).rows[0].n,
    }));
  }
  commercialAudit(limit: number) {
    return this.db.withSystem(async (c) => ({
      events: (await c.query(`SELECT a.id, a.tenant_id, t.name AS tenant_name, a.actor_user_id, u.email AS actor_email, a.action, a.target_type, a.target_id, a.metadata, a.outcome, a.occurred_at
        FROM audit_events a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.action LIKE 'commercial.%' ORDER BY a.occurred_at DESC LIMIT $1`, [limit])).rows,
    }));
  }
  salesRequests() {
    return this.db.withSystem(async (c) => ({
      requests: (await c.query(`SELECT r.*, t.name AS tenant_name, u.email AS requested_by_email FROM sales_requests r JOIN tenants t ON t.id = r.tenant_id JOIN users u ON u.id = r.requested_by
        ORDER BY (r.status = 'closed'), r.created_at DESC LIMIT 200`)).rows,
    }));
  }
  async updateSalesRequest(a: AuthContext, m: RequestMeta, id: string, body: unknown) {
    const d = parse(SalesPatch, body);
    const tenantId = await this.db.withSystem(async (c) => (await c.query<{ tenant_id: string }>('SELECT tenant_id FROM sales_requests WHERE id = $1', [id])).rows[0]?.tenant_id);
    if (!tenantId) throw notFound('Sales request');
    return this.inTenant(a, m, tenantId, 'sales_request_updated', { type: 'sales_request', id }, d.note ?? `status ${d.status}`, async (c) =>
      (await c.query('UPDATE sales_requests SET status = $2, handled_by = $3, handled_note = coalesce($4, handled_note) WHERE id = $1 RETURNING *', [id, d.status, a.userId, d.note ?? null])).rows[0],
    { status: d.status });
  }
}

@ApiTags('platform')
@Controller('platform/commercial')
@UseGuards(SessionGuard, PlatformAdminGuard)
export class PlatformCommercialController {
  constructor(private readonly svc: PlatformCommercialService) {}

  @Get('plans') plans() { return this.svc.plans(); }
  @Post('plans') createPlan(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Body() b: unknown) { return this.svc.createPlan(a, m, b); }
  @Patch('plans/:code') updatePlan(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('code') code: string, @Body() b: unknown) { return this.svc.updatePlan(a, m, code, b); }
  @Post('plans/:code/versions') createVersion(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('code') code: string, @Body() b: unknown) { return this.svc.createVersion(a, m, code, b); }

  @Get('tenants') tenants() { return this.svc.tenants(); }
  @Get('tenants/:id') tenant(@Param('id', ParseUUIDPipe) id: string) { return this.svc.tenant(id); }
  @Post('tenants/:id/subscription/assign') assign(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.assign(a, m, id, b); }
  @Post('tenants/:id/subscription/transition') @HttpCode(200) transition(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.transition(a, m, id, b); }
  @Post('tenants/:id/subscription/change-plan') @HttpCode(200) changePlan(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.changePlan(a, m, id, b); }
  @Post('tenants/:id/subscription/cancel-at-period-end') @HttpCode(200) cancelFlag(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.cancelFlag(a, m, id, b); }
  @Post('tenants/:id/overrides') addOverride(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.addOverride(a, m, id, b); }
  @Delete('tenants/:id/overrides/:oid') revokeOverride(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Param('oid', ParseUUIDPipe) oid: string, @Body() b: unknown) { return this.svc.revokeOverride(a, m, id, oid, b); }
  @Get('tenants/:id/usage/ledger') ledger(@Param('id', ParseUUIDPipe) id: string, @Query('metric') metric?: string, @Query('limit') limit?: string) {
    return this.svc.ledger(id, metric || undefined, Math.min(Math.max(Number(limit) || 100, 1), 1000));
  }
  @Post('tenants/:id/usage/corrections') correct(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.correct(a, m, id, b); }
  @Post('tenants/:id/usage/reconcile') @HttpCode(200) reconcile(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.reconcile(a, m, id, b); }
  @Post('tenants/:id/contracts') createContract(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.createContract(a, m, id, b); }
  @Patch('tenants/:id/contracts/:cid') updateContract(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Param('cid', ParseUUIDPipe) cid: string, @Body() b: unknown) { return this.svc.updateContract(a, m, id, cid, b); }
  @Post('tenants/:id/invoices') createInvoice(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.createInvoice(a, m, id, b); }
  @Get('tenants/:id/invoices/:iid') invoice(@Param('id', ParseUUIDPipe) id: string, @Param('iid', ParseUUIDPipe) iid: string) { return this.svc.invoice(id, iid); }
  @Post('tenants/:id/invoices/:iid/issue') @HttpCode(200) issue(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Param('iid', ParseUUIDPipe) iid: string, @Body() b: unknown) { return this.svc.issue(a, m, id, iid, b); }
  @Post('tenants/:id/invoices/:iid/payments') pay(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Param('iid', ParseUUIDPipe) iid: string, @Body() b: unknown) { return this.svc.pay(a, m, id, iid, b); }
  @Post('tenants/:id/invoices/:iid/void') @HttpCode(200) voidInvoice(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Param('iid', ParseUUIDPipe) iid: string, @Body() b: unknown) { return this.svc.void(a, m, id, iid, b); }

  @Get('invoices') invoices(@Query('status') status?: string) { return this.svc.listInvoices(status && /^[a-z_]{3,20}$/.test(status) ? status : undefined); }
  @Get('costs') costs(@Query('from') from?: string, @Query('to') to?: string) { return this.svc.costs(from, to); }
  @Post('costs/entries') addCost(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Body() b: unknown) { return this.svc.addCost(a, m, b); }
  @Get('health') health() { return this.svc.health(); }
  @Get('audit') audit(@Query('limit') limit?: string) { return this.svc.commercialAudit(Math.min(Math.max(Number(limit) || 100, 1), 500)); }
  @Get('sales-requests') sales() { return this.svc.salesRequests(); }
  @Patch('sales-requests/:id') updateSales(@Auth() a: AuthContext, @Meta() m: RequestMeta, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.svc.updateSalesRequest(a, m, id, b); }
}
