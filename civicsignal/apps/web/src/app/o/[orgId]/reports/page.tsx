'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, can, errorMessage, fmtDate, type Member, type Project } from '@/lib/api';
import { zonedMidnight } from '@/lib/analytics';
import { canReports, describeSchedule, fmtBytes, RUN_STATUS_LABEL, RUN_STATUS_TONE, TEMPLATE_LABEL, WEEKDAYS, type Definition, type RunListItem, type Schedule, type Template, type TemplateKey } from '@/lib/reports';

const DL = (org: string, run: string, f: string) => `/api/v1/organizations/${org}/reports/runs/${run}/download/${f}`;

export default function ReportsPage() {
  const org = useOrg();
  const base = `/organizations/${org.id}`;
  const tz = org.settings?.timezone || 'Asia/Jakarta';
  const mayGenerate = canReports.generate(org.role);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [defs, setDefs] = useState<Definition[] | null>(null);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [entities, setEntities] = useState<Array<{ id: string; name?: string; type?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, d, r, s] = await Promise.all([api<{ templates: Template[] }>(`${base}/reports/templates`), api<{ definitions: Definition[] }>(`${base}/reports/definitions`),
        api<{ runs: RunListItem[] }>(`${base}/reports/runs?limit=30`), api<{ schedules: Schedule[] }>(`${base}/report-schedules`)]);
      setTemplates(t.templates); setDefs(d.definitions); setRuns(r.runs); setSchedules(s.schedules);
    } catch (e) { setError(errorMessage(e)); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!mayGenerate) return;
    api<Project[]>(`${base}/projects`).then(setProjects).catch(() => undefined);
    if (can.readMembers(org.role)) api<Member[]>(`${base}/members`).then(setMembers).catch(() => undefined);
    api<{ entities: Array<{ id: string; name?: string; type?: string }> }>(`${base}/analytics/entities?days=366&limit=100`).then((r) => setEntities(r.entities)).catch(() => undefined);
  }, [base, mayGenerate, org.role]);
  // Poll while something is generating.
  useEffect(() => {
    if (!runs?.some((r) => r.status === 'queued' || r.status === 'running')) return;
    const h = setInterval(() => void load(), 4000);
    return () => clearInterval(h);
  }, [runs, load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget); const g = (k: string) => String(f.get(k) ?? '').trim();
    const body = { projectId: g('projectId'), template: g('template'), name: g('name'), language: g('language'), aiCommentary: f.get('aiCommentary') === 'on',
      params: { entityIds: f.getAll('entityIds').map(String).slice(0, 10), includeCsv: f.get('includeCsv') === 'on', maxSources: Number(g('maxSources') || 10), analystNote: g('analystNote') || null } };
    void act(async () => { await api(`${base}/reports/definitions`, { method: 'POST', body }); setCreating(false); }, 'Report definition saved.');
  }
  function generate(d: Definition, e?: FormEvent<HTMLFormElement>) {
    let body: Record<string, string> = {};
    if (e) {
      e.preventDefault();
      const f = new FormData(e.currentTarget); const from = String(f.get('from') ?? ''); const to = String(f.get('to') ?? '');
      if (from && to) {
        const [y, m, dd] = to.split('-').map(Number) as [number, number, number];
        body = { periodStart: zonedMidnight(from, tz).toISOString(), periodEnd: zonedMidnight(new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10), tz).toISOString() };
      }
    }
    void act(() => api(`${base}/reports/definitions/${d.id}/generate`, { method: 'POST', body }), `Generating “${d.name}”. It appears in the history below when ready.`);
  }
  function schedule(defId: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget); const g = (k: string) => String(f.get(k) ?? '');
    const freq = g('frequency');
    const body = { definitionId: defId, frequency: freq, timeOfDay: g('timeOfDay') || '07:00', dayOfWeek: freq === 'weekly' ? Number(g('dayOfWeek')) : null,
      dayOfMonth: freq === 'monthly' ? Number(g('dayOfMonth')) : null, periodDays: freq === 'custom' ? Number(g('periodDays')) : null,
      recipientUserIds: f.getAll('recipients').map(String), channels: f.getAll('channels').map(String) };
    void act(async () => { await api(`${base}/report-schedules`, { method: 'POST', body }); setScheduling(null); }, 'Schedule created.');
  }

  return (
    <>
      <PageHeader title="Reports" description="Source-backed PDF and CSV reports from stored data. Figures are calculated deterministically; optional AI commentary is validated against the cited records and labelled as interpretation."
        actions={mayGenerate ? <button className="btn-primary" onClick={() => setCreating(!creating)} aria-expanded={creating}>{creating ? 'Close' : 'New report'}</button> : undefined} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {notice && <div className="mb-4"><Alert tone="success">{notice}</Alert></div>}

      {creating && (
        <form onSubmit={create} className="card mb-6 grid gap-3 md:grid-cols-3" aria-label="New report definition">
          <div><label className="label" htmlFor="name">Name</label><input id="name" name="name" required minLength={2} maxLength={120} className="input" /></div>
          <div><label className="label" htmlFor="projectId">Project</label><select id="projectId" name="projectId" required className="input">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div><label className="label" htmlFor="template">Template</label><select id="template" name="template" className="input">{templates.map((t) => <option key={t.key} value={t.key}>{TEMPLATE_LABEL[t.key]}</option>)}</select></div>
          <div><label className="label" htmlFor="language">Report language</label><select id="language" name="language" className="input"><option value="id">Bahasa Indonesia</option><option value="en">English</option></select></div>
          <div><label className="label" htmlFor="maxSources">Cited records per section</label><input id="maxSources" name="maxSources" type="number" min={3} max={25} defaultValue={10} className="input" /></div>
          <div className="flex flex-col justify-end gap-1 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="includeCsv" defaultChecked /> Include CSV of articles</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="aiCommentary" /> Optional AI commentary (validated; needs a configured AI provider)</label></div>
          <div className="md:col-span-2"><label className="label" htmlFor="entityIds">Entities for share of voice / policy monitoring (optional, up to 10)</label>
            <select id="entityIds" name="entityIds" multiple className="input h-24">{entities.map((e) => <option key={e.id} value={e.id}>{e.name}{e.type ? ` (${e.type.replace(/_/g, ' ')})` : ''}</option>)}</select></div>
          <div><label className="label" htmlFor="analystNote">Analyst note (optional, shown as an analyst recommendation)</label><textarea id="analystNote" name="analystNote" maxLength={2000} className="input h-24" /></div>
          <ul className="text-xs text-slate-600 md:col-span-3">{templates.map((t) => <li key={t.key}><strong>{TEMPLATE_LABEL[t.key]}:</strong> {t.description}</li>)}</ul>
          <div className="md:col-span-3"><button className="btn-primary" disabled={busy}>Save definition</button></div>
        </form>
      )}

      <section className="mb-8" aria-labelledby="defs">
        <h2 id="defs" className="mb-3 text-lg font-semibold">Report definitions</h2>
        {!defs ? <Loading /> : defs.length === 0 ? <Empty title="No reports defined">{mayGenerate ? 'Create one with “New report”.' : 'Reports shared with you appear in the history below.'}</Empty> : (
          <div className="space-y-3">{defs.map((d) => (
            <div key={d.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="font-medium text-slate-900">{d.name}</p>
                  <p className="text-xs text-slate-500">{TEMPLATE_LABEL[d.template]} · {d.projectName} · {d.language === 'id' ? 'Bahasa Indonesia' : 'English'}{d.aiCommentary ? ' · AI commentary' : ''}{d.activeSchedules ? ` · ${d.activeSchedules} schedule(s)` : ''}</p>
                  {d.lastRun && <p className="mt-1 text-xs">Last run: <Badge tone={RUN_STATUS_TONE[d.lastRun.status]}>{RUN_STATUS_LABEL[d.lastRun.status]}</Badge> <Link className="text-brand-700 underline" href={`/o/${org.id}/reports/runs/${d.lastRun.id}`}>open</Link></p>}</div>
                {mayGenerate && <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary" disabled={busy} onClick={() => generate(d)}>Generate previous period</button>
                  <button className="btn-secondary" onClick={() => setScheduling(scheduling === d.id ? null : d.id)} aria-expanded={scheduling === d.id}>Schedule</button>
                  <button className="btn-secondary" disabled={busy} onClick={() => { if (confirm(`Delete “${d.name}”? Its schedules stop; generated reports stay in the history until they expire.`)) void act(() => api(`${base}/reports/definitions/${d.id}`, { method: 'DELETE' }), 'Definition deleted.'); }}>Delete</button></div>}
              </div>
              {mayGenerate && <form onSubmit={(e) => generate(d, e)} className="mt-3 flex flex-wrap items-end gap-2 text-sm" aria-label={`Custom period for ${d.name}`}>
                <div><label className="label" htmlFor={`f-${d.id}`}>From</label><input id={`f-${d.id}`} name="from" type="date" required className="input" /></div>
                <div><label className="label" htmlFor={`t-${d.id}`}>To (inclusive)</label><input id={`t-${d.id}`} name="to" type="date" required className="input" /></div>
                <button className="btn-secondary" disabled={busy}>Generate custom period</button><span className="text-xs text-slate-500">Dates are whole days in {tz}.</span></form>}
              {scheduling === d.id && (
                <form onSubmit={(e) => schedule(d.id, e)} className="mt-4 grid gap-3 border-t border-slate-200 pt-4 md:grid-cols-4" aria-label={`Schedule ${d.name}`}>
                  <div><label className="label" htmlFor="frequency">Frequency</label><select id="frequency" name="frequency" className="input" defaultValue={templates.find((t) => t.key === d.template)?.defaultFrequency === 'custom' ? 'weekly' : templates.find((t) => t.key === d.template)?.defaultFrequency}>
                    <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="custom">Every N days</option></select></div>
                  <div><label className="label" htmlFor="timeOfDay">Time ({tz})</label><input id="timeOfDay" name="timeOfDay" type="time" defaultValue="07:00" className="input" /></div>
                  <div><label className="label" htmlFor="dayOfWeek">Weekday (weekly)</label><select id="dayOfWeek" name="dayOfWeek" className="input">{WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select></div>
                  <div><label className="label" htmlFor="dayOfMonth">Day of month (monthly)</label><input id="dayOfMonth" name="dayOfMonth" type="number" min={1} max={28} defaultValue={1} className="input" /></div>
                  <div><label className="label" htmlFor="periodDays">N days (custom)</label><input id="periodDays" name="periodDays" type="number" min={1} max={92} defaultValue={14} className="input" /></div>
                  <div className="md:col-span-2"><label className="label" htmlFor="recipients">Recipients (members with access to this project)</label>
                    <select id="recipients" name="recipients" multiple className="input h-24">{members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name} ({m.email})</option>)}</select>
                    <p className="mt-1 text-xs text-slate-500">Empty = only you. Recipients are re-checked at every delivery.</p></div>
                  <fieldset className="text-sm"><legend className="label">Channels</legend>
                    <label className="flex items-center gap-2"><input type="checkbox" name="channels" value="in_app" defaultChecked /> In-app</label>
                    <label className="flex items-center gap-2"><input type="checkbox" name="channels" value="email" /> Email (link only, sign-in required)</label></fieldset>
                  <div className="md:col-span-4"><button className="btn-primary" disabled={busy}>Create schedule</button></div>
                </form>
              )}
            </div>))}</div>
        )}
      </section>

      <section className="mb-8" aria-labelledby="scheds">
        <h2 id="scheds" className="mb-3 text-lg font-semibold">Schedules</h2>
        {schedules.length === 0 ? <p className="text-sm text-slate-500">No schedules.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm"><thead><tr className="text-xs text-slate-500"><th>Report</th><th>When</th><th>Next run</th><th>Recipients</th><th>Status</th><th /></tr></thead>
            <tbody>{schedules.map((s) => (
              <tr key={s.id} className="border-t border-slate-100"><td>{s.definitionName}</td><td className="text-xs">{describeSchedule(s)}</td><td className="text-xs">{s.isActive ? fmtDate(s.nextRunAt) : '—'}</td>
                <td className="text-xs">{s.recipientUserIds.length} · {s.channels.join(', ')}</td>
                <td>{s.cancelledAt ? <Badge tone="amber">Cancelled</Badge> : s.isActive ? <Badge tone="green">Active</Badge> : <Badge>Paused</Badge>}{s.consecutiveFailures > 0 && <span className="ml-1 text-xs text-red-700">{s.consecutiveFailures} failed in a row</span>}</td>
                <td>{mayGenerate && !s.cancelledAt && <span className="flex gap-2">
                  <button className="text-xs text-brand-700 underline" onClick={() => void act(() => api(`${base}/report-schedules/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }), s.isActive ? 'Schedule paused.' : 'Schedule resumed.')}>{s.isActive ? 'Pause' : 'Resume'}</button>
                  <button className="text-xs text-red-700 underline" onClick={() => void act(() => api(`${base}/report-schedules/${s.id}/cancel`, { method: 'POST' }), 'Schedule cancelled.')}>Cancel</button></span>}</td></tr>))}</tbody></table></div>
        )}
      </section>

      <section aria-labelledby="history">
        <h2 id="history" className="mb-3 text-lg font-semibold">History</h2>
        {!runs ? <Loading /> : runs.length === 0 ? <Empty title="No reports generated yet" /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[44rem] text-left text-sm"><thead><tr className="text-xs text-slate-500"><th>Report</th><th>Period</th><th>Trigger</th><th>Status</th><th>Files</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/reports/runs/${r.id}`}>{r.name}</Link><span className="block text-xs text-slate-500">{TEMPLATE_LABEL[r.template as TemplateKey]}</span></td>
                <td className="text-xs">{new Date(r.period_start).toLocaleDateString('en-GB', { timeZone: r.timezone })} – {new Date(new Date(r.period_end).getTime() - 1).toLocaleDateString('en-GB', { timeZone: r.timezone })}</td>
                <td className="text-xs">{r.trigger}</td>
                <td><Badge tone={RUN_STATUS_TONE[r.status]}>{RUN_STATUS_LABEL[r.status]}</Badge>{r.error && <span className="block max-w-xs text-xs text-red-700">{r.error}</span>}</td>
                <td className="text-xs">{(r.artifacts ?? []).map((a) => a.expired ? <span key={a.format} className="mr-2 text-slate-500">{a.format.toUpperCase()} expired</span>
                  : <a key={a.format} className="mr-2 text-brand-700 underline" href={DL(org.id, r.id, a.format)}>{a.format.toUpperCase()} ({fmtBytes(a.sizeBytes)})</a>)}</td></tr>))}</tbody></table></div>
        )}
      </section>
    </>
  );
}
