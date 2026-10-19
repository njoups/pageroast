'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Provenance, SentimentBadge } from '@/components/ai';
import { SeverityBadge, StatusBadge } from '@/components/alerts-ui';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Loading, PageHeader } from '@/components/ui';
import { ENTITY_TYPE_LABEL, topicLabel, type Sentiment } from '@/lib/ai';
import { ago, canAlerts, SCOPE_LABEL, SIGNAL_LABEL, STATUS_LABEL, type IssueStatus, type Severity } from '@/lib/alerts';
import { api, errorMessage, fmtDate, type Member } from '@/lib/api';

interface Factor { factor: string; value: string | number | null; points: number; rule: string }
interface Detail {
  issue: {
    id: string; title: string; status: IssueStatus; severity: Severity; severity_points: number; scope: string; signal: string; subject_type: string; subject_key: string;
    first_detected_at: string; last_detected_at: string; updated_at: string; occurrence_count: number; escalation_level: number; rule_version: number;
    acknowledged_at: string | null; resolution_reason: string | null; resolved_at: string | null; closed_at: string | null; assigned_to: string | null; assignee: { id: string; display_name: string } | null;
    severity_breakdown: { factors: Factor[]; caps: string[]; points: number };
    detection: { method: string; observed: Record<string, number>; baseline: Record<string, number | null>; thresholds: Record<string, number>; exceeded: string[]; limitations: string[];
      suppressed: unknown; reviewSteps: string[]; evaluatedAt: string; ruleVersion: number };
    ai_summary: null | { method: string; provider: string | null; model: string | null; status: string; claims: Array<{ kind: string; text: string; supportingMentionIds: string[] }>;
      conflicts?: Array<{ description: string; supportingMentionIds: string[] }>; uncertainty: string[]; generatedAt: string };
  };
  rule: { id: string; name: string; rule_type: string; is_active: boolean; deleted_at: string | null; current_version: number; version: number; config: Record<string, unknown>; version_created_at: string };
  evidence: Array<{ id: string; title: string; url: string; publisher: string; publisher_domain: string; published_at: string | null; discovered_at: string; source_name: string; cluster_id: string | null;
    is_syndicated: boolean; sentiment: Sentiment | null; sentiment_uncertain: boolean | null; topics: string[] }>;
  totals: { records: number; publishers: number; independent_publishers: number; syndicated: number };
  sentiment: Array<{ label: string; n: number; uncertain: number }>;
  topics: Array<{ topic_key: string; custom_label: string | null; n: number }>;
  entities: Array<{ id: string; display_name: string; entity_type: string; n: number }>;
  clusters: Array<{ id: string; label: string; member_count: number; independent_count: number; publisher_count: number; status: string; in_issue: number }>;
  events: Array<{ id: string; event: string; from_status: string | null; to_status: string | null; details: Record<string, unknown>; at: string; actor_name: string | null }>;
  notes: Array<{ id: string; body: string; created_at: string; author_name: string | null }>;
  assignments: Array<{ assigned_to_name: string | null; assigned_by_name: string | null; assigned_at: string; unassigned_at: string | null }>;
  related: Array<{ id: string; title: string; severity: Severity; status: IssueStatus; signal: string; last_detected_at: string }>;
  deliveries: Array<{ channel: string; status: string; n: number }>;
  disclaimer: string;
}

