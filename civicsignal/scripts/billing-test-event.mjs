#!/usr/bin/env node
/**
 * Sends a signed event to the TEST billing adapter (BILLING_PROVIDER=test) — development only; the API refuses the
 * test adapter in production. Simulates what a payment provider would report; it does not move money.
 *
 *   BILLING_TEST_WEBHOOK_SECRET=… node scripts/billing-test-event.mjs checkout.completed --session test_cs_… [--api http://localhost:4000]
 *   … invoice.paid --subscription sub_… --amount 1500000 --currency IDR
 *   … invoice.payment_failed --subscription sub_… --amount 1500000 --currency IDR
 *   … subscription.canceled --subscription sub_…
 */
import { createHmac, randomUUID } from 'node:crypto';

const [type, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const secret = process.env.BILLING_TEST_WEBHOOK_SECRET;
if (!secret) { console.error('BILLING_TEST_WEBHOOK_SECRET is not set'); process.exit(2); }
const now = new Date(); const end = new Date(now.getTime() + 30 * 86_400_000);
const period = { period_start: now.toISOString(), period_end: end.toISOString() };
const sub = arg('subscription', `sub_${randomUUID()}`);
const data = {
  'checkout.completed': { session: arg('session'), customer: arg('customer', `cus_${randomUUID()}`), subscription: sub, ...period },
  'invoice.paid': { subscription: sub, invoice: arg('invoice', `in_${randomUUID()}`), payment: arg('payment', `py_${randomUUID()}`), amount: Number(arg('amount', '0')), currency: arg('currency', 'IDR'), ...period },
  'invoice.payment_failed': { subscription: sub, invoice: arg('invoice', `in_${randomUUID()}`), amount: Number(arg('amount', '0')), currency: arg('currency', 'IDR') },
  'subscription.canceled': { subscription: sub },
}[type];
if (!data || (type === 'checkout.completed' && !data.session)) { console.error('usage: see the header of this script'); process.exit(2); }
const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, created_at: now.toISOString(), data });
const t = Math.floor(Date.now() / 1000);
const sig = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const res = await fetch(`${arg('api', 'http://localhost:4000')}/api/v1/billing/webhooks/test`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-civicsignal-test-signature': sig }, body });
console.log(res.status, await res.text());
if (type === 'checkout.completed') console.log(`subscription reference: ${sub}`);
