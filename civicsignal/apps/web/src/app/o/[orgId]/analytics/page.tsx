'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BarList, MethodBadge, Provenance } from '@/components/ai';
import { useOrg } from '@/components/org-context';
import { Alert, Empty, Loading, PageHeader, Stat } from '@/components/ui';
import { ENTITY_TYPE_LABEL, SENTIMENT_BAR, SENTIMENT_LABEL, SENTIMENTS, STATUS_LABEL, TOPIC_LABEL, type Sentiment } from '@/lib/ai';
import { api, canIngest, errorMessage, type Project, type Source } from '@/lib/api';

interface F { projectId: string; sourceId: string; topic: string; sentiment: string; from: string; to: string }
const EMPTY: F = { projectId: '', sourceId: '', topic: '', sentiment: '', from: '', to: '' };
interface SentimentResp { distribution: Array<{ label: Sentiment; n: number; uncertain: number }>; series: Array<{ day: string; label: Sentiment; n: number }>;
  processing: Array<{ status: string; n: number }>; methods: Array<{ method: string; provider: string; model: string; n: number }>; definition: string }
interface TopicsResp { taxonomyVersion: string; topics: Array<{ topic_key: string; label: string; n: number; avg_confidence: string }>; definition: string }
interface EntitiesResp { entities: Array<{ id: string; display_name: string; entity_type: string; mentions: number; negative_toward: number; positive_toward: number }>; definition: string }
interface Clusters { clusters: Array<{ id: string; label: string; member_count: number; independent_count: number; publisher_count: number; visible_members: number; last_seen_at: string }> }

