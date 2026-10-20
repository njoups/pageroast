import type { PoolClient } from 'pg';

/**
 * Internal cost and margin view (platform operators only, never shown to tenants). Four figures are kept apart and
 * never mixed: ESTIMATED provider cost (usage × operator-configured prices, with the price verification date),
 * ACTUAL provider cost (entered from a provider's own invoice), BILLED amounts (invoices issued) and REVENUE (payments
 * received). A margin is computed only when revenue and cost share one currency; otherwise it is reported as not comparable.
 */
export async function tenantCostSummary(c: PoolClient, from: string, to: string) {
  const ai = (await c.query(`SELECT tenant_id, currency, sum(tokens_in + tokens_out)::bigint AS tokens, sum(cost_estimate) AS cost, count(*) FILTER (WHERE cost_estimate IS NULL)::int AS unpriced,
      max(pricing_updated_at) AS pricing_updated_at FROM ai_usage_records WHERE recorded_at >= $1::date AND recorded_at < $2::date + 1 GROUP BY 1, 2`, [from, to])).rows;
  const social = (await c.query(`SELECT u.tenant_id, u.provider, sum(u.requests)::bigint AS requests, sum(u.units)::bigint AS units, sum(u.records_retrieved)::bigint AS records,
      (SELECT min(verified_at) FROM provider_pricing p WHERE p.provider = u.provider) AS pricing_verified_at
    FROM provider_usage u WHERE u.day BETWEEN $1::date AND $2::date GROUP BY 1, 2`, [from, to])).rows;
  const actual = (await c.query(`SELECT tenant_id, currency, sum(amount) AS amount, count(*)::int AS entries FROM provider_cost_entries
      WHERE period_start <= $2::date AND period_end >= $1::date GROUP BY 1, 2`, [from, to])).rows;
  const billed = (await c.query(`SELECT tenant_id, currency, sum(total) AS amount FROM invoices WHERE status NOT IN ('draft','void','canceled')
      AND issued_at >= $1::date AND issued_at < $2::date + 1 GROUP BY 1, 2`, [from, to])).rows;
  const revenue = (await c.query(`SELECT tenant_id, currency, sum(amount) AS amount FROM payments WHERE received_at >= $1::date AND received_at < $2::date + 1 GROUP BY 1, 2`, [from, to])).rows;
  const tenants = (await c.query<{ id: string; name: string; plan_code: string | null; status: string | null }>(`SELECT t.id, t.name, s.plan_code, s.status FROM tenants t
      LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.ended_at IS NULL ORDER BY t.name`)).rows;
  const money = (rows: any[], id: string) => rows.filter((r) => r.tenant_id === id).map((r) => ({ currency: r.currency, amount: Number(r.amount ?? r.cost ?? 0) }));
  const out = tenants.map((t) => {
    const aiRows = ai.filter((r) => r.tenant_id === t.id);
    const est = aiRows.filter((r) => r.currency).map((r) => ({ currency: r.currency as string, amount: Math.round(Number(r.cost) * 10_000) / 10_000 }));
    const act = money(actual, t.id); const rev = money(revenue, t.id);
    const costForMargin = act.length ? act : est;
    const curr = new Set([...costForMargin.map((x) => x.currency), ...rev.map((x) => x.currency)]);
    const margin = rev.length && costForMargin.length && curr.size === 1
      ? { currency: [...curr][0], amount: Math.round((rev.reduce((a, x) => a + x.amount, 0) - costForMargin.reduce((a, x) => a + x.amount, 0)) * 100) / 100, basis: act.length ? 'actual_cost' : 'estimated_cost' }
      : { currency: null, amount: null, basis: !rev.length ? 'no_revenue_recorded' : !costForMargin.length ? 'no_cost_recorded' : 'currencies_differ' };
    return {
      tenantId: t.id, name: t.name, plan: t.plan_code, status: t.status,
      ai: { tokens: aiRows.reduce((a, r) => a + Number(r.tokens), 0), unpricedCalls: aiRows.reduce((a, r) => a + r.unpriced, 0), estimatedCost: est,
        pricingUpdatedAt: aiRows.map((r) => r.pricing_updated_at).filter(Boolean).sort().pop() ?? null },
      social: social.filter((r) => r.tenant_id === t.id).map((r) => ({ provider: r.provider, requests: Number(r.requests), units: Number(r.units), records: Number(r.records), pricingVerifiedAt: r.pricing_verified_at })),
      actualCost: act, billed: money(billed, t.id), revenue: rev, margin,
    };
  });
  const unattributed = (await c.query(`SELECT currency, sum(amount) AS amount FROM provider_cost_entries WHERE tenant_id IS NULL AND period_start <= $2::date AND period_end >= $1::date GROUP BY 1`, [from, to]))
    .rows.map((r) => ({ currency: r.currency, amount: Number(r.amount) }));
  return { from, to, tenants: out, unattributedActualCost: unattributed,
    notes: ['Estimated costs use operator-configured prices; check the verification dates before relying on them.', 'Billed and revenue figures come from invoices and recorded payments only.'] };
}
