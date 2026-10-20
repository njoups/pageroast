'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ColumnChart, HBars } from '@/components/exec';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Loading, PageHeader } from '@/components/ui';
import { api, errorMessage, fmtDate } from '@/lib/api';
import { canReports, fmtBytes, KIND_LABEL, RUN_STATUS_LABEL, RUN_STATUS_TONE, TEMPLATE_LABEL, type RunStatus, type TemplateKey } from '@/lib/reports';

type Block =
  | { type: 'paragraph'; kind: string; text: string; refs?: string[]; attribution?: string }
  | { type: 'kpis'; items: Array<{ label: string; value: string; detail?: string }> }
  | { type: 'table'; title: string; columns: string[]; rows: Array<Array<string | number>>; note?: string; numeric?: number[] }
  | { type: 'bar' | 'columns'; title: string; metric: string; unit: string; points: Array<{ label: string; value: number }> }
  | { type: 'sources'; items: Array<{ id: string; ref: string; title: string; publisher: string; url: string; publishedAt: string | null }> };
interface Run {
  id: string; name: string; projectName: string; template: TemplateKey; templateVersion: string; trigger: string; status: RunStatus; error: string | null;
  period: { start: string; end: string; timezone: string }; queuedAt: string; finishedAt: string | null; attempts: number; ai: { method: string | null; tokensIn: number; tokensOut: number };
  model: { title: string; subtitle: string; period: { label: string }; sections: Array<{ key: string; title: string; blocks: Block[] }>; methodology: string[]; limitations: string[]; attribution: string[];
    ai: { requested: boolean; method: string; kept: number; dropped: Array<{ reason: string }> } } | null;
  freshness: { notes: string[] } | null; limitations: string[];
  artifacts: Array<{ format: string; filename: string; size_bytes: number; sha256: string; row_count: number | null; expires_at: string; expired: boolean }>; citedSources: number;
}
const KIND_STYLE: Record<string, string> = { metric: 'border-[#2a78d6]', source_fact: 'border-emerald-600', ai_interpretation: 'border-violet-600 italic', analyst_recommendation: 'border-amber-600', note: 'border-slate-400' };
const safeHref = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);

