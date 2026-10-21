import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/errors';

/**
 * Payment-provider boundary. The application talks only to this interface; provider SDKs, credentials and event
 * formats stay inside an adapter. No real provider adapter exists yet (none has been chosen or configured):
 *   - `none` (default): every payment operation answers 503 billing_provider_not_configured. Contract and manual
 *     invoicing keep working.
 *   - `test`: a local simulator for development and automated tests. It does not move money, uses its own documented
 *     event format (not any real provider's) and is refused in production (allowed only when APP_ENV=staging).
 */
export interface CheckoutRequest { tenantId: string; planVersionId: string; planCode: string; amount: number; currency: string; interval: string; customerRef: string | null; returnUrl: string }
export interface CheckoutSession { sessionRef: string; url: string; expiresAt: Date }

/** Provider events, normalised. Only verified events reach the application. */
export type BillingEvent =
  | { id: string; type: 'checkout.completed'; occurredAt: Date; sessionRef: string; customerRef: string; subscriptionRef: string; periodStart: Date; periodEnd: Date }
  | { id: string; type: 'invoice.paid'; occurredAt: Date; subscriptionRef: string; invoiceRef: string; paymentRef: string; amount: number; currency: string; periodStart: Date; periodEnd: Date }
  | { id: string; type: 'invoice.payment_failed'; occurredAt: Date; subscriptionRef: string; invoiceRef: string; amount: number; currency: string }
  | { id: string; type: 'subscription.canceled'; occurredAt: Date; subscriptionRef: string }
  | { id: string; type: 'refund.created'; occurredAt: Date; paymentRef: string; invoiceRef: string; amount: number; currency: string }
  | { id: string; type: 'unknown'; occurredAt: Date; providerType: string };

export interface BillingProvider {
  readonly name: string;
  readonly configured: boolean;
  /** true only for an adapter that can charge real money. */
  readonly live: boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  cancelSubscription(subscriptionRef: string, atPeriodEnd: boolean): Promise<void>;
  resumeSubscription(subscriptionRef: string): Promise<void>;
  createPortalSession(customerRef: string, returnUrl: string): Promise<{ url: string }>;
  refund(paymentRef: string, amount: number): Promise<{ refundRef: string }>;
  /** Verifies authenticity and freshness; throws WebhookRejected. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now?: Date): BillingEvent;
}

export class WebhookRejected extends Error { constructor(readonly reason: string) { super(reason); } }
export const providerUnavailable = (what: string) =>
  new AppError(503, 'billing_provider_not_configured', `Online payment is not available (${what}): no payment provider is configured. Contact sales for contract or invoice billing.`);

export class NoBillingProvider implements BillingProvider {
  readonly name = 'none'; readonly configured = false; readonly live = false;
  createCheckout(): Promise<CheckoutSession> { throw providerUnavailable('checkout'); }
  cancelSubscription(): Promise<void> { throw providerUnavailable('cancel'); }
  resumeSubscription(): Promise<void> { throw providerUnavailable('resume'); }
  createPortalSession(): Promise<{ url: string }> { throw providerUnavailable('billing portal'); }
  refund(): Promise<{ refundRef: string }> { throw providerUnavailable('refund'); }
  verifyWebhook(): BillingEvent { throw new WebhookRejected('no billing provider is configured'); }
}

export const TEST_SIGNATURE_HEADER = 'x-civicsignal-test-signature';
const TOLERANCE_SECONDS = 300;

/** Signs a test-provider payload (used by tests and the local simulator script). */
export function signTestPayload(secret: string, body: string, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}

export class TestBillingProvider implements BillingProvider {
  readonly name = 'test'; readonly live = false;
  constructor(private readonly secret: string | null, private readonly baseUrl: string) {}
  get configured() { return !!this.secret; }
  private need() { if (!this.secret) throw providerUnavailable('BILLING_TEST_WEBHOOK_SECRET is not set'); }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    this.need();
    const sessionRef = `test_cs_${randomUUID()}`;
    // The simulator page only explains that a signed `checkout.completed` event must be delivered; it never activates anything.
    return { sessionRef, url: `${this.baseUrl}/billing/test-checkout?session=${encodeURIComponent(sessionRef)}&plan=${encodeURIComponent(req.planCode)}`, expiresAt: new Date(Date.now() + 3_600_000) };
  }
  async cancelSubscription() { this.need(); }
  async resumeSubscription() { this.need(); }
  async createPortalSession(_c: string, returnUrl: string) { this.need(); return { url: returnUrl }; }
  async refund() { this.need(); return { refundRef: `test_re_${randomUUID()}` }; }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now = new Date()): BillingEvent {
    if (!this.secret) throw new WebhookRejected('test provider secret is not configured');
    const h = headers[TEST_SIGNATURE_HEADER];
    const sig = Array.isArray(h) ? h[0] : h;
    const m = sig && /^t=(\d{9,11}),v1=([0-9a-f]{64})$/.exec(sig);
    if (!m) throw new WebhookRejected('missing or malformed signature');
    const at = Number(m[1]);
    if (Math.abs(now.getTime() / 1000 - at) > TOLERANCE_SECONDS) throw new WebhookRejected('signature timestamp outside the tolerance window');
    const expected = createHmac('sha256', this.secret).update(`${at}.`).update(rawBody).digest();
    const given = Buffer.from(m[2]!, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookRejected('signature mismatch');
    let p: Record<string, unknown>;
    try { p = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookRejected('body is not JSON'); }
    return parseTestEvent(p);
  }
}

