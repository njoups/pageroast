import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { AppConfig, CONFIG } from '../../src/config';
import { Database } from '../../src/database/database.service';
import { signTestPayload, TEST_SIGNATURE_HEADER } from '../../src/commercial/billing-provider';
import { consume, reconcileAggregates } from '../../src/commercial/quota';
import { commercialTick } from '../../src/commercial/scheduler';
import { addMember, createOrg, registerUser, testApp, TestUser } from '../helpers';
import { OWNER_URL } from '../env';

/** Integration regression tests for defects found in the full-system QA audit (docs/FULL_SYSTEM_QA_REPORT.md). */
const SECRET = 'whsec-qa-0123456789abcdefghijklmnop';
const SYS = '00000000-0000-0000-0000-000000000000';
const REASON = 'QA regression operator action';

describe('QA regressions (integration)', () => {
  let app: INestApplication; let db: Database; let owner_db: Client; let config: AppConfig;
  let owner: TestUser; let admin: TestUser;
  const http = () => request(app.getHttpServer());
  const asAdmin = (method: 'get' | 'post' | 'patch' | 'put', path: string) => http()[method](`/api/v1/platform/commercial${path}`).set('Cookie', admin.cookie);
  const billing = async (o: string, u = owner) => (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', u.cookie).expect(200)).body;
  const send = (body: object) => { const raw = JSON.stringify(body); return http().post('/api/v1/billing/webhooks/test').set('Content-Type', 'application/json').set(TEST_SIGNATURE_HEADER, signTestPayload(SECRET, raw)).send(raw); };
  const period = (days = 30) => ({ period_start: new Date().toISOString(), period_end: new Date(Date.now() + days * 86_400_000).toISOString() });
  const evt = (type: string, data: object) => ({ id: `evt_${randomUUID()}`, type, created_at: new Date().toISOString(), data });

  beforeAll(async () => {
    app = await testApp({ BILLING_PROVIDER: 'test', BILLING_TEST_WEBHOOK_SECRET: SECRET });
    db = app.get(Database); config = app.get<AppConfig>(CONFIG);
    owner_db = new Client({ connectionString: OWNER_URL }); await owner_db.connect();
    owner = await registerUser(app, 'QA Owner'); admin = await registerUser(app, 'QA Operator');
    await owner_db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.id]);
    await asAdmin('post', '/plans/professional/versions').send({ reason: REASON, version: { currency: 'IDR', priceAmount: 2500000, billingInterval: 'month', trialDays: 0,
      features: { ai_analysis: true, scheduled_reports: true }, quotas: { projects: { limit: 10, enforcement: 'hard' } }, settings: { past_due_grace_days: 7 } } }).expect(201);
  });
  afterAll(async () => { await owner_db.end(); await app.close(); });

  /** Checkout + signed completion; returns the provider subscription reference. */
  const buy = async (o: string) => {
    const co = (await http().post(`/api/v1/organizations/${o}/billing/checkout`).set('Cookie', owner.cookie).send({ planCode: 'professional' }).expect(200)).body;
    const ref = `sub_${randomUUID()}`;
    await send(evt('checkout.completed', { session: new URL(co.url).searchParams.get('session'), customer: `cus_${randomUUID()}`, subscription: ref, ...period() })).expect(200);
    return ref;
  };

  it('QA-BL-01: an organization whose trial expired is reactivated by a paid checkout', async () => {
    const o = await createOrg(app, owner, 'Expired then paid');
    await commercialTick(db, config, new Date(Date.now() + 15 * 86_400_000));
    expect((await billing(o)).subscription).toBeNull();
    await buy(o);
    expect((await billing(o)).subscription).toMatchObject({ status: 'active', billingMode: 'self_service' });
  });

  it('QA-BL-02/05: late provider events for a replaced subscription change nothing; a contract is not expired by a stale reference', async () => {
    const o = await createOrg(app, owner, 'Provider then contract');
    const ref = await buy(o);
    // The operator moves the organization to manual billing: provider and contract references are cleared.
    await asAdmin('post', `/tenants/${o}/subscription/assign`).send({ planCode: 'government', billingMode: 'manual', status: 'active', reason: REASON }).expect(201);
    const sub = (await owner_db.query('SELECT billing_reference, contract_id, current_period_end FROM subscriptions WHERE tenant_id = $1 AND ended_at IS NULL', [o])).rows[0];
    expect(sub).toMatchObject({ billing_reference: null, contract_id: null });
    // The reference still resolves to this organization (older rows), but the late failure must not touch the manual plan.
    await owner_db.query(`UPDATE subscriptions SET billing_provider = 'test', billing_reference = $2 WHERE tenant_id = $1 AND ended_at IS NOT NULL`, [o, ref]).catch(() => undefined);
    await owner_db.query(`INSERT INTO subscriptions (tenant_id, plan_code, status, billing_provider, billing_reference, ended_at, usage_anchor) VALUES ($1,'professional','canceled','test',$2, now(), now())`, [o, ref]);
    await send(evt('invoice.payment_failed', { subscription: ref, invoice: `in_${randomUUID()}`, amount: 2500000, currency: 'IDR' })).expect(200);
    expect((await billing(o)).subscription.status).toBe('active');
    const after = (await owner_db.query('SELECT current_period_end FROM subscriptions WHERE tenant_id = $1 AND ended_at IS NULL', [o])).rows[0];
    expect(after.current_period_end.getTime()).toBe(sub.current_period_end.getTime());
  });

  it('QA-BL-03/04: a paid invoice does not lift an operator suspension; a late failure never downgrades a paid invoice', async () => {
    const o = await createOrg(app, owner, 'Suspended by operator');
    const ref = await buy(o);
    await asAdmin('post', `/tenants/${o}/subscription/transition`).send({ event: 'suspend', reason: 'Abuse investigation in progress' }).expect(200);
    const inv = `in_${randomUUID()}`;
    await send(evt('invoice.paid', { subscription: ref, invoice: inv, payment: `py_${randomUUID()}`, amount: 2500000, currency: 'IDR', ...period(60) })).expect(200);
    expect((await billing(o)).subscription.status).toBe('suspended');
    const late = await send(evt('invoice.payment_failed', { subscription: ref, invoice: inv, amount: 2400000, currency: 'IDR' })).expect(200);
    expect(late.body.status).toBe('ignored');
    const row = (await owner_db.query('SELECT status, total, amount_paid FROM invoices WHERE provider_invoice_ref = $1', [inv])).rows[0];
    expect(row).toEqual({ status: 'paid', total: '2500000.00', amount_paid: '2500000.00' });
  });

  it('QA-BL-06: reconciliation never loses usage recorded concurrently', async () => {
    const o = await createOrg(app, owner, 'Reconcile race');
    const jobs = [];
    for (let i = 0; i < 30; i++) {
      jobs.push(db.withTenant(o, SYS, (c) => consume(c, o, { metric: 'exports', quantity: 1, idempotencyKey: `race:${i}`, source: 'test' })));
      if (i % 5 === 0) jobs.push(db.withTenant(o, SYS, (c) => reconcileAggregates(c, o)));
    }
    await Promise.all(jobs);
    const ledger = (await owner_db.query(`SELECT sum(quantity)::int AS q FROM usage_records WHERE tenant_id = $1 AND metric = 'exports'`, [o])).rows[0].q;
    const total = (await owner_db.query(`SELECT sum(quantity)::int AS q FROM usage_period_totals WHERE tenant_id = $1 AND metric = 'exports'`, [o])).rows[0].q;
    expect([ledger, total]).toEqual([30, 30]);
  });

  it('QA-BL-09/07/08: invoice money is exact numeric; partial payment keeps overdue; voiding the last overdue invoice recovers', async () => {
    const o = await createOrg(app, owner, 'Money and dunning');
    await asAdmin('post', `/tenants/${o}/subscription/assign`).send({ planCode: 'government', billingMode: 'manual', status: 'active', reason: REASON }).expect(201);
    const draft = (body: object) => asAdmin('post', `/tenants/${o}/invoices`).send({ reason: REASON, invoice: { currency: 'IDR', billTo: { name: 'Dinas' }, ...body } });
    await draft({ lines: [{ description: 'x', quantity: 3, unitAmount: 0.125 }] }).expect(400);         // sub-cent amounts are refused
    const a = (await draft({ lines: [{ description: 'Langganan', quantity: 3, unitAmount: 0.13 }, { description: 'Setup', quantity: 1, unitAmount: 1.01 }] }).expect(201)).body.id;
    expect((await owner_db.query('SELECT subtotal, total FROM invoices WHERE id = $1', [a])).rows[0]).toEqual({ subtotal: '1.40', total: '1.40' });
    const b = (await draft({ lines: [{ description: 'Kuartal', quantity: 1, unitAmount: 100 }] }).expect(201)).body.id;
    for (const id of [a, b]) await asAdmin('post', `/tenants/${o}/invoices/${id}/issue`).send({ dueDays: 0, reason: REASON }).expect(200);
    await commercialTick(db, config, new Date(Date.now() + 86_400_000));
    expect((await billing(o)).subscription.status).toBe('past_due');
    const pay = (id: string, amount: number, reference: string) => asAdmin('post', `/tenants/${o}/invoices/${id}/payments`).send({ reason: REASON, payment: { amount, method: 'bank_transfer', reference, receivedAt: new Date().toISOString() } });
    expect((await pay(a, 0.15, 'TRF-1').expect(201)).body.invoice).toMatchObject({ status: 'overdue', amountPaid: 0.15 });
    await pay(b, 100, 'TRF-2').expect(201);
    expect((await billing(o)).subscription.status).toBe('past_due');                  // A is still overdue
    await pay(a, 1.25, 'TRF-3').expect(201);
    expect((await owner_db.query('SELECT amount_paid, (SELECT sum(amount) FROM payments WHERE invoice_id = $1) AS paid FROM invoices WHERE id = $1', [a])).rows[0]).toEqual({ amount_paid: '1.40', paid: '1.40' });
    expect((await billing(o)).subscription.status).toBe('active');
    // Voiding the only overdue invoice settles the account.
    const c = (await draft({ lines: [{ description: 'Denda', quantity: 1, unitAmount: 5 }] }).expect(201)).body.id;
    await asAdmin('post', `/tenants/${o}/invoices/${c}/issue`).send({ dueDays: 0, reason: REASON }).expect(200);
    await commercialTick(db, config, new Date(Date.now() + 86_400_000));
    expect((await billing(o)).subscription.status).toBe('past_due');
    await asAdmin('post', `/tenants/${o}/invoices/${c}/void`).send({ reason: REASON }).expect(200);
    expect((await billing(o)).subscription.status).toBe('active');
  });

  it('QA-BL-10: changing the organization time zone does not reset the current usage period', async () => {
    const o = await createOrg(app, owner, 'Timezone change');
    await db.withTenant(o, SYS, (c) => consume(c, o, { metric: 'reports_generated', quantity: 3, idempotencyKey: 'tz:1', source: 'test' }));
    const before = (await billing(o)).usage.find((u: { metric: string }) => u.metric === 'reports_generated').used;
    await http().patch(`/api/v1/organizations/${o}`).set('Cookie', owner.cookie).send({ settings: { timezone: 'America/New_York' } }).expect(200);
    const after = (await billing(o)).usage.find((u: { metric: string }) => u.metric === 'reports_generated').used;
    expect([before, after]).toEqual([3, 3]);
  });

  it('QA-FE-01: auth/me carries each organization\'s display time zone (and no other settings)', async () => {
    const o = await createOrg(app, owner, 'Display timezone');
    await http().patch(`/api/v1/organizations/${o}`).set('Cookie', owner.cookie).send({ settings: { timezone: 'Asia/Makassar' } }).expect(200);
    const me = (await http().get('/api/v1/auth/me').set('Cookie', owner.cookie).expect(200)).body;
    const org = me.organizations.find((x: { id: string }) => x.id === o);
    expect(org.settings).toEqual({ timezone: 'Asia/Makassar' });
  });

  it('QA-BL-11: corrections cannot over-correct and replay idempotently', async () => {
    const o = await createOrg(app, owner, 'Corrections');
    await db.withTenant(o, SYS, (c) => consume(c, o, { metric: 'exports', quantity: 5, idempotencyKey: 'corr:1', source: 'test' }));
    const id = String((await owner_db.query(`SELECT id FROM usage_records WHERE tenant_id = $1 AND idempotency_key = 'corr:1'`, [o])).rows[0].id);
    const correct = (q: number, key: string) => asAdmin('post', `/tenants/${o}/usage/corrections`).send({ recordId: id, quantity: q, reason: REASON, idempotencyKey: key });
    await correct(-4, 'corr-key-0001').expect(201);
    await correct(-4, 'corr-key-0001').expect(201);                                     // same key: same correction, applied once
    await correct(-4, 'corr-key-0002').expect(400);                                     // 5 - 4 - 4 < 0
    expect((await owner_db.query(`SELECT sum(quantity)::int AS q FROM usage_records WHERE tenant_id = $1 AND metric = 'exports'`, [o])).rows[0].q).toBe(1);
  });

  it('QA-BL-14: renewing a contract requires and records a new end of term (no renewal loop)', async () => {
    const o = await createOrg(app, owner, 'Contract renewal');
    const today = new Date().toISOString().slice(0, 10); const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await asAdmin('post', `/tenants/${o}/contracts`).send({ customerName: 'Pemkab', contractReference: 'SPK-QA-1', planCode: 'government', startDate: today, endDate: soon,
      billingFrequency: 'annual', activation: 'active', reason: REASON }).expect(201);
    await commercialTick(db, config);
    expect((await billing(o)).subscription.status).toBe('pending_renewal');
    await asAdmin('post', `/tenants/${o}/subscription/transition`).send({ event: 'renew', reason: REASON }).expect(400);
    const next = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    await asAdmin('post', `/tenants/${o}/subscription/transition`).send({ event: 'renew', contractEndDate: next, reason: REASON }).expect(200);
    await commercialTick(db, config);
    expect((await billing(o)).subscription.status).toBe('active');
  });

  it('QA-AZ-01: admins cannot enable retention, shorten periods or lift a legal hold; owners can', async () => {
    const o = await createOrg(app, owner, 'Governance split');
    const adminMember = await addMember(app, owner, o, 'admin', 'Gov Admin');
    const as = (u: TestUser, p: string, b: object) => http().put(`/api/v1/organizations/${o}/data-governance${p}`).set('Cookie', u.cookie).send(b);
    await as(adminMember, '/controls', { retentionEnabled: true }).expect(403);
    await as(adminMember, '/retention-policies/mention_metadata', { retentionDays: 1 }).expect(403);
    await as(owner, '/controls', { legalHold: true, legalHoldReason: 'Litigation hold for audit' }).expect(200);
    await as(adminMember, '/controls', { legalHold: false }).expect(403);
    await as(adminMember, '/controls', { legalHold: true, legalHoldReason: 'Extended hold for audit' }).expect(200);   // making data safer is allowed
    await as(owner, '/retention-policies/mention_metadata', { retentionDays: 400 }).expect(200);
    await as(adminMember, '/retention-policies/mention_metadata', { retentionDays: 500 }).expect(200);                // lengthening is allowed
    await as(owner, '/controls', { legalHold: false, retentionEnabled: true }).expect(200);
  });
});
