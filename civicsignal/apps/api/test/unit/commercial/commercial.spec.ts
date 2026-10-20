import { loadConfig } from '../../../src/config';
import { NoBillingProvider, signTestPayload, TestBillingProvider, TEST_SIGNATURE_HEADER, WebhookRejected } from '../../../src/commercial/billing-provider';
import { FEATURE_KEYS, METRIC_KEYS, NEVER_BLOCKED, PlanVersionInput } from '../../../src/commercial/catalog';
import { accessFor, allowedEvents, nextStatus, type SubStatus } from '../../../src/commercial/lifecycle';
import { addMonths, usagePeriod } from '../../../src/commercial/periods';
import { decide, type Entitlements } from '../../../src/commercial/quota';

const ent = (quotas: Partial<Entitlements['quotas']>): Entitlements => ({
  tenantId: 't', subscription: null, access: 'full', settings: {}, timezone: 'Asia/Jakarta', period: { start: new Date(0), end: new Date(1) },
  features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Entitlements['features'],
  quotas: { ...Object.fromEntries(METRIC_KEYS.map((m) => [m, { limit: null, enforcement: 'none', overage: 'allow', source: 'not_in_plan' }])), ...quotas } as Entitlements['quotas'],
});

describe('subscription state machine', () => {
  it('allows only the documented transitions', () => {
    expect(nextStatus('trialing', 'activate')).toBe('active');
    expect(nextStatus('trialing', 'trial_expired')).toBe('expired');
    expect(nextStatus('active', 'payment_failed')).toBe('past_due');
    expect(nextStatus('past_due', 'suspend')).toBe('suspended');
    expect(nextStatus('suspended', 'payment_recovered')).toBe('active');
    expect(nextStatus('active', 'renewal_due')).toBe('pending_renewal');
    expect(nextStatus('pending_renewal', 'term_expired')).toBe('expired');
    // Ended subscriptions never come back through a transition; a new plan assignment is required.
    for (const e of ['activate', 'reinstate', 'payment_recovered', 'renew', 'cancel_now'] as const) {
      expect(nextStatus('canceled', e)).toBeNull();
      expect(nextStatus('expired', e)).toBeNull();
    }
    expect(nextStatus('active', 'trial_expired')).toBeNull();
    expect(nextStatus('trialing', 'payment_failed')).toBeNull();
    expect(allowedEvents('canceled')).toEqual([]);
  });

  it('maps states to access levels; suspended and ended are read-only, never deleted', () => {
    const map: Record<SubStatus, string> = { trialing: 'full', active: 'full', pending_renewal: 'full', past_due: 'full', pending_activation: 'limited',
      suspended: 'read_only', canceled: 'read_only', expired: 'read_only' };
    for (const [s, a] of Object.entries(map)) expect(accessFor(s as SubStatus)).toBe(a);
    expect(accessFor(null)).toBe('read_only');
    expect(NEVER_BLOCKED).toEqual(expect.arrayContaining(['audit', 'retention', 'deletion_requests', 'social_lifecycle']));
  });
});

