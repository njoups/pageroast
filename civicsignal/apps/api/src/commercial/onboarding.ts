import type { PoolClient } from 'pg';

/**
 * Guided onboarding. Progress is derived from the organization's real data wherever possible (a project exists, a
 * query exists, …) and persisted per step otherwise (done / skipped), so it survives sign-out and can be resumed on
 * any device. Sales-assisted organizations (contract or manual billing) never see a payment step.
 */
export const STEPS = ['organization', 'invite', 'plan', 'project', 'keywords', 'sources', 'alerts', 'report_template', 'usage_review'] as const;
export type Step = (typeof STEPS)[number];
const SKIPPABLE = new Set<Step>(['invite', 'plan', 'sources', 'alerts', 'report_template', 'usage_review']);

export interface StepState { key: Step; status: 'done' | 'skipped' | 'todo'; derived: boolean; skippable: boolean; at: string | null }

export async function onboardingState(c: PoolClient, tenantId: string) {
  const counts = (await c.query<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM memberships) AS members,
      (SELECT count(*)::int FROM invitations WHERE revoked_at IS NULL) AS invites,
      (SELECT count(*)::int FROM projects) AS projects,
      (SELECT count(*)::int FROM monitoring_queries) AS queries,
      (SELECT count(*)::int FROM sources WHERE enabled) AS sources,
      (SELECT count(*)::int FROM alert_rules WHERE deleted_at IS NULL) AS rules,
      (SELECT count(*)::int FROM report_definitions WHERE deleted_at IS NULL) AS reports,
      (SELECT count(*)::int FROM sales_requests) AS sales`)).rows[0]!;
  const sub = (await c.query<{ status: string; billing_mode: string; category: string }>(`SELECT s.status, s.billing_mode, p.category FROM subscriptions s
      LEFT JOIN plan_versions pv ON pv.id = s.plan_version_id LEFT JOIN plans p ON p.id = pv.plan_id WHERE s.tenant_id = $1 AND s.ended_at IS NULL`, [tenantId])).rows[0];
  const row = (await c.query<{ path: string; steps: Record<string, { status: 'done' | 'skipped'; at: string }>; completed_at: Date | null }>(
    'SELECT path, steps, completed_at FROM onboarding_progress WHERE tenant_id = $1', [tenantId])).rows[0];
  const salesAssisted = sub ? sub.billing_mode !== 'self_service' || ['sales_assisted', 'public_sector', 'internal'].includes(sub.category) : false;
  const derived: Partial<Record<Step, boolean>> = {
    organization: true,
    invite: counts.members! > 1 || counts.invites! > 0,
    plan: !!sub && (sub.status !== 'trialing' || counts.sales! > 0),
    project: counts.projects! > 0,
    keywords: counts.queries! > 0,
    sources: counts.sources! > 0,
    alerts: counts.rules! > 0,
    report_template: counts.reports! > 0,
  };
  const steps: StepState[] = STEPS.map((key) => {
    const saved = row?.steps?.[key];
    if (derived[key]) return { key, status: 'done', derived: true, skippable: SKIPPABLE.has(key), at: saved?.at ?? null };
    return { key, status: saved?.status ?? 'todo', derived: false, skippable: SKIPPABLE.has(key), at: saved?.at ?? null };
  });
  const complete = steps.every((s) => s.status !== 'todo');
  return { path: salesAssisted ? 'sales_assisted' as const : 'self_service' as const, steps, complete, completedAt: row?.completed_at ?? null,
    nextStep: steps.find((s) => s.status === 'todo')?.key ?? null };
}

/** Marks a step done or skipped (steps with real data behind them cannot be marked done by hand). */
export async function setStep(c: PoolClient, tenantId: string, step: Step, status: 'done' | 'skipped' | 'todo', userId: string) {
  if (status === 'skipped' && !SKIPPABLE.has(step)) return { error: 'not_skippable' as const };
  if (status === 'done' && !['usage_review', 'plan', 'invite'].includes(step)) return { error: 'derived_step' as const };
  const value = status === 'todo' ? null : JSON.stringify({ status, at: new Date().toISOString(), by: userId });
  await c.query(`INSERT INTO onboarding_progress (tenant_id, steps) VALUES ($1, CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object($2::text, $3::jsonb) END)
    ON CONFLICT (tenant_id) DO UPDATE SET steps = CASE WHEN $3::jsonb IS NULL THEN onboarding_progress.steps - $2::text ELSE onboarding_progress.steps || jsonb_build_object($2::text, $3::jsonb) END, updated_at = now()`,
    [tenantId, step, value]);
  const state = await onboardingState(c, tenantId);
  await c.query(`UPDATE onboarding_progress SET path = $2, completed_at = CASE WHEN $3 THEN coalesce(completed_at, now()) ELSE NULL END WHERE tenant_id = $1`, [tenantId, state.path, state.complete]);
  return { state: await onboardingState(c, tenantId) };
}
