'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, canIngest, errorMessage, fmtDate, type Mention, type Project, type Source } from '@/lib/api';

interface Filters { q: string; projectId: string; sourceId: string; language: string; from: string; to: string; dateField: 'published' | 'discovered'; sort: 'published' | 'discovered' | 'relevance'; includeDuplicates: boolean }
const EMPTY: Filters = { q: '', projectId: '', sourceId: '', language: '', from: '', to: '', dateField: 'discovered', sort: 'published', includeDuplicates: false };
const PAGE = 25;

export default function MentionsPage() {
  const org = useOrg();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ items: Mention[]; total: number } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Project[]>(`/organizations/${org.id}/projects`).then(setProjects).catch(() => undefined);
    if (canIngest.readSources(org.role)) api<Source[]>(`/organizations/${org.id}/sources`).then(setSources).catch(() => undefined);
  }, [org.id, org.role]);

  const load = useCallback(async () => {
    setData(null); setError(null);
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort: filters.sort, dateField: filters.dateField });
    for (const k of ['q', 'projectId', 'sourceId', 'language'] as const) if (filters[k]) p.set(k, filters[k]);
    if (filters.from) p.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
    if (filters.to) p.set('to', new Date(`${filters.to}T23:59:59`).toISOString());
    if (filters.includeDuplicates) p.set('includeDuplicates', 'true');
    try { setData(await api(`/organizations/${org.id}/mentions?${p}`)); } catch (e) { setError(errorMessage(e)); }
  }, [org.id, filters, offset]);
  useEffect(() => { void load(); }, [load]);

  if (!canIngest.readMentions(org.role)) return <><PageHeader title="Mentions" /><Alert tone="info">Your role includes reports only.</Alert></>;

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const g = (k: string) => String(f.get(k) ?? '');
    setOffset(0);
    setFilters({ q: g('q').trim(), projectId: g('projectId'), sourceId: g('sourceId'), language: g('language'), from: g('from'), to: g('to'),
      dateField: g('dateField') as Filters['dateField'], sort: g('sort') as Filters['sort'], includeDuplicates: f.get('includeDuplicates') === 'on' });
  }

  return (
    <>
      <PageHeader title="Mentions" description="Coverage collected from your authorized sources. Every item links to the original publisher; headlines and excerpts are shown only as far as each source's licence permits." />
      <form onSubmit={apply} className="card mb-6 grid gap-3 md:grid-cols-4" aria-label="Search and filter mentions">
        <div className="md:col-span-2"><label className="label" htmlFor="q">Search</label><input id="q" name="q" defaultValue={filters.q} placeholder='e.g. banjir -hoaks "bantuan sosial"' className="input" /></div>
        <div><label className="label" htmlFor="projectId">Project</label>
          <select id="projectId" name="projectId" className="input" defaultValue={filters.projectId}><option value="">All visible</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label className="label" htmlFor="sourceId">Source</label>
          <select id="sourceId" name="sourceId" className="input" defaultValue={filters.sourceId}><option value="">All</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label className="label" htmlFor="language">Language</label>
          <select id="language" name="language" className="input" defaultValue={filters.language}><option value="">Any</option><option value="id">Indonesian</option><option value="en">English</option><option value="ms">Malay</option><option value="jv">Javanese</option></select></div>
        <div><label className="label" htmlFor="dateField">Date applies to</label>
          <select id="dateField" name="dateField" className="input" defaultValue={filters.dateField}><option value="discovered">Discovery time</option><option value="published">Publication time</option></select></div>
        <div><label className="label" htmlFor="from">From</label><input id="from" name="from" type="date" defaultValue={filters.from} className="input" /></div>
        <div><label className="label" htmlFor="to">To</label><input id="to" name="to" type="date" defaultValue={filters.to} className="input" /></div>
        <div><label className="label" htmlFor="sort">Sort</label>
          <select id="sort" name="sort" className="input" defaultValue={filters.sort}><option value="published">Newest published</option><option value="discovered">Newest discovered</option><option value="relevance">Relevance (with search)</option></select></div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="includeDuplicates" defaultChecked={filters.includeDuplicates} />Include duplicates</label>
        <div className="flex gap-2 self-end md:col-span-2">
          <button className="btn-primary">Apply</button>
          <button type="button" className="btn-secondary" onClick={() => { setOffset(0); setFilters(EMPTY); }}>Reset</button>
        </div>
      </form>
      {error && <Alert>{error}</Alert>}
      {!data && !error && <Loading />}
      {data && data.total === 0 && (
        <Empty title="No mentions match">
          {filters === EMPTY ? 'Nothing has been collected yet, or no collected item matches a project you are assigned to. Check Sources for collection status.' : 'Try widening the filters.'}
        </Empty>
      )}
      {data && data.total > 0 && (
        <>
          <p className="mb-3 text-sm text-slate-600">{data.total.toLocaleString()} result{data.total === 1 ? '' : 's'} · <Badge tone="green">Live data</Badge> collected from registered sources</p>
          <ul className="space-y-3">
            {data.items.map((m) => (
              <li key={m.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <a href={m.url} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-brand-700 hover:underline">{m.title}</a>
                  <span className="flex flex-wrap gap-1">
                    {m.duplicate_status !== 'original' && <Badge tone="amber">{m.duplicate_status === 'duplicate' ? 'Duplicate' : 'Near duplicate'}</Badge>}
                    {m.language && <Badge>{m.language}</Badge>}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  <span className="font-medium">{m.publisher ?? m.publisher_domain}</span> ({m.publisher_domain}) · via {m.source_name}
                  {m.author && <> · {m.author}</>}
                </p>
                {m.excerpt && <p className="mt-2 text-sm text-slate-700">{m.excerpt}</p>}
                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <div><dt className="inline">Published: </dt><dd className="inline">{m.published_at ? fmtDate(m.published_at) : m.connector === 'gdelt' ? 'not provided by GDELT' : 'not stated by publisher'}</dd></div>
                  <div><dt className="inline">Discovered: </dt><dd className="inline">{fmtDate(m.discovered_at)}</dd></div>
                  {m.attribution && <div><dt className="inline">Attribution: </dt><dd className="inline">{m.attribution}</dd></div>}
                  {m.redistribution_restrictions && <div><dt className="inline">Redistribution: </dt><dd className="inline">{m.redistribution_restrictions}</dd></div>}
                  <div><dt className="inline">Analysis: </dt><dd className="inline">{m.processing_status === 'pending' ? 'not yet available (Milestone 3)' : m.processing_status}</dd></div>
                </dl>
                {m.matches.length > 0 && (
                  <p className="mt-2 flex flex-wrap gap-1 text-xs">{m.matches.map((x) => <Badge key={x.queryId} tone="blue">{x.projectName}: {x.queryName} ({x.terms.join(', ')})</Badge>)}</p>
                )}
              </li>
            ))}
          </ul>
          <nav aria-label="Pagination" className="mt-4 flex items-center gap-3 text-sm">
            <button className="btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
            <span>{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
            <button className="btn-secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
          </nav>
        </>
      )}
    </>
  );
}
