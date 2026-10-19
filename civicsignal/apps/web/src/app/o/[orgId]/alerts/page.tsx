'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SeverityBadge, StatusBadge } from '@/components/alerts-ui';
import { ToneChart, VolumeChart, type VolumePoint } from '@/components/charts';
import { useOrg } from '@/components/org-context';
import { Alert, Empty, Loading, PageHeader, Stat } from '@/components/ui';
import { TOPIC_LABEL, topicLabel } from '@/lib/ai';
import { ago, canAlerts, SCOPE_LABEL, SEVERITIES, SEVERITY_LABEL, SIGNAL_LABEL, STATUS_LABEL, STATUSES, type IssueListItem, type Severity } from '@/lib/alerts';
import { api, errorMessage, fmtDate, relTime, type Member, type Project, type Source } from '@/lib/api';

interface Dashboard {
  generatedAt: string; range: { from: string; to: string };
  counts: Array<{ severity: Severity; status: string; n: number }>;
  series: Array<{ day: string; mentions: number; publishers_max: number; positive: number; negative: number; neutral: number; mixed: number; uncertain: number; refreshed_at: string }>;
  coverage: Array<{ day: string; runs: number }>;
  emerging: Array<{ topic_key: string; n: number; pubs: number; prior_per_3_days: string; custom_label: string | null }>;
  active: Array<{ id: string; title: string; severity: Severity; status: string; signal: string; scope: string; first_detected_at: string; acknowledged_at: string | null; independent_publishers: number; evidence_count: number }>;
  timeline: Array<{ event: string; at: string; from_status: string | null; to_status: string | null; issue_id: string; title: string; severity: Severity }>;
  clusters: Array<{ id: string; label: string; member_count: number; independent_count: number; publisher_count: number; issues: number }>;
  freshness: Array<{ id: string; name: string; enabled: boolean; refresh_interval_seconds: number; last_success_at: string | null; consecutive_failures: number }>;
  lastEvaluation: { finished_at: string; status: string; rules_evaluated: number } | null;
  notes: string[];
}
interface F { days: string; projectId: string; severity: string; status: string; assignedTo: string; topic: string; entityId: string; sourceId: string }
const EMPTY: F = { days: '14', projectId: '', severity: '', status: 'open', assignedTo: '', topic: '', entityId: '', sourceId: '' };

