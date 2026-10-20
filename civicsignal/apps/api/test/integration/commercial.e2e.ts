import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { AppConfig, CONFIG } from '../../src/config';
import { Database } from '../../src/database/database.service';
import { signTestPayload, TEST_SIGNATURE_HEADER } from '../../src/commercial/billing-provider';
import { consume, loadEntitlements } from '../../src/commercial/quota';
import { commercialTick } from '../../src/commercial/scheduler';
import { IngestionPipeline } from '../../src/ingestion/pipeline.service';
import { addMember, createOrg, registerUser, testApp, TestUser } from '../helpers';
import { FeedServer, rss } from './feed-server';
import { OWNER_URL } from '../env';

const SECRET = 'whsec-test-0123456789abcdefghijklmnop';
const SYS = '00000000-0000-0000-0000-000000000000';
const REASON = 'integration test operator action';

describe('commercialization: plans, subscriptions, metering, billing (integration)', () => {
  let app: INestApplication; let none: INestApplication;
  let owner: TestUser; let admin: TestUser; let orgId: string; let db: Database; let owner_db: Client; let config: AppConfig;
  const http = () => request(app.getHttpServer());
  const asAdmin = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => http()[method](`/api/v1/platform/commercial${path}`).set('Cookie', admin.cookie);

  beforeAll(async () => {
    none = await testApp();                                                    // default: no payment provider
    app = await testApp({ BILLING_PROVIDER: 'test', BILLING_TEST_WEBHOOK_SECRET: SECRET });
    db = app.get(Database); config = app.get<AppConfig>(CONFIG);
    owner_db = new Client({ connectionString: OWNER_URL }); await owner_db.connect();
    owner = await registerUser(app, 'Owner');
    admin = await registerUser(app, 'Operator');
    await owner_db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [admin.id]);
    orgId = await createOrg(app, owner, 'Dinas Kominfo Uji');
  });
  afterAll(async () => { await owner_db.end(); await app.close(); await none.close(); });

  describe('trial and entitlements', () => {
    it('a new organization starts the configured trial, recorded in its history and audit log', async () => {
      const b = (await http().get(`/api/v1/organizations/${orgId}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b.subscription).toMatchObject({ status: 'trialing', access: 'full', billingMode: 'self_service' });
      expect(b.plan).toMatchObject({ code: 'trial', priceStatus: 'contact_sales', price: null });
      expect(new Date(b.subscription.trialEndsAt).getTime() - Date.now()).toBeGreaterThan(13 * 86_400_000);
      expect(b.payments).toMatchObject({ name: 'test', live: false, onlinePayments: 'test_mode' });
      expect(b.usage.find((u: { metric: string }) => u.metric === 'seats')).toMatchObject({ used: 1, limit: 5, remaining: 4 });
      const ev = (await http().get(`/api/v1/organizations/${orgId}/billing/events`).set('Cookie', owner.cookie).expect(200)).body.events;
      expect(ev.map((e: { event: string }) => e.event)).toEqual(['trial_started']);
    });

    it('billing data needs billing:read; every member may see the plan name and features', async () => {
      const analyst = await addMember(app, owner, orgId, 'analyst', 'Analyst');
      await http().get(`/api/v1/organizations/${orgId}/billing`).set('Cookie', analyst.cookie).expect(403);
      await http().get(`/api/v1/organizations/${orgId}/billing/invoices`).set('Cookie', analyst.cookie).expect(403);
      const e = (await http().get(`/api/v1/organizations/${orgId}/entitlements`).set('Cookie', analyst.cookie).expect(200)).body;
      expect(e).toMatchObject({ plan: { code: 'trial' }, status: 'trialing', access: 'full' });
      expect(e.features.api_access).toBe(false);
      // A non-member gets 404 (existence not disclosed), and checkout needs billing:manage (owner only).
      const outsider = await registerUser(app, 'Outsider');
      await http().get(`/api/v1/organizations/${orgId}/billing`).set('Cookie', outsider.cookie).expect(404);
      const adminMember = await addMember(app, owner, orgId, 'admin', 'Admin');
      await http().get(`/api/v1/organizations/${orgId}/billing`).set('Cookie', adminMember.cookie).expect(200);
      await http().post(`/api/v1/organizations/${orgId}/billing/checkout`).set('Cookie', adminMember.cookie).send({ planCode: 'starter' }).expect(403);
    });

    it('seat limit is hard: members plus open invitations, server-side', async () => {
      // owner + analyst + admin = 3 of 5.
      await http().post(`/api/v1/organizations/${orgId}/invitations`).set('Cookie', owner.cookie).send({ email: `a-${randomUUID()}@example.test`, role: 'analyst' }).expect(201);
      await http().post(`/api/v1/organizations/${orgId}/invitations`).set('Cookie', owner.cookie).send({ email: `b-${randomUUID()}@example.test`, role: 'analyst' }).expect(201);
      const r = await http().post(`/api/v1/organizations/${orgId}/invitations`).set('Cookie', owner.cookie).send({ email: `c-${randomUUID()}@example.test`, role: 'analyst' }).expect(402);
      expect(r.body.error).toMatchObject({ code: 'quota_exceeded' });
      expect(r.body.error.message).toMatch(/5 of 5 members/);
    });
  });

  describe('concurrency and the usage ledger', () => {
    let org2: string;
    beforeAll(async () => { org2 = await createOrg(app, owner, 'Concurrency Org'); });

    it('concurrent project creation cannot exceed a hard limit', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        http().post(`/api/v1/organizations/${org2}/projects`).set('Cookie', owner.cookie).send({ name: `Proyek ${i}` })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);         // trial: 3 projects
      expect(results.filter((r) => r.status === 402)).toHaveLength(5);
      expect((await owner_db.query('SELECT count(*)::int AS n FROM projects WHERE tenant_id = $1', [org2])).rows[0].n).toBe(3);
    });

    it('the same idempotency key is counted once, however often it is replayed', async () => {
      for (let i = 0; i < 3; i++) {
        await db.withTenant(org2, SYS, (c) => consume(c, org2, { metric: 'exports', quantity: 2, idempotencyKey: 'job:dup-1', source: 'test' }));
      }
      const rows = (await owner_db.query(`SELECT count(*)::int AS n, sum(quantity)::int AS q FROM usage_records WHERE tenant_id = $1 AND metric = 'exports'`, [org2])).rows[0];
      expect(rows).toEqual({ n: 1, q: 2 });
    });

    it('concurrent consumption with enforcement stops exactly at the hard limit, and aggregates match the ledger', async () => {
      await asAdmin('post', `/tenants/${org2}/overrides`).send({ metric: 'reports_generated', limit: 10, enforcement: 'hard', reason: REASON }).expect(201);
      const out = await Promise.all(Array.from({ length: 25 }, (_, i) => db.withTenant(org2, SYS, (c) =>
        consume(c, org2, { metric: 'reports_generated', quantity: 1, idempotencyKey: `conc:${i}`, source: 'test' }, { enforce: true }))));
      expect(out.filter((r) => r.recorded)).toHaveLength(10);
      expect(out.filter((r) => !r.recorded && r.decision.behaviour === 'blocked')).toHaveLength(15);
      const ledger = (await owner_db.query(`SELECT coalesce(sum(quantity), 0)::int AS q FROM usage_records WHERE tenant_id = $1 AND metric = 'reports_generated'`, [org2])).rows[0].q;
      const total = (await owner_db.query(`SELECT sum(quantity)::int AS q FROM usage_period_totals WHERE tenant_id = $1 AND metric = 'reports_generated'`, [org2])).rows[0].q;
      const daily = (await owner_db.query(`SELECT sum(quantity)::int AS q FROM usage_daily WHERE tenant_id = $1 AND metric = 'reports_generated'`, [org2])).rows[0].q;
      expect([ledger, total, daily]).toEqual([10, 10, 10]);
    });

    it('threshold notices fire once each at 70/85/95/100% of the period', async () => {
      const n = (await owner_db.query(`SELECT threshold FROM usage_notices WHERE tenant_id = $1 AND metric = 'reports_generated' ORDER BY threshold`, [org2])).rows.map((r) => r.threshold);
      expect(n).toEqual([70, 85, 95, 100]);
      // More blocked attempts do not duplicate notices.
      await db.withTenant(org2, SYS, (c) => consume(c, org2, { metric: 'reports_generated', quantity: 1, idempotencyKey: 'conc:extra', source: 'test' }, { enforce: true }));
      expect((await owner_db.query(`SELECT count(*)::int AS n FROM usage_notices WHERE tenant_id = $1 AND metric = 'reports_generated'`, [org2])).rows[0].n).toBe(4);
      const b = (await http().get(`/api/v1/organizations/${org2}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b.notices.map((x: { threshold: number }) => x.threshold).sort()).toEqual([100, 70, 85, 95]);
      expect(b.usage.find((u: { metric: string }) => u.metric === 'reports_generated')).toMatchObject({ used: 10, limit: 10, remaining: 0, atLimit: true, source: 'override' });
    });

    it('soft limits record overage instead of blocking; work already done is always recorded', async () => {
      await asAdmin('post', `/tenants/${org2}/overrides`).send({ metric: 'exports', limit: 3, enforcement: 'soft', reason: REASON }).expect(201);
      const r = await db.withTenant(org2, SYS, (c) => consume(c, org2, { metric: 'exports', quantity: 5, idempotencyKey: 'soft:1', source: 'test' }, { enforce: true }));
      expect(r).toMatchObject({ recorded: true, decision: { behaviour: 'soft_overage', overage: true } });
      // Without enforcement (e.g. records already fetched) usage is recorded even past a hard limit.
      const h = await db.withTenant(org2, SYS, (c) => consume(c, org2, { metric: 'reports_generated', quantity: 2, idempotencyKey: 'done:1', source: 'test' }));
      expect(h).toMatchObject({ recorded: true, decision: { overage: true } });
    });

    it('late events land in the usage period they occurred in', async () => {
      const ent = await db.withTenant(org2, SYS, (c) => loadEntitlements(c, org2));
      const before = new Date(ent.period.start.getTime() - 3_600_000);
      await db.withTenant(org2, SYS, (c) => consume(c, org2, { metric: 'ai_tokens', quantity: 500, idempotencyKey: 'late:1', source: 'test', occurredAt: before }));
      const row = (await owner_db.query(`SELECT usage_period_start FROM usage_records WHERE tenant_id = $1 AND idempotency_key = 'late:1'`, [org2])).rows[0];
      expect(row.usage_period_start.getTime()).toBeLessThan(ent.period.start.getTime());
      const cur = (await http().get(`/api/v1/organizations/${org2}/billing`).set('Cookie', owner.cookie).expect(200)).body.usage.find((u: { metric: string }) => u.metric === 'ai_tokens');
      expect(cur.used).toBe(0);
    });

    it('corrections are new traceable rows; reconciliation repairs drifted aggregates from the ledger', async () => {
      const orig = (await owner_db.query(`SELECT id, quantity FROM usage_records WHERE tenant_id = $1 AND idempotency_key = 'soft:1'`, [org2])).rows[0];
      await asAdmin('post', `/tenants/${org2}/usage/corrections`).send({ recordId: String(orig.id), quantity: -2, reason: 'no' }).expect(400);         // reason required
      await asAdmin('post', `/tenants/${org2}/usage/corrections`).send({ recordId: String(orig.id), quantity: -9, reason: 'duplicate export counted' }).expect(400); // below zero
      const c = (await asAdmin('post', `/tenants/${org2}/usage/corrections`).send({ recordId: String(orig.id), quantity: -2, reason: 'duplicate export counted' }).expect(201)).body;
      expect(Number(c.quantity)).toBe(-2);
      const after = (await owner_db.query(`SELECT quantity, kind FROM usage_records WHERE id = $1`, [orig.id])).rows[0];
      expect(after).toEqual({ quantity: orig.quantity, kind: 'usage' });                      // original untouched
      const corr = (await owner_db.query(`SELECT kind, corrects_id, reason, recorded_by FROM usage_records WHERE tenant_id = $1 AND kind = 'correction'`, [org2])).rows;
      expect(corr).toEqual([{ kind: 'correction', corrects_id: orig.id, reason: 'duplicate export counted', recorded_by: admin.id }]);
      // The application role cannot rewrite the ledger.
      const app_db = new Client({ connectionString: OWNER_URL.replace(/\/\/[^@]*@/, '//civicsignal_app:test-app-password@') }); await app_db.connect();
      await expect(app_db.query(`UPDATE usage_records SET quantity = 0 WHERE id = $1`, [orig.id])).rejects.toThrow(/permission denied/);
      await expect(app_db.query(`DELETE FROM usage_records WHERE id = $1`, [orig.id])).rejects.toThrow(/permission denied/);
      await app_db.end();
      // Drift (e.g. a manual edit) is detected and repaired from the ledger.
      await owner_db.query(`UPDATE usage_period_totals SET quantity = 999 WHERE tenant_id = $1 AND metric = 'exports'`, [org2]);
      const rec = (await asAdmin('post', `/tenants/${org2}/usage/reconcile`).send({ reason: REASON }).expect(200)).body;
      expect(rec.periodRowsFixed).toBe(1);
      const total = (await owner_db.query(`SELECT sum(quantity)::int AS q FROM usage_period_totals WHERE tenant_id = $1 AND metric = 'exports'`, [org2])).rows[0].q;
      expect(total).toBe(2 + 5 - 2);
      const audit = (await owner_db.query(`SELECT action, metadata->>'reason' AS reason FROM audit_events WHERE tenant_id = $1 AND action LIKE 'commercial.usage_%' ORDER BY id`, [org2])).rows;
      expect(audit.map((a) => a.action)).toEqual(['commercial.usage_corrected', 'commercial.usage_reconciled']);
    });
  });

  describe('collection under plan limits', () => {
    let ing: INestApplication; let srv: FeedServer; let pipeline: IngestionPipeline; let o: string; let sourceId: string; let items = 2;
    const feed = () => rss(Array.from({ length: items }, (_, i) => ({ title: `Banjir di Kota Contoh bagian ${i}`, link: `https://news.example/banjir/${i}`, description: 'Hujan deras.' })));
    beforeAll(async () => {
      srv = await new FeedServer().start();
      srv.xml('/feed.xml', feed, () => `"v${items}"`);
      ing = await testApp({ INGESTION_ALLOW_PRIVATE_HOSTS: 'true', BILLING_PROVIDER: 'test', BILLING_TEST_WEBHOOK_SECRET: SECRET });
      pipeline = ing.get(IngestionPipeline);
      o = await createOrg(ing, owner, 'Collection Limit Org');
      const h = () => request(ing.getHttpServer());
      const p = (await h().post(`/api/v1/organizations/${o}/projects`).set('Cookie', owner.cookie).send({ name: 'Bencana' }).expect(201)).body.id;
      await h().post(`/api/v1/organizations/${o}/projects/${p}/queries`).set('Cookie', owner.cookie).send({ name: 'Banjir', keywords: ['banjir'] }).expect(201);
      sourceId = (await h().post(`/api/v1/organizations/${o}/sources`).set('Cookie', owner.cookie).send({ kind: 'feed', name: 'Synthetic', feedUrl: srv.url('/feed.xml'),
        authorizationStatus: 'authorized', authorizationBasis: 'Synthetic test feed', permittedFields: ['title', 'url', 'published_at', 'excerpt'] }).expect(201)).body.id;
      await asAdmin('post', `/tenants/${o}/overrides`).send({ metric: 'mentions_ingested', limit: 3, enforcement: 'hard', reason: REASON }).expect(201);
    });
    afterAll(async () => { await ing.close(); await srv.close(); });
    const run = (key: string) => pipeline.run({ tenantId: o, sourceId, trigger: 'manual', idempotencyKey: key, requestedBy: owner.id }, 1, true);
    const stored = async () => (await owner_db.query('SELECT count(*)::int AS n FROM mentions WHERE tenant_id = $1', [o])).rows[0].n;
    const metered = async () => (await owner_db.query(`SELECT coalesce(sum(quantity), 0)::int AS q FROM usage_records WHERE tenant_id = $1 AND metric = 'mentions_ingested'`, [o])).rows[0].q;

    it('meters stored records once per run, and keeps everything a permitted run fetched', async () => {
      expect((await run('lim-1')).status).toBe('succeeded');
      expect([await stored(), await metered()]).toEqual([2, 2]);
      expect((await run('lim-1')).status).toBe('already_succeeded');                // redelivered job: no double count
      expect(await metered()).toBe(2);
      items = 5;                                                                    // 3 new records; only 1 left in the quota
      expect((await run('lim-2')).status).toBe('succeeded');
      expect([await stored(), await metered()]).toEqual([5, 5]);                    // nothing discarded; overage recorded
      const over = (await owner_db.query(`SELECT metadata->>'overage' AS o FROM usage_records WHERE tenant_id = $1 AND metric = 'mentions_ingested' ORDER BY id DESC LIMIT 1`, [o])).rows[0].o;
      expect(over).toBe('true');
    });

    it('a hard limit pauses new collection without touching collected data', async () => {
      items = 7;
      const r = await run('lim-3');
      expect(r).toMatchObject({ status: 'skipped_commercial', reason: expect.stringMatching(/Plan limit reached/) });
      expect([await stored(), await metered()]).toEqual([5, 5]);
      // Lifting the limit (operator override) resumes collection.
      await asAdmin('post', `/tenants/${o}/overrides`).send({ metric: 'mentions_ingested', limit: 100, enforcement: 'hard', reason: REASON }).expect(201);
      expect((await run('lim-4')).status).toBe('succeeded');
      expect(await stored()).toBe(7);
    });
  });

  describe('lifecycle jobs', () => {
    it('an expired trial makes the organization read-only without deleting or hiding anything', async () => {
      const o = await createOrg(app, owner, 'Trial Expiry Org');
      const p = (await http().post(`/api/v1/organizations/${o}/projects`).set('Cookie', owner.cookie).send({ name: 'Kept project' }).expect(201)).body;
      const r = await commercialTick(db, config, new Date(Date.now() + 15 * 86_400_000));
      expect(r.trialsExpired).toBeGreaterThanOrEqual(1);
      const b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b.subscription).toBeNull();                                         // ended subscriptions are history
      const e = (await http().get(`/api/v1/organizations/${o}/entitlements`).set('Cookie', owner.cookie).expect(200)).body;
      expect(e).toMatchObject({ status: 'none', access: 'read_only' });
      const blocked = await http().post(`/api/v1/organizations/${o}/projects`).set('Cookie', owner.cookie).send({ name: 'New' }).expect(402);
      expect(blocked.body.error.code).toBe('subscription_inactive');
      // Reading, audit and data governance keep working.
      await http().get(`/api/v1/organizations/${o}/projects/${p.id}`).set('Cookie', owner.cookie).expect(200);
      await http().get(`/api/v1/organizations/${o}/audit-events`).set('Cookie', owner.cookie).expect(200);
      await http().get(`/api/v1/organizations/${o}/data-governance`).set('Cookie', owner.cookie).expect(200);
      const hist = (await owner_db.query(`SELECT event, from_status, to_status FROM subscription_events WHERE tenant_id = $1 ORDER BY id`, [o])).rows;
      expect(hist).toEqual([{ event: 'trial_started', from_status: null, to_status: 'trialing' }, { event: 'trial_expired', from_status: 'trialing', to_status: 'expired' }]);
      // A second tick does nothing more (idempotent).
      await commercialTick(db, config, new Date(Date.now() + 15 * 86_400_000));
      expect((await owner_db.query(`SELECT count(*)::int AS n FROM subscription_events WHERE tenant_id = $1`, [o])).rows[0].n).toBe(2);
    });

    it('contract billing: overdue invoice → past due → grace → suspended; manual reconciliation restores access', async () => {
      const o = await createOrg(app, owner, 'Pemerintah Kota Uji');
      const today = new Date().toISOString().slice(0, 10);
      const year = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
      const k = (await asAdmin('post', `/tenants/${o}/contracts`).send({ customerName: 'Pemkot Uji', contractReference: 'SPK-001/2026', poReference: 'PO-77', planCode: 'government',
        startDate: today, endDate: year, billingFrequency: 'annual', paymentTermsDays: 30, contractValue: 120000000, currency: 'IDR', activation: 'active', reason: REASON }).expect(201)).body;
      let b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b.subscription).toMatchObject({ status: 'active', billingMode: 'contract' });
      expect(b.contract).toMatchObject({ contract_reference: 'SPK-001/2026', po_reference: 'PO-77' });
      expect(b.actions).toMatchObject({ cancelAtPeriodEnd: false, checkout: false, contactSales: true });     // no payment details for contract customers
      // Customer cannot cancel a contract themselves.
      await http().post(`/api/v1/organizations/${o}/billing/cancel`).set('Cookie', owner.cookie).expect(409);
      const inv = (await asAdmin('post', `/tenants/${o}/invoices`).send({ reason: REASON, invoice: { currency: 'IDR', contractId: k.id, poReference: 'PO-77',
        lines: [{ description: 'Langganan tahunan CivicSignal', quantity: 1, unitAmount: 100000000 }], taxAmount: 11000000, billTo: { name: 'Pemkot Uji', taxId: '01.234.567.8-901.000' },
        idempotencyKey: 'inv-key-0001' } }).expect(201)).body;
      // Draft invoices are internal; idempotent creation.
      expect((await asAdmin('post', `/tenants/${o}/invoices`).send({ reason: REASON, invoice: { currency: 'IDR', lines: [{ description: 'x', quantity: 1, unitAmount: 1 }], billTo: { name: 'x' }, idempotencyKey: 'inv-key-0001' } }).expect(201)).body)
        .toEqual({ id: inv.id, created: false });
      expect((await http().get(`/api/v1/organizations/${o}/billing/invoices`).set('Cookie', owner.cookie).expect(200)).body.invoices).toHaveLength(0);
      await http().get(`/api/v1/organizations/${o}/billing/invoices/${inv.id}`).set('Cookie', owner.cookie).expect(404);
      const issued = (await asAdmin('post', `/tenants/${o}/invoices/${inv.id}/issue`).send({ dueDays: 0, reason: REASON }).expect(200)).body;
      expect(issued).toMatchObject({ status: 'issued', total: 111000000, notice: expect.stringMatching(/not a Faktur Pajak/) });
      expect(issued.number).toMatch(/^INV-\d{4}-\d{6}$/);
      await asAdmin('post', `/tenants/${o}/invoices/${inv.id}/issue`).send({ dueDays: 0, reason: REASON }).expect(409);           // only drafts can be issued
      const seen = (await http().get(`/api/v1/organizations/${o}/billing/invoices/${inv.id}`).set('Cookie', owner.cookie).expect(200)).body;
      expect(seen).toMatchObject({ number: issued.number, lines: [{ description: 'Langganan tahunan CivicSignal', amount: 100000000 }], balance: 111000000 });

      const t1 = new Date(Date.now() + 86_400_000);
      expect((await commercialTick(db, config, t1)).invoicesOverdue).toBeGreaterThanOrEqual(1);
      b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b.subscription).toMatchObject({ status: 'past_due', access: 'full' });                          // grace: still usable
      await commercialTick(db, config, new Date(Date.now() + 62 * 86_400_000));                              // government grace is 60 days
      b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b.subscription).toMatchObject({ status: 'suspended', access: 'read_only', suspendedReason: 'past_due_grace_elapsed' });

      const pay = (body: object) => asAdmin('post', `/tenants/${o}/invoices/${inv.id}/payments`).send({ reason: REASON, payment: { method: 'government_treasury', receivedAt: new Date().toISOString(), ...body } });
      await pay({ amount: 200000000, reference: 'SP2D-1' }).expect(400);                                    // overpayment
      // A partial payment on an overdue invoice keeps it overdue (it does not restart the dunning clock) (QA-BL-07).
      expect((await pay({ amount: 50000000, reference: 'SP2D-1' }).expect(201)).body.invoice).toMatchObject({ status: 'overdue', amountPaid: 50000000 });
      expect((await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body.subscription.status).toBe('suspended');
      await pay({ amount: 50000000, reference: 'SP2D-1' }).expect(409);                                     // same remittance twice
      expect((await pay({ amount: 61000000, reference: 'SP2D-2' }).expect(201)).body.invoice).toMatchObject({ status: 'paid', balance: 0 });
      b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b.subscription).toMatchObject({ status: 'active', access: 'full' });
      await asAdmin('post', `/tenants/${o}/invoices/${inv.id}/void`).send({ reason: REASON }).expect(409);  // paid invoices cannot be voided
      const audit = (await owner_db.query(`SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE 'commercial.%' ORDER BY id`, [o])).rows.map((r) => r.action);
      expect(audit).toEqual(expect.arrayContaining(['commercial.contract_created', 'commercial.invoice_drafted', 'commercial.invoice_issued', 'commercial.payment_recorded']));
      const ev = (await owner_db.query(`SELECT event FROM subscription_events WHERE tenant_id = $1 ORDER BY id`, [o])).rows.map((r) => r.event);
      expect(ev).toEqual(['trial_started', 'plan_assigned', 'payment_failed', 'suspend', 'payment_recovered']);
    });

    it('a scheduled downgrade applies at its time; cancel-at-period-end ends the subscription', async () => {
      const o = await createOrg(app, owner, 'Downgrade Org');
      await asAdmin('post', `/tenants/${o}/subscription/assign`).send({ planCode: 'professional', billingMode: 'manual', status: 'active', reason: REASON }).expect(201);
      await asAdmin('post', `/tenants/${o}/subscription/change-plan`).send({ planCode: 'starter', when: 'period_end', reason: REASON }).expect(200);
      let b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b).toMatchObject({ plan: { code: 'professional' }, subscription: { scheduledChange: { plan: { code: 'starter' } } } });
      await commercialTick(db, config, new Date(Date.now() + 32 * 86_400_000));
      b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b).toMatchObject({ plan: { code: 'starter' }, subscription: { status: 'active', scheduledChange: null } });
      expect(new Date(b.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 32 * 86_400_000);   // rolled forward
      await asAdmin('post', `/tenants/${o}/subscription/cancel-at-period-end`).send({ value: true, reason: REASON }).expect(200);
      await commercialTick(db, config, new Date(Date.now() + 70 * 86_400_000));
      expect((await http().get(`/api/v1/organizations/${o}/entitlements`).set('Cookie', owner.cookie).expect(200)).body).toMatchObject({ status: 'none', access: 'read_only' });
    });

    it('invalid transitions are refused server-side', async () => {
      const o = await createOrg(app, owner, 'Transitions Org');
      const r = await asAdmin('post', `/tenants/${o}/subscription/transition`).send({ event: 'reinstate', reason: REASON }).expect(409);
      expect(r.body.error.code).toBe('invalid_transition');
      await asAdmin('post', `/tenants/${o}/subscription/transition`).send({ event: 'suspend', reason: REASON }).expect(200);
      await asAdmin('post', `/tenants/${o}/subscription/transition`).send({ event: 'reinstate', reason: REASON }).expect(200);
    });
  });

  describe('payment provider boundary', () => {
    const send = (body: object, opts: { secret?: string; at?: number } = {}) => {
      const raw = JSON.stringify(body);
      return http().post('/api/v1/billing/webhooks/test').set('Content-Type', 'application/json')
        .set(TEST_SIGNATURE_HEADER, signTestPayload(opts.secret ?? SECRET, raw, opts.at)).send(raw);
    };
    const period = () => ({ period_start: new Date().toISOString(), period_end: new Date(Date.now() + 30 * 86_400_000).toISOString() });

    it('without a provider, checkout and portal answer 503 and nothing changes', async () => {
      const u = await registerUser(none, 'NoPay');
      const o = (await request(none.getHttpServer()).post('/api/v1/organizations').set('Cookie', u.cookie).send({ name: 'No Provider Org' }).expect(201)).body.id;
      const r = await request(none.getHttpServer()).post(`/api/v1/organizations/${o}/billing/checkout`).set('Cookie', u.cookie).send({ planCode: 'starter' }).expect(503);
      expect(r.body.error.code).toBe('billing_provider_not_configured');
      await request(none.getHttpServer()).post(`/api/v1/organizations/${o}/billing/portal`).set('Cookie', u.cookie).expect(503);
      await request(none.getHttpServer()).post('/api/v1/billing/webhooks/none').send({}).expect(404);
      const b = (await request(none.getHttpServer()).get(`/api/v1/organizations/${o}/billing`).set('Cookie', u.cookie).expect(200)).body;
      expect(b.payments).toEqual({ name: 'none', configured: false, live: false, onlinePayments: 'not_configured' });
      expect(b.subscription.status).toBe('trialing');
    });

    it('a plan without a list price cannot be bought online', async () => {
      const r = await http().post(`/api/v1/organizations/${orgId}/billing/checkout`).set('Cookie', owner.cookie).send({ planCode: 'starter' }).expect(409);
      expect(r.body.error.code).toBe('contact_sales');
    });

    it('checkout activates only on a verified provider event; replays and forgeries have no effect', async () => {
      const o = await createOrg(app, owner, 'Self Service Org');
      await asAdmin('post', '/plans/starter/versions').send({ reason: REASON, version: { currency: 'IDR', priceAmount: 1500000, billingInterval: 'month', trialDays: 14,
        features: { ai_analysis: true, scheduled_reports: true }, quotas: { seats: { limit: 3, enforcement: 'hard' }, projects: { limit: 2, enforcement: 'hard' } }, settings: { past_due_grace_days: 7 } } }).expect(201);
      const co = (await http().post(`/api/v1/organizations/${o}/billing/checkout`).set('Cookie', owner.cookie).send({ planCode: 'starter' }).expect(200)).body;
      expect(co.url).toMatch(/test-checkout\?session=test_cs_/);
      const session = new URL(co.url).searchParams.get('session')!;
      // Returning from checkout proves nothing.
      expect((await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body.subscription.status).toBe('trialing');
      const evt = { id: `evt_${randomUUID()}`, type: 'checkout.completed', created_at: new Date().toISOString(), data: { session, customer: 'cus_1', subscription: `sub_${randomUUID()}`, ...period() } };
      await send(evt, { secret: 'wrong-secret-0123456789abcdefghij' }).expect(400);
      await send(evt, { at: Math.floor(Date.now() / 1000) - 3600 }).expect(400);                               // stale timestamp
      await http().post('/api/v1/billing/webhooks/test').set('Content-Type', 'application/json').send(evt).expect(400);   // unsigned
      expect((await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body.subscription.status).toBe('trialing');
      expect((await send(evt).expect(200)).body).toEqual({ received: true, status: 'processed' });
      expect((await send(evt).expect(200)).body).toEqual({ received: true, status: 'duplicate' });              // replay
      const b = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(b).toMatchObject({ plan: { code: 'starter', price: { amount: 1500000, currency: 'IDR' } }, subscription: { status: 'active', billingMode: 'self_service', paymentMethodOnFile: true } });
      const rejected = (await owner_db.query(`SELECT status, signature_valid, payload FROM billing_webhook_events WHERE status = 'rejected'`)).rows;
      expect(rejected.length).toBeGreaterThanOrEqual(3);
      expect(rejected.every((r) => r.payload === null && r.signature_valid === false)).toBe(true);
      // Payment failure → past due; paid invoice → active, mirrored as a provider invoice with its payment.
      const subRef = evt.data.subscription;
      await send({ id: `evt_${randomUUID()}`, type: 'invoice.payment_failed', created_at: new Date().toISOString(), data: { subscription: subRef, invoice: 'in_1', amount: 1500000, currency: 'IDR' } }).expect(200);
      expect((await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body.subscription.status).toBe('past_due');
      await send({ id: `evt_${randomUUID()}`, type: 'invoice.paid', created_at: new Date().toISOString(), data: { subscription: subRef, invoice: 'in_1', payment: 'py_1', amount: 1500000, currency: 'IDR', ...period() } }).expect(200);
      const after = (await http().get(`/api/v1/organizations/${o}/billing`).set('Cookie', owner.cookie).expect(200)).body;
      expect(after.subscription.status).toBe('active');
      const invs = (await http().get(`/api/v1/organizations/${o}/billing/invoices`).set('Cookie', owner.cookie).expect(200)).body.invoices;
      expect(invs).toEqual([expect.objectContaining({ source: 'provider', status: 'paid', total: 1500000, amountPaid: 1500000 })]);
      // An unknown session may simply not be committed yet: the event fails retryably (5xx) and is kept for redelivery,
      // instead of being acknowledged and lost (QA-BL-13). Unknown event types are acknowledged and ignored.
      const unknownId = `evt_${randomUUID()}`;
      await send({ id: unknownId, type: 'checkout.completed', created_at: new Date().toISOString(), data: { session: 'test_cs_unknown', customer: 'c', subscription: 's', ...period() } }).expect(500);
      expect((await owner_db.query(`SELECT status FROM billing_webhook_events WHERE event_id = $1`, [unknownId])).rows[0].status).toBe('failed');
      expect((await send({ id: `evt_${randomUUID()}`, type: 'customer.updated', created_at: new Date().toISOString(), data: {} }).expect(200)).body.status).toBe('ignored');
      // Customer cancel goes to the provider first, then is scheduled for period end.
      expect((await http().post(`/api/v1/organizations/${o}/billing/cancel`).set('Cookie', owner.cookie).expect(200)).body).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
      expect((await http().post(`/api/v1/organizations/${o}/billing/resume`).set('Cookie', owner.cookie).expect(200)).body).toMatchObject({ cancelAtPeriodEnd: false });
    });

    it('a new plan version does not change existing subscriptions', async () => {
      const plans = (await asAdmin('get', '/plans').expect(200)).body.plans;
      const starter = plans.find((p: { code: string }) => p.code === 'starter');
      expect(starter.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(starter.versions[1].effectiveTo).not.toBeNull();
      const old = (await owner_db.query(`SELECT count(*)::int AS n FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id WHERE pv.version = 1 AND s.plan_code = 'trial' AND s.ended_at IS NULL`)).rows[0].n;
      expect(old).toBeGreaterThan(0);
      // The application role cannot alter a version's terms.
      const app_db = new Client({ connectionString: OWNER_URL.replace(/\/\/[^@]*@/, '//civicsignal_app:test-app-password@') }); await app_db.connect();
      await expect(app_db.query(`UPDATE plan_versions SET price_amount = 1`)).rejects.toThrow(/permission denied/);
      await app_db.end();
    });
  });

  describe('platform administration', () => {
    it('tenant owners and admins never reach platform commercial routes; operators need a reason', async () => {
      for (const path of ['/plans', '/tenants', `/tenants/${orgId}`, '/health', '/costs', '/audit', '/invoices']) {
        await http().get(`/api/v1/platform/commercial${path}`).set('Cookie', owner.cookie).expect(403);
      }
      await http().post(`/api/v1/platform/commercial/tenants/${orgId}/overrides`).set('Cookie', owner.cookie).send({ metric: 'seats', limit: 1000, enforcement: 'hard', reason: REASON }).expect(403);
      await http().get('/api/v1/platform/commercial/plans').expect(401);
      const r = await asAdmin('post', `/tenants/${orgId}/overrides`).send({ metric: 'seats', limit: 50, enforcement: 'hard' }).expect(400);
      expect(r.body.error.details[0].path).toBe('reason');
      await asAdmin('post', `/tenants/${orgId}/subscription/transition`).send({ event: 'activate' }).expect(400);
      // Customers cannot set privileged subscription states: there is no tenant route for it.
      await http().post(`/api/v1/organizations/${orgId}/billing/activate`).set('Cookie', owner.cookie).send({}).expect(404);
    });

    it('health, costs and audit are available to operators without tenant content or secrets', async () => {
      const h = (await asAdmin('get', '/health').expect(200)).body;
      expect(h.provider).toEqual({ name: 'test', configured: true, live: false });
      expect(h.failedWebhooks.length).toBeGreaterThan(0);
      const costs = (await asAdmin('get', '/costs').expect(200)).body;
      expect(costs.tenants.find((t: { tenantId: string }) => t.tenantId === orgId)).toMatchObject({ margin: { amount: null, basis: 'no_revenue_recorded' } });
      await asAdmin('post', '/costs/entries').send({ tenantId: orgId, provider: 'anthropic', service: 'messages', periodStart: '2026-10-01', periodEnd: '2026-10-31', amount: 12.5, currency: 'USD',
        sourceReference: 'provider invoice INV-TEST-1', reason: REASON }).expect(201);
      const a = (await asAdmin('get', '/audit').expect(200)).body.events;
      expect(a.length).toBeGreaterThan(0);
      expect(a.every((e: { action: string }) => e.action.startsWith('commercial.'))).toBe(true);
      const all = JSON.stringify([h, costs, a, (await asAdmin('get', '/plans').expect(200)).body, (await asAdmin('get', `/tenants/${orgId}`).expect(200)).body]);
      expect(all).not.toContain(SECRET);
      const tenantView = JSON.stringify((await http().get(`/api/v1/organizations/${orgId}/billing`).set('Cookie', owner.cookie).expect(200)).body);
      expect(tenantView).not.toContain(SECRET);
      expect(tenantView).not.toMatch(/margin|actualCost/);
    });
  });

  describe('tenant isolation', () => {
    it('one organization cannot read another organization\'s invoices, notices or onboarding', async () => {
      const intruder = await registerUser(app, 'Intruder');
      const theirs = await createOrg(app, intruder, 'Other Org');
      const inv = (await owner_db.query(`SELECT id FROM invoices WHERE status <> 'draft' LIMIT 1`)).rows[0].id;
      await http().get(`/api/v1/organizations/${theirs}/billing/invoices/${inv}`).set('Cookie', intruder.cookie).expect(404);
      expect((await http().get(`/api/v1/organizations/${theirs}/billing/invoices`).set('Cookie', intruder.cookie).expect(200)).body.invoices).toEqual([]);
      const notice = (await owner_db.query(`SELECT id FROM usage_notices LIMIT 1`)).rows[0].id;
      await http().post(`/api/v1/organizations/${theirs}/billing/notices/${notice}/acknowledge`).set('Cookie', intruder.cookie).expect(404);
      await http().get(`/api/v1/organizations/${orgId}/onboarding`).set('Cookie', intruder.cookie).expect(404);
    });
  });

  describe('onboarding', () => {
    it('progress is persisted, resumable and derived from real setup', async () => {
      const o = await createOrg(app, owner, 'Onboarding Org');
      let s = (await http().get(`/api/v1/organizations/${o}/onboarding`).set('Cookie', owner.cookie).expect(200)).body;
      expect(s).toMatchObject({ path: 'self_service', complete: false, nextStep: 'invite' });
      expect(s.steps.find((x: { key: string }) => x.key === 'organization')).toMatchObject({ status: 'done', derived: true });
      await http().put(`/api/v1/organizations/${o}/onboarding/steps/project`).set('Cookie', owner.cookie).send({ status: 'skipped' }).expect(409);   // not skippable
      await http().put(`/api/v1/organizations/${o}/onboarding/steps/project`).set('Cookie', owner.cookie).send({ status: 'done' }).expect(409);      // derived from data
      await http().put(`/api/v1/organizations/${o}/onboarding/steps/invite`).set('Cookie', owner.cookie).send({ status: 'skipped' }).expect(200);
      await http().put(`/api/v1/organizations/${o}/onboarding/steps/usage_review`).set('Cookie', owner.cookie).send({ status: 'done' }).expect(200);
      await http().post(`/api/v1/organizations/${o}/projects`).set('Cookie', owner.cookie).send({ name: 'Proyek Pertama' }).expect(201);
      s = (await http().get(`/api/v1/organizations/${o}/onboarding`).set('Cookie', owner.cookie).expect(200)).body;
      const st = Object.fromEntries(s.steps.map((x: { key: string; status: string }) => [x.key, x.status]));
      expect(st).toMatchObject({ invite: 'skipped', usage_review: 'done', project: 'done', keywords: 'todo' });
      expect(s.nextStep).toBe('plan');
      const analyst = await addMember(app, owner, o, 'analyst', 'Onb Analyst');
      await http().get(`/api/v1/organizations/${o}/onboarding`).set('Cookie', analyst.cookie).expect(200);
      await http().put(`/api/v1/organizations/${o}/onboarding/steps/alerts`).set('Cookie', analyst.cookie).send({ status: 'skipped' }).expect(403);
      // A sales-assisted (contract) organization is never asked for payment details.
      await asAdmin('post', `/tenants/${o}/subscription/assign`).send({ planCode: 'enterprise', billingMode: 'contract', status: 'pending_activation', reason: REASON }).expect(201);
      s = (await http().get(`/api/v1/organizations/${o}/onboarding`).set('Cookie', owner.cookie).expect(200)).body;
      expect(s.path).toBe('sales_assisted');
      expect(s.steps.find((x: { key: string }) => x.key === 'plan').status).toBe('done');
      // Pending activation: setup allowed, metered work not yet.
      await http().post(`/api/v1/organizations/${o}/projects`).set('Cookie', owner.cookie).send({ name: 'Setup project' }).expect(201);
    });

    it('sales requests are stored, audited and visible to operators', async () => {
      const r = (await http().post(`/api/v1/organizations/${orgId}/billing/sales-requests`).set('Cookie', owner.cookie)
        .send({ kind: 'quote', planCode: 'government', message: 'Mohon penawaran untuk 30 pengguna.' }).expect(201)).body;
      expect(r).toMatchObject({ kind: 'quote', status: 'open', delivery: 'stored' });
      const list = (await asAdmin('get', '/sales-requests').expect(200)).body.requests;
      expect(list.find((x: { id: string }) => x.id === r.id)).toMatchObject({ tenant_id: orgId, message: 'Mohon penawaran untuk 30 pengguna.' });
      await asAdmin('patch', `/sales-requests/${r.id}`).send({ status: 'in_progress', note: 'Called the customer' }).expect(200);
      expect((await http().get(`/api/v1/organizations/${orgId}/billing/sales-requests`).set('Cookie', owner.cookie).expect(200)).body.requests[0]).toMatchObject({ status: 'in_progress' });
    });
  });
});