const LABEL: Record<string, string> = {
  minMentions: 'Minimum records', relativeChange: 'Ratio to baseline median', robustZ: 'Robust z-score', minBaselineWindows: 'Covered comparison windows', minPublishers: 'Independent publishers',
  negativeShift: 'Increase in negative share', minClassified: 'Confident classifications', maxUncertainShare: 'Max uncertain share', zThreshold: 'z statistic',
  minIndependentPublishers: 'Independent publishers', concentrationShare: 'Single-publisher share', mentions: 'Records', ratio: 'Ratio to baseline', publishers: 'Publishers',
  independentPublishers: 'Independent publishers', negativeShare: 'Negative share', shift: 'Shift', z: 'z statistic', confident: 'Confident classifications', uncertainShare: 'Uncertain share',
  median: 'Median', mean: 'Mean', stdev: 'Std. deviation', mad: 'MAD', windows: 'Covered windows', share: 'Share', windowTotal: 'Records in window', syndicatedCopies: 'Syndicated copies',
  records: 'Records', uncommonMaxPerWindow: 'Previously uncommon (median ≤)',
};
const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : v === null || v === undefined ? '—' : String(v));
const ACTIONS: Record<IssueStatus, Array<{ to: string; label: string; needsReason?: boolean; manage?: boolean }>> = {
  detected: [{ to: 'acknowledge', label: 'Acknowledge' }, { to: 'investigate', label: 'Start investigation' }, { to: 'resolve', label: 'Resolve', needsReason: true }],
  pending_review: [{ to: 'acknowledge', label: 'Acknowledge' }, { to: 'investigate', label: 'Start investigation' }, { to: 'resolve', label: 'Resolve', needsReason: true }],
  acknowledged: [{ to: 'investigate', label: 'Start investigation' }, { to: 'resolve', label: 'Resolve', needsReason: true }],
  investigating: [{ to: 'resolve', label: 'Resolve', needsReason: true }],
  resolved: [{ to: 'close', label: 'Close', manage: true }, { to: 'reopen', label: 'Reopen', needsReason: true }],
  closed: [{ to: 'reopen', label: 'Reopen', needsReason: true }],
};

