'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { SeverityBadge } from '@/components/alerts-ui';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { TOPIC_LABEL } from '@/lib/ai';
import { canAlerts, RULE_HELP, SEVERITIES, SEVERITY_LABEL, SIGNAL_LABEL, type Severity } from '@/lib/alerts';
import { api, ApiError, errorMessage, fmtDate, relTime, type Member, type Project, type Source } from '@/lib/api';

type Cfg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- mirrors the server-validated config JSON
interface Rule { id: string; project_id: string; project_name: string; name: string; rule_type: string; is_active: boolean; current_version: number; owner_name: string | null;
  updated_at: string; deleted_at: string | null; config: Cfg; open_issues: number; last_triggered_at: string | null }
interface DryResult { signal: string; scope: string; subject: string; title: string; triggered: boolean; suppressed: null | { reason: string; detail: string };
  severity: null | { severity: Severity; points: number }; method: string; observed: Record<string, number>; baseline: Record<string, number | null>; exceeded: string[]; limitations: string[]; evidenceCount: number }
const TYPES = Object.keys(SIGNAL_LABEL);

/** Uncontrolled numeric field; module-level so re-renders never remount it (and lose what the user typed). */
function Field({ name, label, def, step = '1', help, suffix, err }: { name: string; label: string; def?: number; step?: string; help?: string; suffix?: string; err?: string }) {
  return (
    <div><label className="label" htmlFor={name}>{label}{suffix && <span className="font-normal text-slate-500"> ({suffix})</span>}</label><input id={name} name={name} type="number" step={step} defaultValue={def} className="input" />
      {help && <p className="mt-0.5 text-xs text-slate-500">{help}</p>}{err && <p className="text-xs text-red-700">{err}</p>}</div>
  );
}

