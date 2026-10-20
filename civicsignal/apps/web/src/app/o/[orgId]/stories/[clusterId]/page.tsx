'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MethodBadge, Provenance, SentimentBadge } from '@/components/ai';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Loading, PageHeader } from '@/components/ui';
import { type Sentiment, type Summary } from '@/lib/ai';
import { api, errorMessage, fmtDate, safeHref } from '@/lib/api';

interface Member { id: string; title: string; url: string; publisher: string | null; publisher_domain: string; published_at: string | null; discovered_at: string;
  score: string | null; reasons: { headline?: number; sharedTokens?: string[]; sharedEntities?: number; topic?: boolean; hoursApart?: number } | null; is_syndicated: boolean; sentiment: Sentiment | null }
interface Detail {
  cluster: { id: string; label: string; member_count: number; independent_count: number; publisher_count: number; confidence: string; method_version: string | null; version: number; first_seen_at: string; last_seen_at: string; status: string };
  members: Member[]; hiddenMembers: number; events: Array<{ event: string; mention_id: string | null; details: Record<string, unknown>; at: string }>; summary: Summary | null;
}

export default function StoryDetail() {
  const org = useOrg();
  const { clusterId } = useParams<{ clusterId: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Detail>(`/organizations/${org.id}/clusters/${clusterId}`).then(setD).catch((e) => setError(errorMessage(e))); }, [org.id, clusterId]);
  if (error) return <><PageHeader title="Story" /><Alert>{error}</Alert></>;
  if (!d) return <Loading />;
  const byId = new Map(d.members.map((m, i) => [m.id, i + 1]));
  const cite = (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean).map((n) => <a key={n} href={`#r${n}`} className="ml-1 text-xs text-brand-700">[{n}]</a>);
  const c = d.cluster;
  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/stories`}>← Stories</Link></p>
      <PageHeader title={c.label} description={`${c.member_count} records from ${c.publisher_count} publisher${c.publisher_count === 1 ? '' : 's'} (${c.independent_count} independent source${c.independent_count === 1 ? '' : 's'}). Label = headline of the most representative record.`} />
      {c.status !== 'active' && <div className="mb-4"><Alert tone="warning">This story is {c.status}; it was merged or dissolved after new records arrived.</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Summary</h2>
              <span className="flex gap-1"><Provenance kind={d.summary?.method === 'llm' ? 'summary' : 'extractive'} /><MethodBadge method={d.summary?.method === 'llm' ? 'llm' : 'extractive'} model={d.summary?.model} /></span></div>
            {!d.summary && <p className="text-sm text-slate-500">No summary yet.</p>}
            {d.summary?.status === 'insufficient_evidence' && <p className="text-sm text-slate-600">Not enough evidence for a summary.</p>}
            {d.summary && d.summary.claims.length > 0 && (
              <ul className="space-y-2 text-sm">{d.summary.claims.map((cl, i) => (
                <li key={i}><Badge tone={cl.kind === 'source_fact' ? 'blue' : 'amber'}>{cl.kind === 'source_fact' ? 'Reported' : 'Interpretation'}</Badge> {cl.text}{cite(cl.supportingMentionIds)}</li>
              ))}</ul>
            )}
            {(d.summary?.conflicts ?? []).length > 0 && (
              <div className="mt-3"><h3 className="text-xs font-semibold uppercase text-slate-500">Conflicting accounts</h3>
                <ul className="mt-1 list-disc pl-5 text-sm">{d.summary!.conflicts!.map((x, i) => <li key={i}>{x.description}{cite(x.supportingMentionIds)}</li>)}</ul></div>
            )}
            {(d.summary?.uncertainty_notes ?? []).length > 0 && <p className="mt-3 text-xs text-slate-500">Caveats: {d.summary!.uncertainty_notes!.join(' ')}</p>}
            {d.hiddenMembers > 0 && <p className="mt-2 text-xs text-slate-500">{d.hiddenMembers} record(s) in this story belong to projects you are not assigned to; claims citing them are hidden.</p>}
          </section>
          <section className="card">
            <div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-semibold">Records</h2><Provenance kind="source" /></div>
            <ol className="space-y-3 text-sm">{d.members.map((m, i) => (
              <li key={m.id} id={`r${i + 1}`}>
                <span className="mr-1 text-xs text-slate-500">[{i + 1}]</span>
                <a href={safeHref(m.url)} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-700 hover:underline">{m.title}</a>{' '}
                {m.is_syndicated && <Badge tone="amber">Syndicated copy</Badge>} {m.sentiment && <SentimentBadge label={m.sentiment} />}
                <span className="block text-xs text-slate-600">{m.publisher ?? m.publisher_domain} · {m.published_at ? fmtDate(m.published_at) : `discovered ${fmtDate(m.discovered_at)}`}
                  {' · '}<Link className="text-brand-700 hover:underline" href={`/o/${org.id}/mentions/${m.id}`}>analysis</Link></span>
                {m.reasons && m.score && <span className="block text-xs text-slate-500">Grouped because: similarity {Number(m.score).toFixed(2)}{m.reasons.sharedTokens?.length ? ` · shared words ${m.reasons.sharedTokens.join(', ')}` : ''}{m.reasons.sharedEntities ? ` · ${m.reasons.sharedEntities} shared entities` : ''}{m.reasons.topic ? ' · same topic' : ''}{m.reasons.hoursApart !== undefined ? ` · ${m.reasons.hoursApart} h apart` : ''}</span>}
              </li>
            ))}</ol>
          </section>
        </div>
        <aside className="card h-fit text-sm">
          <div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-semibold">History</h2><Provenance kind="processing" /></div>
          <p className="mb-2 text-xs text-slate-600">Method {c.method_version ?? '—'} · version {c.version} · confidence {Math.round(Number(c.confidence) * 100)}%</p>
          <ul className="space-y-1 text-xs text-slate-600">{d.events.map((e, i) => <li key={i}>{fmtDate(e.at)} · {e.event.replace(/_/g, ' ')}</li>)}</ul>
        </aside>
      </div>
    </>
  );
}