export default function AlertsDashboard() {
  const org = useOrg();
  const [f, setF] = useState<F>(EMPTY);
  const [d, setD] = useState<Dashboard | null>(null);
  const [list, setList] = useState<{ total: number; items: IssueListItem[] } | null>(null);
  const [detections, setDetections] = useState<IssueListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [entities, setEntities] = useState<Array<{ id: string; display_name: string }>>([]);
  const base = `/organizations/${org.id}`;

  useEffect(() => {
    api<Project[]>(`${base}/projects`).then(setProjects).catch(() => undefined);
    api<Source[]>(`${base}/sources`).then(setSources).catch(() => undefined);
    api<Member[]>(`${base}/members`).then(setMembers).catch(() => undefined);
    api<{ entities: Array<{ id: string; display_name: string }> }>(`${base}/analytics/entities?limit=50`).then((r) => setEntities(r.entities)).catch(() => undefined);
  }, [base]);

  const qs = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    const to = new Date(); const from = new Date(to.getTime() - Number(f.days) * 86_400_000);
    p.set('from', from.toISOString()); p.set('to', to.toISOString());
    for (const k of ['projectId', 'severity', 'assignedTo', 'topic', 'entityId', 'sourceId'] as const) if (f[k]) p.set(k, f[k]);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }, [f]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [dash, l, det] = await Promise.all([
        api<Dashboard>(`${base}/issues/dashboard?${qs()}`),
        api<{ total: number; items: IssueListItem[] }>(`${base}/issues?${qs({ ...(f.status ? { status: f.status } : {}), limit: '50' })}`),
        api<{ total: number; items: IssueListItem[] }>(`${base}/issues?${qs({ limit: '200' })}`),
      ]);
      setD(dash); setList(l); setDetections(det.items);
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [base, qs, f.status]);
  useEffect(() => { void load(); }, [load]);

  const volume: VolumePoint[] = useMemo(() => {
    if (!d) return [];
    const days: string[] = []; const end = new Date(d.range.to); const start = new Date(d.range.from);
    for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= end.getTime(); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
    const cov = new Set(d.coverage.map((c) => c.day));
    return days.map((day) => {
      const s = d.series.find((x) => x.day === day);
      return { day, mentions: s?.mentions ?? (cov.has(day) ? 0 : null), covered: cov.has(day) || !!s, publishers: s?.publishers_max ?? null,
        detections: detections.filter((i) => i.first_detected_at.slice(0, 10) === day).length };
    });
  }, [d, detections]);

  if (!canAlerts.read(org.role)) return <><PageHeader title="Issues & alerts" /><Alert tone="info">Your role includes reports only.</Alert></>;
  const open = (sev: Severity[]) => (d?.counts ?? []).filter((c) => sev.includes(c.severity) && !['resolved', 'closed'].includes(c.status)).reduce((n, c) => n + c.n, 0);
  const awaiting = (d?.counts ?? []).filter((c) => ['detected', 'pending_review'].includes(c.status)).reduce((n, c) => n + c.n, 0);
  const set = (k: keyof F) => (e: React.ChangeEvent<HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Issues & alerts" description="Issues detected by your alert rules from collected coverage. Each one shows why it triggered, the thresholds exceeded, and the source records. Detection is automated; verify before acting."
        actions={<>{canAlerts.manage(org.role) && <Link className="btn-secondary" href={`/o/${org.id}/alerts/rules`}>Alert rules</Link>}<Link className="btn-secondary" href={`/o/${org.id}/notifications`}>Notifications</Link></>} />
      <form className="mb-6 flex flex-wrap items-end gap-3" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <div><label className="label" htmlFor="days">Date range</label>
          <select id="days" className="input" value={f.days} onChange={set('days')}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></div>
        <div><label className="label" htmlFor="projectId">Project</label>
          <select id="projectId" className="input" value={f.projectId} onChange={set('projectId')}><option value="">All visible</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label className="label" htmlFor="entityId">Institution / entity</label>
          <select id="entityId" className="input max-w-48" value={f.entityId} onChange={set('entityId')}><option value="">Any</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}</select></div>
        <div><label className="label" htmlFor="topic">Topic</label>
          <select id="topic" className="input" value={f.topic} onChange={set('topic')}><option value="">Any</option>{Object.entries(TOPIC_LABEL).filter(([k]) => k !== 'unknown').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label className="label" htmlFor="severity">Severity</label>
          <select id="severity" className="input" value={f.severity} onChange={set('severity')}><option value="">Any</option>{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}</select></div>
        <div><label className="label" htmlFor="sourceId">Source</label>
          <select id="sourceId" className="input max-w-44" value={f.sourceId} onChange={set('sourceId')}><option value="">Any</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label className="label" htmlFor="status">Status</label>
          <select id="status" className="input" value={f.status} onChange={set('status')}><option value="open">Open (not resolved)</option><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></div>
        <div><label className="label" htmlFor="assignedTo">Assigned analyst</label>
          <select id="assignedTo" className="input" value={f.assignedTo} onChange={set('assignedTo')}><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option>{members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</select></div>
        <button type="button" className="btn-secondary" onClick={() => setF(EMPTY)}>Reset</button>
      </form>
      {error && <Alert>{error}</Alert>}
      {!d && !error && <Loading />}
      {d && (
        <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid gap-4 md:grid-cols-4">
            <Stat label="Open critical" value={open(['critical'])} note="Not yet resolved" />
            <Stat label="Open high" value={open(['high'])} note="Not yet resolved" />
            <Stat label="Awaiting acknowledgement" value={awaiting} note="Detected or pending review" />
            <Stat label="Last evaluation" value={d.lastEvaluation ? relTime(d.lastEvaluation.finished_at) : 'never'} note={d.lastEvaluation ? `${d.lastEvaluation.rules_evaluated} active rule(s)` : 'No rule has been evaluated yet'} />
          </div>

          <section className="card" aria-labelledby="hp-h">
            <h2 id="hp-h" className="font-semibold">Active high-priority issues</h2>
            {d.active.length === 0 ? <p className="mt-2 text-sm text-slate-500">No open high or critical issues in this view.</p> : (
              <ul className="mt-3 divide-y divide-slate-100">{d.active.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2"><SeverityBadge severity={i.severity} /><Link className="truncate font-medium text-brand-700 hover:underline" href={`/o/${org.id}/alerts/${i.id}`}>{i.title}</Link></span>
                  <span className="flex items-center gap-3 text-xs text-slate-600"><StatusBadge status={i.status as never} />{i.evidence_count} records · {i.independent_publishers} independent publishers · detected {ago(i.first_detected_at)} ago{!i.acknowledged_at && <strong className="text-[#a32424]">not acknowledged</strong>}</span>
                </li>
              ))}</ul>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card"><h2 className="mb-3 font-semibold">Coverage volume</h2><VolumeChart points={volume} />
              <p className="mt-2 text-xs text-slate-500">Original records matched to {f.projectId ? 'the project' : 'your projects'} per UTC day (a record matching two projects counts once per project). Updated {d.series.length ? relTime(d.series.at(-1)!.refreshed_at) : '—'}.</p></section>
            <section className="card"><h2 className="mb-3 font-semibold">Tone of coverage</h2><ToneChart points={d.series} />
              <p className="mt-2 text-xs text-slate-500">Automated estimates. Uncertain classifications are excluded from the shares and listed in the table.</p></section>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="card"><h2 className="font-semibold">Emerging topics</h2><p className="text-xs text-slate-500">Last 3 days vs the 11 days before (scaled to 3 days)</p>
              {d.emerging.length === 0 ? <p className="mt-2 text-sm text-slate-500">No analysed topics in this range.</p> : (
                <table className="mt-2 w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr><th>Topic</th><th className="text-right">Now</th><th className="text-right">Before</th><th className="text-right">Publishers</th></tr></thead>
                  <tbody>{d.emerging.map((e) => <tr key={e.topic_key} className="border-t border-slate-100"><td className="py-1">{e.custom_label ?? topicLabel(e.topic_key)}</td><td className="text-right tabular-nums">{e.n}</td><td className="text-right tabular-nums text-slate-500">{e.prior_per_3_days}</td><td className="text-right tabular-nums">{e.pubs}</td></tr>)}</tbody></table>
              )}</section>
            <section className="card"><h2 className="font-semibold">Related stories</h2><p className="text-xs text-slate-500">Story clusters behind open issues</p>
              {d.clusters.length === 0 ? <p className="mt-2 text-sm text-slate-500">None.</p> : <ul className="mt-2 space-y-2 text-sm">{d.clusters.map((c) => <li key={c.id}><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/stories/${c.id}`}>{c.label}</Link><span className="block text-xs text-slate-500">{c.member_count} records · {c.independent_count} independent · {c.issues} issue(s)</span></li>)}</ul>}</section>
            <section className="card"><h2 className="font-semibold">Collection freshness</h2><p className="text-xs text-slate-500">Alerts are only as current as collection</p>
              <ul className="mt-2 space-y-1 text-sm">{d.freshness.slice(0, 8).map((s) => {
                const stale = s.enabled && (!s.last_success_at || Date.now() - new Date(s.last_success_at).getTime() > Math.max(6 * 3_600_000, 3 * s.refresh_interval_seconds * 1000));
                return <li key={s.id} className="flex justify-between gap-2"><span className="truncate">{s.name}</span><span className={`text-xs ${stale ? 'text-[#a32424]' : 'text-slate-600'}`}>{stale ? '⚠ ' : ''}{s.enabled ? relTime(s.last_success_at) : 'disabled'}</span></li>;
              })}</ul></section>
          </div>

          <section className="card"><h2 className="font-semibold">Issue timeline</h2>
            {d.timeline.length === 0 ? <p className="mt-2 text-sm text-slate-500">No events.</p> : <ol className="mt-2 space-y-1 text-sm">{d.timeline.map((e, i) => (
              <li key={i} className="flex gap-3"><time className="w-36 shrink-0 text-xs text-slate-500" dateTime={e.at}>{fmtDate(e.at)}</time>
                <span><SeverityBadge severity={e.severity} /> <Link className="text-brand-700 hover:underline" href={`/o/${org.id}/alerts/${e.issue_id}`}>{e.title}</Link> <span className="text-slate-600">· {e.event === 'status_changed' ? `${STATUS_LABEL[e.from_status as never] ?? e.from_status} → ${STATUS_LABEL[e.to_status as never] ?? e.to_status}` : e.event.replace(/_/g, ' ')}</span></span></li>
            ))}</ol>}</section>

          <section className="card"><h2 className="font-semibold">Issues ({list?.total ?? 0})</h2>
            {list && list.items.length === 0 ? <div className="mt-3"><Empty title="No issues match">Issues appear when an active alert rule's thresholds are exceeded.{canAlerts.manage(org.role) && <> <Link className="text-brand-700 underline" href={`/o/${org.id}/alerts/rules`}>Configure rules</Link>.</>}</Empty></div> : (
              <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-500"><tr><th className="py-2">Severity</th><th>Issue</th><th>Status</th><th>Signal / scope</th><th className="px-2 text-right">Records</th><th className="px-2 text-right">Indep. publishers</th><th className="px-2">Detected</th><th className="px-2">Assigned</th></tr></thead>
                <tbody>{list?.items.map((i) => (
                  <tr key={i.id} className="border-t border-slate-100 align-top">
                    <td className="py-2"><SeverityBadge severity={i.severity} /></td>
                    <td className="max-w-md"><Link className="font-medium text-brand-700 hover:underline" href={`/o/${org.id}/alerts/${i.id}`}>{i.title}</Link><span className="block text-xs text-slate-500">{i.project_name} · rule “{i.rule_name}” v{i.rule_version}{i.related_count ? ` · ${i.related_count} related` : ''}</span></td>
                    <td><StatusBadge status={i.status} />{i.escalation_level > 0 && <span className="block text-xs text-[#a32424]">escalated ×{i.escalation_level}</span>}</td>
                    <td className="text-xs">{SIGNAL_LABEL[i.signal] ?? i.signal}<span className="block text-slate-500">{SCOPE_LABEL[i.scope]}</span></td>
                    <td className="px-2 text-right tabular-nums">{i.evidence_count}</td><td className="px-2 text-right tabular-nums">{i.independent_publishers}</td>
                    <td className="whitespace-nowrap px-2 text-xs">{ago(i.first_detected_at)} ago</td><td className="px-2 text-xs">{i.assigned_to_name ?? '—'}</td>
                  </tr>
                ))}</tbody></table></div>
            )}</section>
          <ul className="list-disc pl-5 text-xs text-slate-500">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </>
  );
}