export default function RulesPage() {
  const org = useOrg();
  const base = `/organizations/${org.id}`;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [entities, setEntities] = useState<Array<{ id: string; display_name: string }>>([]);
  const [webhooks, setWebhooks] = useState<Array<{ id: string; name: string; verified_at: string | null }>>([]);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [type, setType] = useState('volume_spike');
  const [dry, setDry] = useState<{ ruleName: string; results: DryResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Array<{ field: string; problems: string[] }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { try { setRules(await api<Rule[]>(`${base}/alert-rules`)); } catch (e) { setError(errorMessage(e)); } }, [base]);
  useEffect(() => {
    void load();
    api<Project[]>(`${base}/projects`).then(setProjects).catch(() => undefined);
    api<Member[]>(`${base}/members`).then(setMembers).catch(() => undefined);
    api<Source[]>(`${base}/sources`).then(setSources).catch(() => undefined);
    api<{ entities: Array<{ id: string; display_name: string }> }>(`${base}/analytics/entities?limit=100`).then((r) => setEntities(r.entities)).catch(() => undefined);
    api<Array<{ id: string; name: string; verified_at: string | null }>>(`${base}/webhooks`).then(setWebhooks).catch(() => undefined);
  }, [base, load]);

  if (!canAlerts.manage(org.role)) return <><PageHeader title="Alert rules" /><Alert tone="info">Alert rules are managed by owners, administrators and project managers.</Alert></>;

  function readForm(form: HTMLFormElement): { projectId: string; name: string; ruleType: string; config: Cfg } {
    const f = new FormData(form); const g = (k: string) => String(f.get(k) ?? '').trim(); const num = (k: string) => (g(k) === '' ? undefined : Number(g(k)));
    const all = (k: string) => f.getAll(k).map(String).filter(Boolean);
    const thresholds: Cfg = {};
    for (const k of ['minMentions', 'relativeChange', 'robustZ', 'minBaselineWindows', 'minPublishers', 'negativeShift', 'minClassified', 'maxUncertainShare', 'minIndependentPublishers', 'concentrationShare', 'uncommonMaxPerWindow']) {
      const v = num(k); if (v !== undefined) thresholds[k] = k === 'negativeShift' || k === 'maxUncertainShare' || k === 'concentrationShare' ? v / 100 : v;
    }
    const escUsers = all('escUsers');
    return {
      projectId: g('projectId'), name: g('name'), ruleType: g('ruleType'),
      config: {
        filters: { entityIds: all('entityIds'), sourceIds: all('sourceIds'), topics: all('topics'), keywords: g('keywords') || null },
        window: { minutes: num('minutes') ?? 60, comparison: g('comparison') || 'same_time_previous_days', baselineWindows: num('baselineWindows') ?? 14 },
        thresholds,
        severity: { minimum: g('minimum') || 'low', floor: g('floor') || null },
        notify: { channels: all('channels'), recipientUserIds: all('recipients'), webhookEndpointIds: all('webhooks') },
        cooldownMinutes: num('cooldownMinutes') ?? 120,
        quietHours: g('qhStart') && g('qhEnd') ? { start: g('qhStart'), end: g('qhEnd'), timezone: g('qhTz') || 'Asia/Jakarta', allowCritical: f.get('qhCritical') === 'on' } : null,
        escalation: num('escAfter') && escUsers.length ? { steps: [{ afterMinutes: num('escAfter'), notifyUserIds: escUsers }] } : null,
      },
    };
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(null); setProblems([]); setNotice(null);
    const body = readForm(e.currentTarget);
    try {
      if (editing === 'new') { await api(`${base}/alert-rules`, { method: 'POST', body }); setNotice('Rule created (version 1).'); }
      else if (editing) { const r = await api<{ version: number }>(`${base}/alert-rules/${editing.id}`, { method: 'PATCH', body: { name: body.name, config: body.config } }); setNotice(`Rule saved (version ${r.version}). Earlier issues keep the version that created them.`); }
      setEditing(null); await load();
    } catch (x) { setError(errorMessage(x)); if (x instanceof ApiError && Array.isArray(x.details)) setProblems(x.details as never); } finally { setBusy(false); }
  }
  async function preview(form: HTMLFormElement) {
    setBusy(true); setError(null); setProblems([]);
    const body = readForm(form);
    try { const r = await api<{ results: DryResult[] }>(`${base}/alert-rules/preview`, { method: 'POST', body: { projectId: body.projectId, ruleType: body.ruleType, config: body.config } }); setDry({ ruleName: body.name || 'Unsaved rule', results: r.results }); }
    catch (x) { setError(errorMessage(x)); if (x instanceof ApiError && Array.isArray(x.details)) setProblems(x.details as never); } finally { setBusy(false); }
  }
  async function test(r: Rule) {
    setBusy(true); setError(null);
    try { const res = await api<{ results: DryResult[] }>(`${base}/alert-rules/${r.id}/test`, { method: 'POST' }); setDry({ ruleName: r.name, results: res.results }); }
    catch (x) { setError(errorMessage(x)); } finally { setBusy(false); }
  }
  async function toggle(r: Rule) {
    try { await api(`${base}/alert-rules/${r.id}`, { method: 'PATCH', body: { isActive: !r.is_active } }); await load(); } catch (x) { setError(errorMessage(x)); }
  }
  async function remove(r: Rule) {
    if (!confirm(`Delete rule “${r.name}”? It stops evaluating; its issues and versions are kept.`)) return;
    try { await api(`${base}/alert-rules/${r.id}`, { method: 'DELETE' }); await load(); } catch (x) { setError(errorMessage(x)); }
  }
  async function evaluateNow() {
    try { await api(`${base}/alert-rules/evaluate`, { method: 'POST' }); setNotice('Evaluation queued; new issues appear within a minute.'); } catch (x) { setError(errorMessage(x)); }
  }

  const c: Cfg = editing && editing !== 'new' ? editing.config : {};
  const t = editing && editing !== 'new' ? editing.rule_type : type;
  const th = c.thresholds ?? {};
  const problem = (field: string) => problems.find((p) => p.field === field || p.field.startsWith(`${field}.`))?.problems.join('; ');
  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/alerts`}>← Issues & alerts</Link></p>
      <PageHeader title="Alert rules" description="Rules turn collected coverage into issues. Every edit creates a new version, and every issue records the version that produced it."
        actions={<><button className="btn-secondary" onClick={() => void evaluateNow()}>Evaluate now</button><button className="btn-primary" onClick={() => { setEditing('new'); setDry(null); setProblems([]); }}>New rule</button></>} />
      <div className="mb-4 space-y-2">{error && <Alert>{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}</div>

      {editing && (
        <form key={editing === 'new' ? 'new' : editing.id} onSubmit={save} className="card mb-6 space-y-5" aria-label="Alert rule">
          <h2 className="font-semibold">{editing === 'new' ? 'New rule' : `Edit “${editing.name}” (now version ${editing.current_version})`}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <div><label className="label" htmlFor="name">Name</label><input id="name" name="name" required minLength={2} maxLength={120} defaultValue={editing === 'new' ? '' : editing.name} className="input" /></div>
            <div><label className="label" htmlFor="projectId">Project</label><select id="projectId" name="projectId" className="input" disabled={editing !== 'new'} defaultValue={editing === 'new' ? projects[0]?.id : editing.project_id}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              {editing !== 'new' && <input type="hidden" name="projectId" value={editing.project_id} />}</div>
            <div><label className="label" htmlFor="ruleType">Signal</label><select id="ruleType" name="ruleType" className="input" disabled={editing !== 'new'} value={t} onChange={(e) => setType(e.target.value)}>{TYPES.map((x) => <option key={x} value={x}>{SIGNAL_LABEL[x]}</option>)}</select>
              {editing !== 'new' && <input type="hidden" name="ruleType" value={t} />}</div>
          </div>
          <p className="text-sm text-slate-600">{RULE_HELP[t]}</p>

          <fieldset className="grid gap-3 md:grid-cols-4"><legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Records considered</legend>
            <div className="md:col-span-2"><label className="label" htmlFor="keywords">Keyword expression {t === 'keyword' ? '(required)' : '(optional filter)'}</label>
              <input id="keywords" name="keywords" defaultValue={c.filters?.keywords ?? ''} className="input" placeholder='e.g. contamination OR "boil water"' />
              {problem('filters.keywords') && <p className="text-xs text-red-700">{problem('filters.keywords')}</p>}</div>
            <div><label className="label" htmlFor="entityIds">Institutions / entities</label><select id="entityIds" name="entityIds" multiple className="input h-24" defaultValue={c.filters?.entityIds ?? []}>{entities.map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}</select></div>
            <div><label className="label" htmlFor="topics">Topics</label><select id="topics" name="topics" multiple className="input h-24" defaultValue={c.filters?.topics ?? []}>{Object.entries(TOPIC_LABEL).filter(([k]) => k !== 'unknown').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div><label className="label" htmlFor="sourceIds">Sources</label><select id="sourceIds" name="sourceIds" multiple className="input h-24" defaultValue={c.filters?.sourceIds ?? []}>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          </fieldset>

          <fieldset className="grid gap-3 md:grid-cols-4"><legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Time window and baseline</legend>
            <div><label className="label" htmlFor="minutes">Window (minutes)</label><input id="minutes" name="minutes" type="number" min={15} max={10080} defaultValue={c.window?.minutes ?? (t === 'emerging_topic' ? 1440 : 60)} className="input" />{problem('window') && <p className="text-xs text-red-700">{problem('window')}</p>}</div>
            <div><label className="label" htmlFor="comparison">Compare with</label><select id="comparison" name="comparison" className="input" defaultValue={c.window?.comparison ?? (t === 'emerging_topic' ? 'previous_windows' : 'same_time_previous_days')}><option value="same_time_previous_days">Same time on previous days</option><option value="previous_windows">Preceding windows</option></select></div>
            <div><label className="label" htmlFor="baselineWindows">Comparison windows</label><input id="baselineWindows" name="baselineWindows" type="number" min={3} max={60} defaultValue={c.window?.baselineWindows ?? 14} className="input" /></div>
            <Field err={problem('cooldownMinutes')} name="cooldownMinutes" label="Notification cooldown" suffix="min" def={c.cooldownMinutes ?? 120} help="No repeat notification for the same issue within this time, unless severity rises." />
          </fieldset>

          <fieldset className="grid gap-3 md:grid-cols-4"><legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Trigger conditions</legend>
            <Field err={problem('thresholds.minMentions')} name="minMentions" label="Minimum records" def={th.minMentions ?? (t === 'keyword' ? 1 : 5)} help="Small counts never alert." />
            {['volume_spike', 'emerging_topic'].includes(t) && <><Field err={problem('thresholds.relativeChange')} name="relativeChange" label="Change vs baseline" suffix="× median" step="0.1" def={th.relativeChange ?? 2} />
              <Field err={problem('thresholds.robustZ')} name="robustZ" label="Robust z-score" step="0.1" def={th.robustZ ?? 3} /><Field err={problem('thresholds.minBaselineWindows')} name="minBaselineWindows" label="Covered windows needed" def={th.minBaselineWindows ?? 5} help="Windows without collection are excluded." /></>}
            {['volume_spike', 'emerging_topic'].includes(t) && <Field err={problem('thresholds.minPublishers')} name="minPublishers" label="Independent publishers" def={th.minPublishers ?? 1} />}
            {t === 'emerging_topic' && <Field err={problem('thresholds.uncommonMaxPerWindow')} name="uncommonMaxPerWindow" label="“Uncommon” = baseline median ≤" step="0.5" def={th.uncommonMaxPerWindow ?? 1} />}
            {t === 'negative_shift' && <><Field err={problem('thresholds.negativeShift')} name="negativeShift" label="Rise in negative share" suffix="points %" def={th.negativeShift ? th.negativeShift * 100 : 15} />
              <Field err={problem('thresholds.minClassified')} name="minClassified" label="Confident classifications per window" def={th.minClassified ?? 20} /><Field err={problem('thresholds.maxUncertainShare')} name="maxUncertainShare" label="Max uncertain" suffix="%" def={th.maxUncertainShare !== undefined ? th.maxUncertainShare * 100 : 50} />
              <Field err={problem('thresholds.minBaselineWindows')} name="minBaselineWindows" label="Covered windows needed" def={th.minBaselineWindows ?? 5} /></>}
            {t === 'story_velocity' && <Field err={problem('thresholds.minIndependentPublishers')} name="minIndependentPublishers" label="Independent publishers" def={th.minIndependentPublishers ?? 3} help="Syndicated copies do not count." />}
            {t === 'source_concentration' && <Field err={problem('thresholds.concentrationShare')} name="concentrationShare" label="Single-publisher share" suffix="%" def={th.concentrationShare ? th.concentrationShare * 100 : 60} />}
            <div><label className="label" htmlFor="minimum">Alert at severity ≥</label><select id="minimum" name="minimum" className="input" defaultValue={c.severity?.minimum ?? 'low'}>{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}</select></div>
            <div><label className="label" htmlFor="floor">Severity floor</label><select id="floor" name="floor" className="input" defaultValue={c.severity?.floor ?? ''}><option value="">None</option>{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}</select><p className="mt-0.5 text-xs text-slate-500">e.g. critical keywords: never below High.</p></div>
          </fieldset>

          <fieldset className="grid gap-3 md:grid-cols-4"><legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Notifications</legend>
            <div><span className="label">Channels</span>{(['in_app', 'email', 'whatsapp'] as const).map((ch) => <label key={ch} className="flex items-center gap-2 text-sm"><input type="checkbox" name="channels" value={ch} defaultChecked={(c.notify?.channels ?? ['in_app']).includes(ch)} />{ch === 'in_app' ? 'In-app' : ch === 'email' ? 'Email' : 'WhatsApp'}</label>)}</div>
            <div><label className="label" htmlFor="recipients">Recipients</label><select id="recipients" name="recipients" multiple className="input h-24" defaultValue={c.notify?.recipientUserIds ?? []}>{members.filter((m) => m.role !== 'report_viewer').map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</select>
              {problem('notify.recipientUserIds') && <p className="text-xs text-red-700">{problem('notify.recipientUserIds')}</p>}<p className="mt-0.5 text-xs text-slate-500">Empty: the rule owner.</p></div>
            <div><label className="label" htmlFor="webhooks">Webhooks</label><select id="webhooks" name="webhooks" multiple className="input h-24" defaultValue={c.notify?.webhookEndpointIds ?? []}>{webhooks.map((w) => <option key={w.id} value={w.id} disabled={!w.verified_at}>{w.name}{w.verified_at ? '' : ' (unverified)'}</option>)}</select></div>
            <div className="space-y-2"><span className="label">Quiet hours (email/WhatsApp deferred)</span>
              <div className="flex gap-2"><input aria-label="Quiet hours start" name="qhStart" type="time" defaultValue={c.quietHours?.start ?? ''} className="input" /><input aria-label="Quiet hours end" name="qhEnd" type="time" defaultValue={c.quietHours?.end ?? ''} className="input" /></div>
              <input aria-label="Time zone" name="qhTz" defaultValue={c.quietHours?.timezone ?? 'Asia/Jakarta'} className="input" />
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="qhCritical" defaultChecked={c.quietHours?.allowCritical ?? true} />Critical issues bypass quiet hours</label></div>
            <div><label className="label" htmlFor="escAfter">Escalate if unacknowledged after (min)</label><input id="escAfter" name="escAfter" type="number" min={5} defaultValue={c.escalation?.steps?.[0]?.afterMinutes ?? ''} className="input" /></div>
            <div><label className="label" htmlFor="escUsers">Escalate to</label><select id="escUsers" name="escUsers" multiple className="input h-24" defaultValue={c.escalation?.steps?.[0]?.notifyUserIds ?? []}>{members.filter((m) => m.role !== 'report_viewer').map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</select></div>
          </fieldset>

          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy}>{editing === 'new' ? 'Create rule' : 'Save as new version'}</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={(e) => void preview(e.currentTarget.form!)}>Dry run on current data</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      {dry && (
        <section className="card mb-6" aria-labelledby="dry-h">
          <div className="flex items-center justify-between"><h2 id="dry-h" className="font-semibold">Dry run: {dry.ruleName}</h2><button className="text-sm text-brand-700 underline" onClick={() => setDry(null)}>Close</button></div>
          <p className="text-xs text-slate-500">Evaluated against current data. Nothing was created or sent.</p>
          {dry.results.length === 0 ? <p className="mt-2 text-sm text-slate-600">No candidates (no matching records in the window).</p> : (
            <ul className="mt-3 space-y-3 text-sm">{dry.results.map((r, i) => (
              <li key={i} className="rounded border border-slate-200 p-3">
                <p className="flex flex-wrap items-center gap-2">{r.triggered ? <Badge tone="red">Would trigger</Badge> : <Badge>Would not trigger</Badge>}{r.severity && <SeverityBadge severity={r.severity.severity} />}<span className="font-medium">{r.title || r.subject}</span></p>
                {r.suppressed && <p className="mt-1 text-slate-600">Suppressed: {r.suppressed.reason.replace(/_/g, ' ')} ({r.suppressed.detail})</p>}
                <p className="mt-1 text-xs text-slate-600">Method {r.method} · observed {Object.entries(r.observed).map(([k, v]) => `${k} ${v}`).join(', ')}{Object.keys(r.baseline).length ? ` · baseline ${Object.entries(r.baseline).map(([k, v]) => `${k} ${v ?? '—'}`).join(', ')}` : ''} · exceeded: {r.exceeded.join(', ') || 'none'} · {r.evidenceCount} records</p>
                {r.limitations.length > 0 && <p className="mt-1 text-xs text-amber-800">{r.limitations.join(' ')}</p>}
              </li>
            ))}</ul>
          )}
        </section>
      )}

      {!rules && !error && <Loading />}
      {rules && rules.length === 0 && <Empty title="No alert rules yet">Create a rule to start detecting issues. A dry run shows what it would detect on the data already collected.</Empty>}
      {rules && rules.length > 0 && (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-2">Rule</th><th>Signal</th><th>Project</th><th>Version</th><th className="text-right">Open issues</th><th>Last triggered</th><th>Status</th><th className="px-4" /></tr></thead>
          <tbody>{rules.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-4 py-2 font-medium">{r.name}<span className="block text-xs font-normal text-slate-500">owner {r.owner_name ?? '—'} · updated {fmtDate(r.updated_at)}</span></td>
              <td className="text-xs">{SIGNAL_LABEL[r.rule_type] ?? r.rule_type}</td><td className="text-xs">{r.project_name}</td><td>v{r.current_version}</td>
              <td className="text-right tabular-nums">{r.open_issues}</td><td className="text-xs">{r.last_triggered_at ? relTime(r.last_triggered_at) : 'never'}</td>
              <td>{r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>}</td>
              <td className="whitespace-nowrap px-4 text-right">
                <button className="text-xs text-brand-700 underline" onClick={() => void test(r)} disabled={busy}>Dry run</button>{' · '}
                <button className="text-xs text-brand-700 underline" onClick={() => { setEditing(r); setDry(null); setProblems([]); }}>Edit</button>{' · '}
                <button className="text-xs text-brand-700 underline" onClick={() => void toggle(r)}>{r.is_active ? 'Disable' : 'Enable'}</button>{' · '}
                <button className="text-xs text-red-700 underline" onClick={() => void remove(r)}>Delete</button>
              </td>
            </tr>
          ))}</tbody></table></div>
      )}
    </>
  );
}
