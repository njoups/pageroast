'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Loading, PageHeader } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { canBilling, STEP_LABEL, type OnboardingState } from '@/lib/billing';

/** Guided setup. Progress is stored on the server and derived from real setup data, so it can be resumed anywhere. */
export default function GettingStartedPage() {
  const org = useOrg();
  const [s, setS] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setS(await api<OnboardingState>(`/organizations/${org.id}/onboarding`)); } catch (e) { setError(errorMessage(e)); } }, [org.id]);
  useEffect(() => { void load(); }, [load]);
  const edit = canBilling.onboardingEdit(org.role);
  const set = async (step: string, status: 'done' | 'skipped' | 'todo') => {
    setError(null);
    try { setS(await api<OnboardingState>(`/organizations/${org.id}/onboarding/steps/${step}`, { method: 'PUT', body: { status } })); } catch (e) { setError(errorMessage(e)); }
  };
  if (!s) return <><PageHeader title="Getting started" />{error ? <Alert>{error}</Alert> : <Loading />}</>;
  const done = s.steps.filter((x) => x.status !== 'todo').length;

  return (
    <>
      <PageHeader title="Getting started" description={s.path === 'sales_assisted'
        ? 'Your organization is set up by our team under a contract. No payment details are needed; complete the remaining setup below.'
        : 'Set up monitoring step by step. You can leave and come back at any time; progress is saved.'} />
      <div className="mb-4 space-y-3">
        {error && <Alert>{error}</Alert>}
        {s.complete && <Alert tone="success">Setup is complete. <Link className="underline" href={`/o/${org.id}`}>Go to the dashboard</Link>.</Alert>}
      </div>
      <p className="mb-3 text-sm text-slate-600" aria-live="polite">{done} of {s.steps.length} steps done</p>
      <ol className="space-y-3">
        {s.steps.map((step, i) => {
          const meta = STEP_LABEL[step.key] ?? { title: step.key, hint: '' };
          const plan = step.key === 'plan' && s.path === 'sales_assisted';
          return (
            <li key={step.key} className={`card flex flex-wrap items-center justify-between gap-3 ${s.nextStep === step.key ? 'ring-2 ring-brand-600' : ''}`}>
              <div>
                <p className="font-medium">{i + 1}. {plan ? 'Contract provisioned by our team' : meta.title}</p>
                <p className="text-sm text-slate-600">{plan ? 'Your plan and entitlements come from your contract.' : meta.hint}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={step.status === 'done' ? 'green' : step.status === 'skipped' ? 'slate' : 'amber'}>{step.status === 'todo' ? 'To do' : step.status}</Badge>
                {step.status === 'todo' && meta.href && <Link className="btn-secondary" href={meta.href(org.id)}>Open</Link>}
                {edit && step.status === 'todo' && (step.key === 'usage_review' || step.key === 'invite' || step.key === 'plan') && !plan && <button className="btn-secondary" onClick={() => void set(step.key, 'done')}>Mark done</button>}
                {edit && step.status === 'todo' && step.skippable && <button className="btn-secondary" onClick={() => void set(step.key, 'skipped')}>Skip</button>}
                {edit && !step.derived && step.status !== 'todo' && <button className="text-xs text-slate-500 underline" onClick={() => void set(step.key, 'todo')}>Undo</button>}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