export default function AnalyticsPage() {
  const org = useOrg();
  const [f, setF] = useState<F>(EMPTY);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [d, setD] = useState<{ s: SentimentResp; t: TopicsResp; e: EntitiesResp; c: Clusters } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Project[]>(`/organizations/${org.id}/projects`).then(setProjects).catch(() => undefined);
    if (canIngest.readSources(org.role)) api<Source[]>(`/organizations/${org.id}/sources`).then(setSources).catch(() => undefined);
  }, [org.id, org.role]);

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    for (const k of ['projectId', 'sourceId', 'topic', 'sentiment'] as const) if (f[k]) p.set(k, f[k]);
    if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) p.set('to', new Date(`${f.to}T23:59:59`).toISOString());
    return p.toString();
  }, [f]);

  const load = useCallback(async () => {
    setD(null); setError(null);
    const b = `/organizations/${org.id}`; const q = qs();
    try {
      const [s, t, e, c] = await Promise.all([api<SentimentResp>(`${b}/analytics/sentiment?${q}`), api<TopicsResp>(`${b}/analytics/topics?${q}`),
        api<EntitiesResp>(`${b}/analytics/entities?${q}&limit=15`), api<Clusters>(`${b}/clusters?${q}&limit=10`)]);
      setD({ s, t, e, c });
    } catch (x) { setError(errorMessage(x)); }
  }, [org.id, qs]);
  useEffect(() => { void load(); }, [load]);

  if (!canIngest.readMentions(org.role)) return <><PageHeader title="Analytics" /><Alert tone="info">Your role includes reports only.</Alert></>;

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget); const g = (k: string) => String(fd.get(k) ?? '');
    setF({ projectId: g('projectId'), sourceId: g('sourceId'), topic: g('topic'), sentiment: g('sentiment'), from: g('from'), to: g('to') });
  }

  const analysed = d ? d.s.distribution.reduce((n, x) => n + x.n, 0) : 0;
  const uncertain = d ? d.s.distribution.reduce((n, x) => n + x.uncertain, 0) : 0;
  const total = d ? d.s.processing.reduce((n, x) => n + x.n, 0) : 0;
  const days = d ? [...new Set(d.s.series.map((x) => x.day))].slice(-30) : [];
  const dayMax = d ? Math.max(1, ...days.map((day) => d.s.series.filter((x) => x.day === day).reduce((n, x) => n + x.n, 0))) : 1;
  const mentionsLink = (extra: Record<string, string>) => `/o/${org.id}/mentions?${new URLSearchParams({ ...(f.projectId ? { projectId: f.projectId } : {}), ...extra })}`;

  return (
    <>
      <PageHeader title="Analytics" description="Tone, topics, entities and stories across the coverage you can access. All classifications are automated estimates; each figure states how it is computed." />
      <form onSubmit={apply} className="card mb-6 grid gap-3 md:grid-cols-6" aria-label="Analytics filters">
        <div><label className="label" htmlFor="projectId">Project</label><select id="projectId" name="projectId" className="input" defaultValue={f.projectId}><option value="">All visible</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label className="label" htmlFor="sourceId">Source</label><select id="sourceId" name="sourceId" className="input" defaultValue={f.sourceId}><option value="">All</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label className="label" htmlFor="topic">Topic</label><select id="topic" name="topic" className="input" defaultValue={f.topic}><option value="">Any</option>{Object.entries(TOPIC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label className="label" htmlFor="sentiment">Tone</label><select id="sentiment" name="sentiment" className="input" defaultValue={f.sentiment}><option value="">Any</option>{SENTIMENTS.map((x) => <option key={x} value={x}>{SENTIMENT_LABEL[x]}</option>)}</select></div>
        <div><label className="label" htmlFor="from">From</label><input id="from" name="from" type="date" className="input" defaultValue={f.from} /></div>
        <div><label className="label" htmlFor="to">To</label><input id="to" name="to" type="date" className="input" defaultValue={f.to} /></div>
        <div className="flex gap-2 md:col-span-6"><button className="btn-primary">Apply</button><button type="button" className="btn-secondary" onClick={() => setF(EMPTY)}>Reset</button></div>
      </form>
      {error && <Alert>{error}</Alert>}
      {!d && !error && <Loading />}
      {d && total === 0 && <Empty title="No coverage in this view">Nothing collected matches these filters, or none is in a project you are assigned to.</Empty>}
      {d && total > 0 && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-4">
            <Stat label="Records in view" value={total.toLocaleString()} note="Original records (duplicates excluded)" />
            <Stat label="Analysed" value={analysed.toLocaleString()} note={`${total - analysed} not analysed (see status below)`} />
            <Stat label="Uncertain tone" value={analysed ? `${Math.round((uncertain / analysed) * 100)}%` : '—'} note="Low-confidence classifications" />
            <Stat label="Stories" value={d.c.clusters.length.toLocaleString()} note="Story clusters with a visible record (top 10 shown)" />
          </div>

          <section className="card">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Methods behind these figures</h2><Provenance kind="processing" /></div>
            <ul className="flex flex-wrap gap-3 text-sm">{d.s.methods.map((m) => <li key={`${m.method}${m.model}`}><MethodBadge method={m.method} model={m.model} /> {m.n.toLocaleString()} records</li>)}</ul>
            {d.s.methods.some((m) => m.method === 'baseline') && <p className="mt-2 text-xs text-amber-800">Some records were classified by the rule-based baseline. Its tone labels performed poorly in the held-out evaluation (docs/AI_EVALUATION.md); read tone figures as rough indicators only.</p>}
            <p className="mt-2 text-xs text-slate-600">Status: {d.s.processing.map((p) => `${STATUS_LABEL[p.status] ?? p.status} ${p.n}`).join(' · ')}</p>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card">
              <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">Tone</h2><Provenance kind="classification" /></div>
              <BarList rows={SENTIMENTS.map((l) => { const r = d.s.distribution.find((x) => x.label === l); return { key: l, label: SENTIMENT_LABEL[l], value: r?.n ?? 0, color: SENTIMENT_BAR[l],
                note: r?.uncertain ? `${r.uncertain} uncertain` : undefined, href: mentionsLink({ sentiment: l }) }; }).filter((r) => r.value > 0)} empty="No analysed records" />
              <p className="mt-3 text-xs text-slate-500">{d.s.definition}</p>
            </section>
            <section className="card">
              <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">Topics</h2><Provenance kind="classification" /></div>
              <BarList rows={d.t.topics.map((t) => ({ key: t.topic_key, label: t.label, value: t.n, note: t.topic_key === 'unknown' ? undefined : `avg conf. ${Math.round(Number(t.avg_confidence) * 100)}%`, href: mentionsLink({ topic: t.topic_key }) }))} />
              <p className="mt-3 text-xs text-slate-500">{d.t.definition} Taxonomy {d.t.taxonomyVersion}.</p>
            </section>
          </div>

          {days.length > 1 && (
            <section className="card">
              <h2 className="mb-3 font-semibold">Tone by day</h2>
              <div className="flex h-40 items-end gap-1" role="img" aria-label="Daily analysed records stacked by tone; exact values are in the table below">
                {days.map((day) => (
                  <div key={day} className="flex h-full flex-1 flex-col justify-end" title={day}>
                    {SENTIMENTS.map((l) => { const n = d.s.series.find((x) => x.day === day && x.label === l)?.n ?? 0;
                      return n ? <div key={l} className={SENTIMENT_BAR[l]} style={{ height: `${(n / dayMax) * 100}%` }} /> : null; })}
                  </div>
                ))}
              </div>
              <details className="mt-3 text-xs"><summary className="cursor-pointer text-slate-600">Table</summary>
                <table className="mt-2 w-full text-left"><thead><tr><th>Day (UTC)</th>{SENTIMENTS.map((l) => <th key={l}>{SENTIMENT_LABEL[l]}</th>)}</tr></thead>
                  <tbody>{days.map((day) => <tr key={day}><td>{day}</td>{SENTIMENTS.map((l) => <td key={l}>{d.s.series.find((x) => x.day === day && x.label === l)?.n ?? 0}</td>)}</tr>)}</tbody></table>
              </details>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card">
              <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">Most-mentioned entities</h2><Provenance kind="classification" /></div>
              <BarList rows={d.e.entities.map((e) => ({ key: e.id, label: e.display_name, value: e.mentions, href: mentionsLink({ entityId: e.id }),
                note: <span>{ENTITY_TYPE_LABEL[e.entity_type] ?? e.entity_type}{e.negative_toward + e.positive_toward > 0 ? ` · tone toward: ${e.positive_toward}+ / ${e.negative_toward}−` : ''}</span> }))} empty="No entities identified" />
              <p className="mt-3 text-xs text-slate-500">{d.e.definition}</p>
            </section>
            <section className="card">
              <h2 className="mb-3 font-semibold">Recent stories</h2>
              {d.c.clusters.length === 0 ? <p className="text-sm text-slate-500">No multi-source stories detected.</p> : (
                <ul className="space-y-2 text-sm">{d.c.clusters.map((c) => (
                  <li key={c.id}><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/stories/${c.id}`}>{c.label}</Link>
                    <span className="block text-xs text-slate-500">{c.member_count} records · {c.publisher_count} publisher{c.publisher_count === 1 ? '' : 's'} · {c.independent_count} independent</span></li>
                ))}</ul>
              )}
              <p className="mt-3"><Link className="text-sm text-brand-700 hover:underline" href={`/o/${org.id}/stories`}>All stories →</Link></p>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
