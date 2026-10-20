import type { PoolClient } from 'pg';
import { consume, counterUsage, decide, loadEntitlements } from '../commercial/quota';
import type { Usage } from './providers/provider';

/**
 * Records token usage and an ESTIMATED cost from operator-configured pricing (table ai_pricing). Prices are never
 * hardcoded: when no price is configured for provider/model, cost stays NULL ("unknown"). Estimates are not invoices.
 */
export async function recordAiUsage(c: PoolClient, tenantId: string, provider: string, model: string, task: string, usage: Usage,
  refs: { analysisId?: string; summaryId?: string }): Promise<{ cost: number | null; currency: string | null }> {
  const p = (await c.query<{ input_per_mtok: string; output_per_mtok: string; cache_read_per_mtok: string | null; cache_write_per_mtok: string | null; currency: string; updated_at: Date }>(
    'SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, currency, updated_at FROM ai_pricing WHERE provider = $1 AND model = $2', [provider, model])).rows[0];
  let cost: number | null = null;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (p) {
    // inputTokens already excludes cache reads and writes (they are reported separately); each is priced on its own.
    // Without a configured cache-write price, cache writes are priced at the input rate (an underestimate).
    cost = (usage.inputTokens * Number(p.input_per_mtok) + usage.cacheReadTokens * Number(p.cache_read_per_mtok ?? p.input_per_mtok)
      + cacheWrite * Number(p.cache_write_per_mtok ?? p.input_per_mtok) + usage.outputTokens * Number(p.output_per_mtok)) / 1e6;
    cost = Math.round(cost * 1e6) / 1e6;
  }
  const rec = await c.query<{ id: string }>(
    `INSERT INTO ai_usage_records (tenant_id, provider, model, task, analysis_id, summary_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_estimate, currency, pricing_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [tenantId, provider, model, task, refs.analysisId ?? null, refs.summaryId ?? null, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, cacheWrite,
      cost, p?.currency ?? null, p?.updated_at ?? null]);
  // Plan metering: provider-reported tokens of this call, counted once per call record.
  const tokens = usage.inputTokens + cacheWrite + usage.outputTokens;
  if (tokens > 0) await consume(c, tenantId, { metric: 'ai_tokens', quantity: tokens, idempotencyKey: `ai_usage:${rec.rows[0]!.id}`, source: provider, metadata: { task, model } });
  return { cost, currency: p?.currency ?? null };
}

export interface QuotaState {
  autoAnalyze: boolean; dailyMentionLimit: number; monthlyTokenLimit: number; analysesToday: number; tokensThisMonth: number;
  /** Plan-level reasons (subscription, feature, plan quota) that stop LLM calls or analyses entirely; null when allowed. */
  llmBlocked: string | null; analysisBlocked: string | null;
}

/** True when no further LLM tokens may be spent (tenant's own monthly cap or the plan). */
export const llmUnavailable = (q: QuotaState) => q.tokensThisMonth >= q.monthlyTokenLimit || q.llmBlocked !== null;

export async function quotaState(c: PoolClient): Promise<QuotaState> {
  const s = (await c.query<{ auto_analyze: boolean; daily_mention_limit: number; monthly_token_limit: string }>('SELECT * FROM ai_tenant_settings')).rows[0];
  const today = (await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mention_analyses WHERE status IN ('succeeded','partial') AND finished_at >= date_trunc('day', now())`)).rows[0]!.n;
  const tokens = (await c.query<{ n: string }>(
    `SELECT coalesce(sum(tokens_in + tokens_out), 0)::bigint AS n FROM ai_usage_records WHERE recorded_at >= date_trunc('month', now())`)).rows[0]!.n;
  // Plan entitlements of the tenant whose RLS context this transaction runs in.
  const tenantId = (await c.query<{ t: string }>('SELECT app_current_tenant() AS t')).rows[0]!.t;
  const ent = await loadEntitlements(c, tenantId);
  const planTokens = decide(ent, 'ai_tokens', await counterUsage(c, tenantId, 'ai_tokens', ent.period), 1);
  const planAnalyses = decide(ent, 'ai_analyses', await counterUsage(c, tenantId, 'ai_analyses', ent.period), 1);
  const inactive = ent.access !== 'full' ? `subscription_${ent.subscription?.status ?? 'missing'}` : null;
  return {
    autoAnalyze: s?.auto_analyze ?? true, dailyMentionLimit: s?.daily_mention_limit ?? 500, monthlyTokenLimit: Number(s?.monthly_token_limit ?? 2_000_000),
    analysesToday: today, tokensThisMonth: Number(tokens),
    llmBlocked: inactive ?? (!ent.features.ai_analysis ? 'plan_feature_ai_analysis' : !planTokens.allowed ? 'plan_ai_tokens_limit_reached' : null),
    analysisBlocked: inactive ?? (!planAnalyses.allowed ? 'plan_ai_analyses_limit_reached' : null),
  };
}
