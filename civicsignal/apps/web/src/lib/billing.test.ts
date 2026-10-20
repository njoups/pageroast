import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessText, canBilling, limitText, money, priceText, usageLevel, type BillingOverview, type PlanInfo, type UsageRow } from './billing';

const row = (o: Partial<UsageRow> = {}): UsageRow => ({ metric: 'projects', label: 'Projects', unit: 'projects', kind: 'gauge', description: '', used: 7, limit: 10, remaining: 3,
  percentUsed: 70, enforcement: 'hard', source: 'plan', overLimit: false, atLimit: false, ...o });

test('usage bars never invent a percentage', () => {
  assert.deepEqual(usageLevel(row()), { pct: 70, tone: 'warn' });
  assert.deepEqual(usageLevel(row({ percentUsed: 150, used: 15 })), { pct: 100, tone: 'over' });
  assert.equal(usageLevel(row({ limit: null, percentUsed: null })), null);
  assert.equal(usageLevel(row({ enforcement: 'none' })), null);
  assert.equal(limitText(row({ limit: null })), 'Unlimited');
  assert.equal(limitText(row({ limit: 500, enforcement: 'soft', unit: 'downloads' })), '500 downloads (soft limit)');
});

test('prices are shown only when configured', () => {
  const p = { price: null } as PlanInfo;
  assert.equal(priceText(p), 'Price on request');
  assert.match(priceText({ price: { amount: 1500000, currency: 'IDR', interval: 'month' } } as PlanInfo), /^Rp\s?1\.500\.000 \/ month$/);
  assert.match(money(12.5, 'USD'), /12\.50/);
});

test('access text is honest about read-only states', () => {
  assert.match(accessText({ subscription: null } as BillingOverview), /no active subscription/i);
  assert.match(accessText({ subscription: { status: 'suspended', access: 'read_only' } } as BillingOverview), /Nothing has been deleted/);
  assert.match(accessText({ subscription: { status: 'past_due', access: 'full' } } as BillingOverview), /grace period/);
});

test('permission hints mirror the API matrix', () => {
  assert.equal(canBilling.read('admin'), true);
  assert.equal(canBilling.read('analyst'), false);
  assert.equal(canBilling.manage('admin'), false);
  assert.equal(canBilling.manage('owner'), true);
});
