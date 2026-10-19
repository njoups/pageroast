import type { PoolClient } from 'pg';
import type { Usage } from './providers/provider';

/**
 * Records token usage and an ESTIMATED cost from operator-configured pricing (table ai_pricing). Prices are never
 * hardcoded: when no price is configured for provider/model, cost stays NULL ("unknown"). Estimates are not invoices.
 */
export async function recordAiUsage(c: PoolClient, tenantId: string, provider: string, model: string, task: string, usage: Usage,
  refs: { analysisId?: string; summaryId?: string }): Promise<{ cost: number | null; currency: string | null }> {
  const p = (await c.query<{ input_per_mtok: string; output_per_mtok: string; cache_read_per_mtok: string | null; currency: string; updated_at: Date }>(
    'SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, currency, updated_at FROM ai_pricing WHERE provider = $1 AND model = $2', [provider, model])).rows[0];
  let cost: number | null = null;
  if (p) {
    const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
    cost = (uncached * Number(p.input_per_mtok) + usage.cacheReadTokens * Number(p.cache_read_per_mtok ?? p.input_per_mtok) + usage.outputTokens * Number(p.output_per_mtok)) / 1e6;
    cost = Math.round(cost * 1e6) / 1e6;
  }
  await c.query(
    `INSERT INTO ai_usage_records (tenant_id, provider, model, task, analysis_id, summary_id, tokens_in, tokens_out, tokens_cache_read, cost_estimate, currency, pricing_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [tenantId, provider, model, task, refs.analysisId ?? null, refs.summaryId ?? null, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
      cost, p?.currency ?? null, p?.updated_at ?? null]);
  return { cost, currency: p?.currency ?? null };
}

export interface QuotaState { autoAnalyze: boolean; dailyMentionLimit: number; monthlyTokenLimit: number; analysesToday: number; tokensThisMonth: number }

export async function quotaState(c: PoolClient): Promise<QuotaState> {
  const s = (await c.query<{ auto_analyze: boolean; daily_mention_limit: number; monthly_token_limit: string }>('SELECT * FROM ai_tenant_settings')).rows[0];
  const today = (await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mention_analyses WHERE status IN ('succeeded','partial') AND finished_at >= date_trunc('day', now())`)).rows[0]!.n;
  const tokens = (await c.query<{ n: string }>(
    `SELECT coalesce(sum(tokens_in + tokens_out), 0)::bigint AS n FROM ai_usage_records WHERE recorded_at >= date_trunc('month', now())`)).rows[0]!.n;
  return {
    autoAnalyze: s?.auto_analyze ?? true, dailyMentionLimit: s?.daily_mention_limit ?? 500, monthlyTokenLimit: Number(s?.monthly_token_limit ?? 2_000_000),
    analysesToday: today, tokensThisMonth: Number(tokens),
  };
}