describe('usage periods', () => {
  it('anchors monthly periods in the tenant time zone and keeps them contiguous', () => {
    const anchor = new Date('2026-01-15T03:00:00Z');                 // 10:00 in Jakarta
    const p = usagePeriod(anchor, new Date('2026-03-20T00:00:00Z'), 'Asia/Jakarta');
    expect(p.start.toISOString()).toBe('2026-03-15T03:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-04-15T03:00:00.000Z');
    // Just before the anchor moment → previous period.
    const q = usagePeriod(anchor, new Date('2026-03-15T02:59:00Z'), 'Asia/Jakarta');
    expect(q.start.toISOString()).toBe('2026-02-15T03:00:00.000Z');
    expect(q.end.getTime()).toBe(p.start.getTime());
  });

  it('clamps anchors on the 31st to short months without gaps', () => {
    const anchor = new Date('2026-01-31T17:00:00Z');                 // 2026-02-01 00:00 Jakarta → anchor day 1
    expect(usagePeriod(anchor, new Date('2026-02-10T00:00:00Z'), 'Asia/Jakarta').start.toISOString()).toBe('2026-01-31T17:00:00.000Z');
    const a31 = new Date('2026-01-31T05:00:00Z');                    // 31 Jan 12:00 Jakarta
    const feb = usagePeriod(a31, new Date('2026-02-28T12:00:00Z'), 'Asia/Jakarta');
    expect(feb.start.toISOString()).toBe('2026-02-28T05:00:00.000Z');  // clamped to 28 Feb
    expect(feb.end.toISOString()).toBe('2026-03-31T05:00:00.000Z');
    const jan = usagePeriod(a31, new Date('2026-02-27T00:00:00Z'), 'Asia/Jakarta');
    expect(jan.end.getTime()).toBe(feb.start.getTime());
  });

  it('handles daylight-saving zones and year boundaries', () => {
    const anchor = new Date('2026-01-10T14:00:00Z');                 // 09:00 New York (EST)
    const p = usagePeriod(anchor, new Date('2026-03-20T00:00:00Z'), 'America/New_York');
    expect(p.start.toISOString()).toBe('2026-03-10T13:00:00.000Z'); // 09:00 EDT
    const dec = usagePeriod(new Date('2026-01-20T00:00:00Z'), new Date('2026-12-25T00:00:00Z'), 'UTC');
    expect(dec.end.toISOString()).toBe('2027-01-20T00:00:00.000Z');
    expect(addMonths(new Date('2026-12-31T00:00:00Z'), 2, 'UTC').toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });
});

describe('quota decisions', () => {
  it('distinguishes unlimited, within, soft overage and hard block', () => {
    expect(decide(ent({}), 'projects', 1000, 1).behaviour).toBe('unlimited');
    const e = ent({ projects: { limit: 3, enforcement: 'hard', overage: 'block', source: 'plan' }, exports: { limit: 10, enforcement: 'soft', overage: 'allow_and_flag', source: 'plan' } });
    expect(decide(e, 'projects', 2, 1)).toMatchObject({ allowed: true, remaining: 1, behaviour: 'within_limit' });
    expect(decide(e, 'projects', 3, 1)).toMatchObject({ allowed: false, remaining: 0, behaviour: 'blocked', overage: true });
    expect(decide(e, 'projects', 3, 1).reason).toMatch(/3 of 3 projects/);
    expect(decide(e, 'exports', 10, 5)).toMatchObject({ allowed: true, behaviour: 'soft_overage', overage: true });
  });
});

describe('plan configuration validation', () => {
  const base = { billingInterval: 'month', features: {}, quotas: {} };
  it('rejects unknown metrics and features, and prices without currency', () => {
    expect(PlanVersionInput.safeParse({ ...base, quotas: { projects: { limit: 2, enforcement: 'hard' } } }).success).toBe(true);
    expect(PlanVersionInput.safeParse({ ...base, quotas: { bogus: { limit: 2, enforcement: 'hard' } } }).success).toBe(false);
    expect(PlanVersionInput.safeParse({ ...base, features: { teleport: true } }).success).toBe(false);
    expect(PlanVersionInput.safeParse({ ...base, priceAmount: 100 }).success).toBe(false);
    expect(PlanVersionInput.safeParse({ ...base, priceAmount: 100, currency: 'IDR' }).success).toBe(true);
    expect(PlanVersionInput.safeParse({ ...base, quotas: { projects: { limit: -1, enforcement: 'hard' } } }).success).toBe(false);
  });
});

describe('billing providers', () => {
  const secret = 'test-secret-0123456789abcdefghij';
  const body = JSON.stringify({ id: 'evt_1', type: 'subscription.canceled', created_at: '2026-10-20T00:00:00Z', data: { subscription: 'sub_1' } });
  const at = Math.floor(Date.parse('2026-10-20T00:00:00Z') / 1000);
  const p = new TestBillingProvider(secret, 'http://localhost:3000');
  const now = new Date('2026-10-20T00:01:00Z');

  it('accepts a correctly signed, fresh event', () => {
    const ev = p.verifyWebhook(Buffer.from(body), { [TEST_SIGNATURE_HEADER]: signTestPayload(secret, body, at) }, now);
    expect(ev).toMatchObject({ id: 'evt_1', type: 'subscription.canceled', subscriptionRef: 'sub_1' });
  });
  it('rejects tampered bodies, wrong secrets, stale timestamps and missing signatures', () => {
    const sig = signTestPayload(secret, body, at);
    expect(() => p.verifyWebhook(Buffer.from(body.replace('sub_1', 'sub_2')), { [TEST_SIGNATURE_HEADER]: sig }, now)).toThrow(WebhookRejected);
    expect(() => p.verifyWebhook(Buffer.from(body), { [TEST_SIGNATURE_HEADER]: signTestPayload('another-secret-0123456789abcd', body, at) }, now)).toThrow(/mismatch/);
    expect(() => p.verifyWebhook(Buffer.from(body), { [TEST_SIGNATURE_HEADER]: sig }, new Date('2026-10-20T00:10:00Z'))).toThrow(/tolerance/);
    expect(() => p.verifyWebhook(Buffer.from(body), {}, now)).toThrow(/missing/);
    const bad = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', created_at: '2026-10-20T00:00:00Z', data: { subscription: 's', invoice: 'i', payment: 'p', amount: -5, currency: 'IDR', period_start: '2026-10-20T00:00:00Z', period_end: '2026-11-20T00:00:00Z' } });
    expect(() => p.verifyWebhook(Buffer.from(bad), { [TEST_SIGNATURE_HEADER]: signTestPayload(secret, bad, at) }, now)).toThrow(/amount/);
  });
  it('the default provider refuses every payment operation honestly', async () => {
    const none = new NoBillingProvider();
    expect(none.configured).toBe(false);
    expect(none.live).toBe(false);
    await expect(Promise.resolve().then(() => none.createCheckout())).rejects.toMatchObject({ status: 503 });
    expect(() => none.verifyWebhook()).toThrow(WebhookRejected);
    expect(new TestBillingProvider(null, 'x').configured).toBe(false);
  });
});

describe('billing configuration', () => {
  const env = { DATABASE_URL: 'postgres://x', NODE_ENV: 'development' };
  it('defaults to no provider and refuses unknown or unsafe settings', () => {
    expect(loadConfig(env).billing.provider).toBe('none');
    expect(() => loadConfig({ ...env, BILLING_PROVIDER: 'stripe' })).toThrow(/none or test/);
    expect(() => loadConfig({ ...env, BILLING_PROVIDER: 'test' })).toThrow(/BILLING_TEST_WEBHOOK_SECRET/);
    expect(loadConfig({ ...env, BILLING_PROVIDER: 'test', BILLING_TEST_WEBHOOK_SECRET: 'x'.repeat(32) }).billing.provider).toBe('test');
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', COOKIE_SECURE: 'true', BILLING_PROVIDER: 'test', BILLING_TEST_WEBHOOK_SECRET: 'x'.repeat(32) })).toThrow(/refused in production/);
    expect(() => loadConfig({ ...env, INVOICE_NUMBER_PREFIX: 'inv; drop' })).toThrow(/INVOICE_NUMBER_PREFIX/);
  });
});