export default function IssueDetail() {
  const org = useOrg();
  const { issueId } = useParams<{ issueId: string }>();
  const base = `/organizations/${org.id}/issues/${issueId}`;
  const [d, setD] = useState<Detail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<string | null>(null);

  const load = useCallback(async () => { try { setD(await api<Detail>(base)); } catch (e) { setError(errorMessage(e)); } }, [base]);
  useEffect(() => { void load(); api<Member[]>(`/organizations/${org.id}/members`).then(setMembers).catch(() => undefined); }, [load, org.id]);

  async function act(path: string, body: object = {}, msg = 'Saved.') {
    setBusy(true); setError(null); setNotice(null);
    try { await api(`${base}/${path}`, { method: 'POST', body }); setNotice(msg); setReasonFor(null); await load(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  function submitReason(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    void act(reasonFor!, { reason }, reasonFor === 'resolve' ? 'Issue resolved.' : 'Issue reopened.');
  }
  function addNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const body = String(new FormData(form).get('body') ?? '').trim();
    if (body) void act('notes', { body }, 'Note added.').then(() => form.reset());
  }

  if (error && !d) return <><PageHeader title="Issue" /><Alert>{error}</Alert></>;
  if (!d) return <Loading />;
  const i = d.issue; const det = i.detection;
  const canAct = canAlerts.act(org.role); const manage = canAlerts.manage(org.role);
  const highSev = i.severity === 'high' || i.severity === 'critical';
  const negConf = d.sentiment.filter((s) => !['not analysed'].includes(s.label));

  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/alerts`}>← Issues & alerts</Link></p>
      <PageHeader title={i.title} description={`${SIGNAL_LABEL[i.signal] ?? i.signal} · ${SCOPE_LABEL[i.scope]} · first detected ${fmtDate(i.first_detected_at)} (${ago(i.first_detected_at)} ago) · last updated ${fmtDate(i.last_detected_at)}`} />
      <div className="mb-4 flex flex-wrap items-center gap-2"><SeverityBadge severity={i.severity} /><StatusBadge status={i.status} />
        {i.escalation_level > 0 && <Badge tone="red">Escalated ×{i.escalation_level}</Badge>}
        {i.occurrence_count > 1 && <Badge>Re-detected {i.occurrence_count - 1}×</Badge>}
        <span className="text-xs text-slate-600">Assigned: {i.assignee?.display_name ?? 'nobody'}{i.acknowledged_at ? ` · acknowledged ${fmtDate(i.acknowledged_at)}` : ' · not acknowledged'}</span></div>
      {notice && <div className="mb-3"><Alert tone="success">{notice}</Alert></div>}
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card" aria-labelledby="why-h">
            <div className="mb-2 flex items-center justify-between gap-2"><h2 id="why-h" className="font-semibold">Why this was detected</h2><Provenance kind="processing" /></div>
            <p className="text-sm text-slate-700">Rule <strong>“{d.rule.name}”</strong> version {d.rule.version}{d.rule.current_version !== d.rule.version && <> (rule is now at version {d.rule.current_version})</>}{d.rule.deleted_at && <> · rule since deleted</>} · method <code className="text-xs">{det.method}</code></p>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <table className="text-sm"><caption className="mb-1 text-left text-xs font-semibold uppercase text-slate-500">Thresholds</caption><tbody>
                {Object.entries(det.thresholds).map(([k, v]) => <tr key={k}><td className="pr-3 text-slate-600">{LABEL[k] ?? k}</td><td className="tabular-nums">{fmt(v)}</td><td>{det.exceeded.includes(k) ? <Badge tone="red">exceeded</Badge> : <Badge>not exceeded</Badge>}</td></tr>)}
              </tbody></table>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <table><caption className="mb-1 text-left text-xs font-semibold uppercase text-slate-500">Observed</caption><tbody>{Object.entries(det.observed).map(([k, v]) => <tr key={k}><td className="pr-2 text-slate-600">{LABEL[k] ?? k}</td><td className="tabular-nums">{fmt(v)}</td></tr>)}</tbody></table>
                <table><caption className="mb-1 text-left text-xs font-semibold uppercase text-slate-500">Baseline</caption><tbody>{Object.keys(det.baseline).length === 0 ? <tr><td className="text-slate-500">not applicable</td></tr> : Object.entries(det.baseline).map(([k, v]) => <tr key={k}><td className="pr-2 text-slate-600">{LABEL[k] ?? k}</td><td className="tabular-nums">{fmt(v)}</td></tr>)}</tbody></table>
              </div>
            </div>
            {det.limitations.length > 0 && <div className="mt-3"><Alert tone="warning"><strong>Confidence limitations:</strong><ul className="mt-1 list-disc pl-5">{det.limitations.map((l) => <li key={l}>{l}</li>)}</ul></Alert></div>}
          </section>

          <section className="card" aria-labelledby="sev-h">
            <h2 id="sev-h" className="font-semibold">Severity: {i.severity} ({i.severity_breakdown.points} points)</h2>
            <p className="text-xs text-slate-500">Documented rules; no AI judgement. ≤1 informational · 2–3 low · 4–5 medium · 6–7 high · ≥8 critical.</p>
            <table className="mt-2 w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr><th>Factor</th><th>Value</th><th className="text-right">Points</th><th>Rule</th></tr></thead>
              <tbody>{i.severity_breakdown.factors.map((f) => <tr key={f.factor} className="border-t border-slate-100"><td className="py-1">{f.factor.replace(/_/g, ' ')}</td><td>{fmt(f.value)}</td><td className="text-right tabular-nums">{f.points > 0 ? `+${f.points}` : f.points}</td><td className="text-xs text-slate-500">{f.rule}</td></tr>)}</tbody></table>
            {i.severity_breakdown.caps.length > 0 && <p className="mt-2 text-xs text-slate-600">Adjustments: {i.severity_breakdown.caps.join('; ')}</p>}
          </section>

          {(highSev || det.reviewSteps.length > 0) && (
            <section className="card" aria-labelledby="rev-h"><h2 id="rev-h" className="font-semibold">Recommended analyst review</h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">{det.reviewSteps.map((s) => <li key={s}>{s}</li>)}</ol></section>
          )}

          <section className="card" aria-labelledby="sum-h">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 id="sum-h" className="font-semibold">Summary</h2>
              <Provenance kind={i.ai_summary?.method === 'llm' ? 'summary' : 'extractive'} /></div>
            {!i.ai_summary ? <p className="text-sm text-slate-500">Not generated yet.</p> : (
              <>
                <ul className="space-y-2 text-sm">{i.ai_summary.claims.map((c, k) => (
                  <li key={k}><Badge tone={c.kind === 'source_fact' ? 'blue' : c.kind === 'data' ? 'slate' : 'amber'}>{c.kind === 'source_fact' ? 'As published' : c.kind === 'data' ? 'Count' : 'Interpretation'}</Badge> {c.text}
                    {c.supportingMentionIds.slice(0, 6).map((id) => { const n = d.evidence.findIndex((e) => e.id === id); return n >= 0 ? <a key={id} href={`#ev-${id}`} className="ml-1 text-xs text-brand-700">[{n + 1}]</a> : null; })}</li>
                ))}</ul>
                <p className="mt-2 text-xs text-slate-500">{i.ai_summary.method === 'llm' ? `Generated by ${i.ai_summary.model}; claims are not independently verified.` : 'Extractive: headlines as published and counts; no generated text.'} {i.ai_summary.uncertainty.join(' ')}</p>
              </>
            )}
          </section>

          <section className="card" aria-labelledby="ev-h">
            <div className="mb-2 flex items-center justify-between gap-2"><h2 id="ev-h" className="font-semibold">Supporting records ({d.totals.records})</h2><Provenance kind="source" /></div>
            <p className="text-xs text-slate-600">{d.totals.publishers} publishers · {d.totals.independent_publishers} independent · {d.totals.syndicated} syndicated copies (not independent confirmation){d.totals.records > d.evidence.length ? ` · showing latest ${d.evidence.length}` : ''}</p>
            <ol className="mt-3 space-y-2 text-sm">{d.evidence.map((e, n) => (
              <li key={e.id} id={`ev-${e.id}`}><span className="mr-1 text-xs text-slate-500">[{n + 1}]</span>
                <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-700 hover:underline">{e.title}</a>{' '}
                {e.is_syndicated && <Badge tone="amber">Syndicated copy</Badge>} {e.sentiment && <SentimentBadge label={e.sentiment} uncertain={!!e.sentiment_uncertain} />}
                <span className="block text-xs text-slate-600">{e.publisher} · {e.published_at ? fmtDate(e.published_at) : `discovered ${fmtDate(e.discovered_at)}`} · via {e.source_name} · <Link className="text-brand-700 hover:underline" href={`/o/${org.id}/mentions/${e.id}`}>analysis</Link></span>
              </li>
            ))}</ol>
          </section>
        </div>

        <aside className="space-y-6">
          {canAct && (
            <section className="card space-y-3" aria-labelledby="act-h">
              <h2 id="act-h" className="font-semibold">Actions</h2>
              <div className="flex flex-wrap gap-2">{ACTIONS[i.status].filter((a) => !a.manage || manage).map((a) => (
                <button key={a.to} className="btn-secondary" disabled={busy} onClick={() => (a.needsReason ? setReasonFor(a.to) : void act(a.to, {}, `${a.label}: done.`))}>{a.label}</button>
              ))}</div>
              {reasonFor && <form onSubmit={submitReason} className="space-y-2"><label className="label" htmlFor="reason">{reasonFor === 'resolve' ? 'Resolution reason' : 'Why reopen?'}</label>
                <textarea id="reason" name="reason" required minLength={3} maxLength={2000} rows={3} className="input" />
                <div className="flex gap-2"><button className="btn-primary" disabled={busy}>Confirm</button><button type="button" className="btn-secondary" onClick={() => setReasonFor(null)}>Cancel</button></div></form>}
              {i.status !== 'closed' && <div><label className="label" htmlFor="assignee">Assign analyst</label>
                <select id="assignee" className="input" value={i.assigned_to ?? ''} disabled={busy} onChange={(e) => void act('assign', { userId: e.target.value || null }, 'Assignment updated.')}>
                  <option value="">Unassigned</option>{members.filter((m) => m.role !== 'report_viewer').map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</select>
                <p className="mt-1 text-xs text-slate-500">Members without access to this project are rejected.</p></div>}
              {i.resolution_reason && <p className="text-sm"><span className="font-medium">Resolution:</span> {i.resolution_reason}</p>}
            </section>
          )}
          <section className="card text-sm"><h2 className="font-semibold">Coverage profile</h2>
            <h3 className="mt-2 text-xs font-semibold uppercase text-slate-500">Tone (automated)</h3>
            <ul>{negConf.map((s) => <li key={s.label} className="flex justify-between"><span>{s.label}</span><span className="tabular-nums">{s.n}{s.uncertain ? ` (${s.uncertain} uncertain)` : ''}</span></li>)}</ul>
            <h3 className="mt-3 text-xs font-semibold uppercase text-slate-500">Topics</h3>
            <p>{d.topics.map((t) => `${t.custom_label ?? topicLabel(t.topic_key)} (${t.n})`).join(' · ') || '—'}</p>
            <h3 className="mt-3 text-xs font-semibold uppercase text-slate-500">Entities</h3>
            <ul>{d.entities.slice(0, 8).map((e) => <li key={e.id}>{e.display_name} <span className="text-xs text-slate-500">{ENTITY_TYPE_LABEL[e.entity_type] ?? e.entity_type} · {e.n}</span></li>)}</ul>
          </section>
          {d.clusters.length > 0 && <section className="card text-sm"><h2 className="font-semibold">Related stories</h2>
            <ul className="mt-2 space-y-1">{d.clusters.map((c) => <li key={c.id}><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/stories/${c.id}`}>{c.label}</Link><span className="block text-xs text-slate-500">{c.in_issue} in this issue · {c.independent_count} independent publishers</span></li>)}</ul></section>}
          {d.related.length > 0 && <section className="card text-sm"><h2 className="font-semibold">Related issues</h2>
            <ul className="mt-2 space-y-1">{d.related.map((r) => <li key={r.id}><SeverityBadge severity={r.severity} /> <Link className="text-brand-700 hover:underline" href={`/o/${org.id}/alerts/${r.id}`}>{r.title}</Link> <span className="text-xs text-slate-500">{STATUS_LABEL[r.status]}</span></li>)}</ul></section>}
          <section className="card text-sm" aria-labelledby="notes-h"><div className="flex items-center justify-between"><h2 id="notes-h" className="font-semibold">Investigation notes</h2><Provenance kind="analyst" /></div>
            {d.notes.length === 0 ? <p className="mt-2 text-slate-500">No notes.</p> : <ul className="mt-2 space-y-2">{d.notes.map((n) => <li key={n.id}><p className="whitespace-pre-wrap">{n.body}</p><p className="text-xs text-slate-500">{n.author_name ?? 'former member'} · {fmtDate(n.created_at)}</p></li>)}</ul>}
            {canAct && <form onSubmit={addNote} className="mt-3 space-y-2"><label className="sr-only" htmlFor="note">Add note</label><textarea id="note" name="body" rows={3} maxLength={5000} className="input" placeholder="Findings, sources checked, decisions…" /><button className="btn-secondary" disabled={busy}>Add note</button></form>}
          </section>
          <section className="card text-sm"><h2 className="font-semibold">History</h2>
            <ol className="mt-2 space-y-1 text-xs">{d.events.map((e) => (
              <li key={e.id}><time className="text-slate-500" dateTime={e.at}>{fmtDate(e.at)}</time> · {e.event === 'status_changed' || e.event === 'reopened' ? `${STATUS_LABEL[e.from_status as IssueStatus] ?? e.from_status ?? ''} → ${STATUS_LABEL[e.to_status as IssueStatus] ?? e.to_status ?? ''}` : e.event.replace(/_/g, ' ')}
                {e.actor_name ? ` · ${e.actor_name}` : ' · system'}{typeof e.details.reason === 'string' && e.details.reason ? ` · “${e.details.reason}”` : ''}{e.event === 'severity_changed' ? ` · ${String(e.details.from)} → ${String(e.details.to)}` : ''}</li>
            ))}</ol>
            {d.deliveries.length > 0 && <p className="mt-2 text-xs text-slate-500">Notifications: {d.deliveries.map((x) => `${x.channel} ${x.status} ${x.n}`).join(' · ')}</p>}
          </section>
        </aside>
      </div>
      <p className="mt-6 text-xs text-slate-500">{d.disclaimer}</p>
    </>
  );
}