function BlockView({ b }: { b: Block }) {
  if (b.type === 'paragraph') return (
    <div className={`border-l-4 pl-3 ${KIND_STYLE[b.kind] ?? 'border-slate-300'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{KIND_LABEL[b.kind] ?? b.kind}</p>
      <p className="text-sm text-slate-800">{b.text}{b.refs?.length ? <span className="text-slate-500"> [{b.refs.join(', ')}]</span> : null}{b.attribution && <span className="text-slate-500"> — {b.attribution}</span>}</p>
    </div>);
  if (b.type === 'kpis') return <div className="grid gap-3 sm:grid-cols-3">{b.items.map((k) => <div key={k.label} className="rounded border border-slate-200 p-3"><p className="text-xs text-slate-500">{k.label}</p><p className="text-xl font-semibold">{k.value}</p>{k.detail && <p className="text-xs text-slate-500">{k.detail}</p>}</div>)}</div>;
  if (b.type === 'table') return (
    <div className="overflow-x-auto"><p className="mb-1 text-sm font-medium">{b.title}</p><table className="w-full text-left text-sm"><thead><tr className="text-xs text-slate-500">{b.columns.map((c, i) => <th key={i} className={b.numeric?.includes(i) ? 'text-right' : ''}>{c}</th>)}</tr></thead>
      <tbody>{b.rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{r.map((c, j) => <td key={j} className={b.numeric?.includes(j) ? 'text-right tabular-nums' : ''}>{c}</td>)}</tr>)}</tbody></table>
      {b.note && <p className="mt-1 text-xs text-slate-500">{b.note}</p>}</div>);
  if (b.type === 'bar') return <div><p className="mb-2 text-sm font-medium">{b.title}</p><HBars label={b.title} unit={b.unit} rows={b.points.map((p, i) => ({ key: String(i), label: p.label, value: p.value }))} /></div>;
  if (b.type === 'columns') return <div><p className="mb-2 text-sm font-medium">{b.title}</p><ColumnChart label={b.title} unit={b.metric} columns={['Period', b.metric]} points={b.points.map((p, i) => ({ key: String(i), label: p.label, value: p.value }))} /></div>;
  if (b.type !== 'sources') return null;
  return <ol className="space-y-2 text-sm">{b.items.map((s) => <li key={s.id}><span className="font-mono text-xs text-slate-500">{s.ref}</span> <span className="text-xs text-slate-500">{s.publisher}{s.publishedAt ? ` · ${fmtDate(s.publishedAt)}` : ''}</span>
    <span className="block">“{s.title}”</span>{safeHref(s.url) && <a className="block break-all text-xs text-brand-700 underline" href={safeHref(s.url)} target="_blank" rel="noopener noreferrer nofollow">{s.url}</a>}</li>)}</ol>;
}

export default function ReportRunPage() {
  const org = useOrg();
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Run>(`/organizations/${org.id}/reports/runs/${runId}`).then(setRun).catch((e) => setError(errorMessage(e))), [org.id, runId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    const h = setInterval(() => void load(), 3000); return () => clearInterval(h);
  }, [run, load]);

  if (error) return <><PageHeader title="Report" /><Alert>{error}</Alert></>;
  if (!run) return <Loading />;
  const m = run.model;
  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/reports`}>← Reports</Link></p>
      <PageHeader title={run.name} description={`${TEMPLATE_LABEL[run.template]} · ${run.projectName} · ${m?.period.label ?? `${run.period.start} – ${run.period.end}`} (${run.period.timezone})`}
        actions={canReports.generate(org.role) && (run.status === 'queued' || run.status === 'running')
          ? <button className="btn-secondary" onClick={() => api(`/organizations/${org.id}/reports/runs/${run.id}/cancel`, { method: 'POST' }).then(load).catch((e) => setError(errorMessage(e)))}>Cancel</button> : undefined} />
      <div className="card mb-6 flex flex-wrap items-center gap-4 text-sm">
        <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
        <span className="text-slate-600">Requested {fmtDate(run.queuedAt)} ({run.trigger}){run.finishedAt ? ` · finished ${fmtDate(run.finishedAt)}` : ''} · attempt {run.attempts}</span>
        <span className="text-slate-600">{run.citedSources} cited records · template {run.templateVersion}</span>
        <span className="flex gap-3">{run.artifacts.map((a) => a.expired
          ? <span key={a.format} className="text-slate-500">{a.format.toUpperCase()} expired {fmtDate(a.expires_at)}</span>
          : <a key={a.format} className="btn-secondary" href={`/api/v1/organizations/${org.id}/reports/runs/${run.id}/download/${a.format}`}>Download {a.format.toUpperCase()} ({fmtBytes(a.size_bytes)}{a.row_count != null ? `, ${a.row_count} rows` : ''})</a>)}</span>
        {run.artifacts.length > 0 && !run.artifacts[0]!.expired && <span className="text-xs text-slate-500">Files are deleted on {fmtDate(run.artifacts[0]!.expires_at)}.</span>}
      </div>
      {run.error && <div className="mb-4"><Alert>{run.error}</Alert></div>}
      {(run.status === 'queued' || run.status === 'running') && <Loading label="Generating — this page refreshes automatically." />}
      {m && (
        <div className="space-y-6">
          {m.sections.map((s) => <section key={s.key} className="card space-y-4" aria-labelledby={`s-${s.key}`}><h2 id={`s-${s.key}`} className="text-lg font-semibold">{s.title}</h2>{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}</section>)}
          <section className="card text-sm"><h2 className="mb-2 font-semibold">Methodology</h2><ul className="list-disc space-y-1 pl-5">{m.methodology.map((x) => <li key={x}>{x}</li>)}</ul></section>
          <section className="card text-sm"><h2 className="mb-2 font-semibold">Limitations</h2><ul className="list-disc space-y-1 pl-5">{run.limitations.map((x) => <li key={x}>{x}</li>)}</ul>
            {m.ai.requested && <p className="mt-2 text-xs text-slate-600">AI commentary: {m.ai.method}; {m.ai.kept} claim(s) kept, {m.ai.dropped.length} removed by validation{m.ai.dropped.length ? ` (${[...new Set(m.ai.dropped.map((d) => d.reason))].join(', ')})` : ''}. Tokens: {run.ai.tokensIn} in / {run.ai.tokensOut} out.</p>}</section>
          {m.attribution.length > 0 && <section className="card text-sm"><h2 className="mb-2 font-semibold">Source attribution</h2><ul className="list-disc pl-5">{m.attribution.map((x) => <li key={x}>{x}</li>)}</ul></section>}
        </div>
      )}
    </>
  );
}