const str = (v: unknown, k: string) => { if (typeof v !== 'string' || !v || v.length > 200) throw new WebhookRejected(`field ${k} is missing or invalid`); return v; };
const num = (v: unknown, k: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new WebhookRejected(`field ${k} is missing or invalid`); return v; };
const date = (v: unknown, k: string) => { const d = new Date(str(v, k)); if (Number.isNaN(d.getTime())) throw new WebhookRejected(`field ${k} is not a date`); return d; };
const cur = (v: unknown) => { const s = str(v, 'currency'); if (!/^[A-Z]{3}$/.test(s)) throw new WebhookRejected('currency must be ISO 4217'); return s; };

export function parseTestEvent(p: Record<string, unknown>): BillingEvent {
  const id = str(p.id, 'id'); const occurredAt = date(p.created_at, 'created_at'); const d = (p.data ?? {}) as Record<string, unknown>;
  switch (p.type) {
    case 'checkout.completed':
      return { id, type: p.type, occurredAt, sessionRef: str(d.session, 'data.session'), customerRef: str(d.customer, 'data.customer'), subscriptionRef: str(d.subscription, 'data.subscription'),
        periodStart: date(d.period_start, 'data.period_start'), periodEnd: date(d.period_end, 'data.period_end') };
    case 'invoice.paid':
      return { id, type: p.type, occurredAt, subscriptionRef: str(d.subscription, 'data.subscription'), invoiceRef: str(d.invoice, 'data.invoice'), paymentRef: str(d.payment, 'data.payment'),
        amount: num(d.amount, 'data.amount'), currency: cur(d.currency), periodStart: date(d.period_start, 'data.period_start'), periodEnd: date(d.period_end, 'data.period_end') };
    case 'invoice.payment_failed':
      return { id, type: p.type, occurredAt, subscriptionRef: str(d.subscription, 'data.subscription'), invoiceRef: str(d.invoice, 'data.invoice'), amount: num(d.amount, 'data.amount'), currency: cur(d.currency) };
    case 'subscription.canceled':
      return { id, type: p.type, occurredAt, subscriptionRef: str(d.subscription, 'data.subscription') };
    case 'refund.created':
      return { id, type: p.type, occurredAt, paymentRef: str(d.payment, 'data.payment'), invoiceRef: str(d.invoice, 'data.invoice'), amount: num(d.amount, 'data.amount'), currency: cur(d.currency) };
    default:
      return { id, type: 'unknown', occurredAt, providerType: typeof p.type === 'string' ? p.type.slice(0, 60) : 'missing' };
  }
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');
export function createBillingProvider(cfg: { provider: 'none' | 'test'; testWebhookSecret: string | null }, appBaseUrl: string): BillingProvider {
  return cfg.provider === 'test' ? new TestBillingProvider(cfg.testWebhookSecret, appBaseUrl) : new NoBillingProvider();
}
