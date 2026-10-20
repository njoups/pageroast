'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ColumnChart, HBars, Kpi, Widget } from '@/components/exec';
import { SeverityBadge, StatusBadge } from '@/components/alerts-ui';
import { useOrg } from '@/components/org-context';
import { Alert, PageHeader } from '@/components/ui';
import { SENTIMENT_LABEL, TOPIC_LABEL } from '@/lib/ai';
import { STATUSES, STATUS_LABEL as ISSUE_STATUS_LABEL, type IssueStatus, type Severity } from '@/lib/alerts';
import { analyticsQuery, EMPTY_FILTERS, fmtBucket, fmtChange, fmtN, fmtPct, fmtPeriod, type Filters, type Overview, type SourcesResp } from '@/lib/analytics';
import { api, canIngest, errorMessage, fmtDate, relTime, type Project, type Source } from '@/lib/api';

const TONES = ['positive', 'negative', 'neutral', 'mixed'] as const;
/** Validated diverging poles (blue/red) with neutral grays; tone is also always named in the label. */
const TONE_COLOR: Record<string, string> = { positive: '#2a78d6', negative: '#e34948', neutral: '#8a8984', mixed: '#b4b2ad' };
const SENTIMENT_FILTERS = ['positive', 'negative', 'neutral', 'mixed', 'unknown', 'unanalysed'];
type Load<T> = { data: T | null; error: string | null; loading: boolean };

export default function ExecutiveDashboard() {
  const org = useOrg();
  const tz = org.settings?.timezone || 'Asia/Jakarta';
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [entities, setEntities] = useState<Array<{ id: string; name?: string; type?: string }>>([]);
  const [ov, setOv] = useState<Load<Overview>>({ data: null, error: null, loading: true });
  const [src, setSrc] = useState<Load<SourcesResp>>({ data: null, error: null, loading: true });

  useEffect(() => {
    api<Project[]>(`/organizations/${org.id}/projects`).then(setProjects).catch(() => undefined);
    if (canIngest.readSources(org.role)) api<Source[]>(`/organizations/${org.id}/sources`).then(setSources).catch(() => undefined);
    if (canIngest.readMentions(org.role)) api<{ entities: Array<{ id: string; name?: string; type?: string }> }>(`/organizations/${org.id}/analytics/entities?days=366&limit=100`)
      .then((r) => setEntities(r.entities)).catch(() => undefined);
  }, [org.id, org.role]);

  const load = useCallback(() => {
    const q = analyticsQuery(f, tz); const b = `/organizations/${org.id}/analytics`;
    setOv({ data: null, error: null, loading: true }); setSrc({ data: null, error: null, loading: true });
    api<Overview>(`${b}/overview?${q}`).then((d) => setOv({ data: d, error: null, loading: false })).catch((e) => setOv({ data: null, error: errorMessage(e), loading: false }));
    api<SourcesResp>(`${b}/sources?${q}&limit=10`).then((d) => setSrc({ data: d, error: null, loading: false })).catch((e) => setSrc({ data: null, error: errorMessage(e), loading: false }));
  }, [f, org.id, tz]);
  useEffect(() => { if (canIngest.readMentions(org.role)) load(); }, [load, org.role]);

  if (!canIngest.readMentions(org.role)) {
    return <><PageHeader title="Analytics" /><Alert tone="info">Your role includes reports only. Open <Link className="underline" href={`/o/${org.id}/reports`}>Reports</Link> for the reports shared with you.</Alert></>;
  }

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget); const g = (k: string) => String(fd.get(k) ?? '');
    setF({ range: g('range'), from: g('from'), to: g('to'), projectId: g('projectId'), entityId: g('entityId'), topic: g('topic'), sourceId: g('sourceId'),
      language: g('language'), sentiment: g('sentiment'), issueStatus: g('issueStatus'), entityIds: fd.getAll('entityIds').map(String).slice(0, 10) });
  }

  const d = ov.data; const period = d ? fmtPeriod(d.period) : undefined;
  const totals = d?.coverage.totals;
  const mentionsLink = (extra: Record<string, string>) => `/o/${org.id}/mentions?${new URLSearchParams({ ...(f.projectId ? { projectId: f.projectId } : {}), ...extra })}`;

  return (
    <>
      <PageHeader title="Executive dashboard" description="Coverage, tone, share of voice, issues and sources from collected records you can access. Every figure is computed from stored data; definitions are shown under each title." />
      <form onSubmit={apply} className="card mb-6 grid gap-3 md:grid-cols-4 lg:grid-cols-6" aria-label="Dashboard filters">
        <div><label className="label" htmlFor="range">Period</label>
          <select id="range" name="range" className="input" defaultValue={f.range}><option value="1">Last day</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></div>
        <div><label className="label" htmlFor="from">From (custom)</label><input id="from" name="from" type="date" className="input" defaultValue={f.from} /></div>
        <div><label className="label" htmlFor="to">To (custom, inclusive)</label><input id="to" name="to" type="date" className="input" defaultValue={f.to} /></div>
        <div><label className="label" htmlFor="projectId">Project</label><select id="projectId" name="projectId" className="input" defaultValue={f.projectId}><option value="">All visible</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label className="label" htmlFor="entityId">Entity</label><select id="entityId" name="entityId" className="input" defaultValue={f.entityId}><option value="">Any</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
        <div><label className="label" htmlFor="topic">Topic</label><select id="topic" name="topic" className="input" defaultValue={f.topic}><option value="">Any</option>{Object.entries(TOPIC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label className="label" htmlFor="sourceId">Source</label><select id="sourceId" name="sourceId" className="input" defaultValue={f.sourceId}><option value="">All</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label className="label" htmlFor="language">Language</label><select id="language" name="language" className="input" defaultValue={f.language}><option value="">Any</option><option value="id">Indonesian</option><option value="en">English</option><option value="und">Undetermined</option></select></div>
        <div><label className="label" htmlFor="sentiment">Tone</label><select id="sentiment" name="sentiment" className="input" defaultValue={f.sentiment}><option value="">Any</option>{SENTIMENT_FILTERS.map((x) => <option key={x} value={x}>{x === 'unanalysed' ? 'Not analysed' : SENTIMENT_LABEL[x as keyof typeof SENTIMENT_LABEL]}</option>)}</select></div>
        <div><label className="label" htmlFor="issueStatus">Issue status</label><select id="issueStatus" name="issueStatus" className="input" defaultValue={f.issueStatus}><option value="">Open (default)</option>{STATUSES.map((s) => <option key={s} value={s}>{ISSUE_STATUS_LABEL[s]}</option>)}</select></div>
        <div className="md:col-span-2"><label className="label" htmlFor="entityIds">Share-of-voice group (up to 10)</label>
          <select id="entityIds" name="entityIds" multiple className="input h-20" defaultValue={f.entityIds}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}{e.type ? ` (${e.type.replace(/_/g, ' ')})` : ''}</option>)}</select></div>
        <div className="flex items-end gap-2 md:col-span-4 lg:col-span-6"><button className="btn-primary">Apply</button><button type="button" className="btn-secondary" onClick={() => setF(EMPTY_FILTERS)}>Reset</button>
          {d && <span className="ml-auto text-xs text-slate-500">Period: {period} · {d.cache.hit ? `cached ${relTime(d.cache.computedAt)}, still current` : 'computed now'}</span>}</div>
      </form>

      {ov.error && <Alert>{ov.error}</Alert>}
      {d && d.freshness.notes.length > 0 && <div className="mb-4"><Alert tone="warning"><ul className="list-disc pl-5">{d.freshness.notes.map((n) => <li key={n}>{n}</li>)}</ul></Alert></div>}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-6" aria-busy={ov.loading}>
        <Kpi label="Unique articles" value={totals ? fmtN(totals.articles) : '…'} detail={d ? `${fmtChange(d.coverage.change.articles)} vs previous period` : undefined} definition={d?.definitions.articles ?? 'Unique articles'} />
        <Kpi label="Records" value={totals ? fmtN(totals.records) : '…'} detail={totals ? `${fmtN(totals.duplicates)} duplicates / syndicated` : undefined} definition={d?.definitions.records ?? 'Records'} />
        <Kpi label="Unique publishers" value={totals ? fmtN(totals.publishers) : '…'} detail={d ? `${fmtChange(d.coverage.change.publishers)} vs previous period` : undefined} definition={d?.definitions.publishers ?? 'Publishers'} />
        <Kpi label="Net tone" value={d ? (d.sentiment.net == null ? '—' : `${d.sentiment.net > 0 ? '+' : ''}${fmtN(d.sentiment.net, 1)} pp`) : '…'} detail={d ? `n = ${fmtN(d.sentiment.denominator)} with a known tone` : undefined}
          definition="Positive share minus negative share of articles with a known tone, in percentage points." />
        <Kpi label="High-priority issues" value={d ? fmtN(d.topIssues.highPriority) : '…'} detail={d ? `${d.topIssues.statuses.length === 4 ? 'open' : d.topIssues.statuses.join(', ')} · high + critical` : undefined} definition={d?.topIssues.definition ?? ''} />
        <Kpi label="Active sources" value={totals ? fmtN(totals.sources) : '…'} detail={d ? `${d.freshness.sources.enabled} enabled · ${d.freshness.sources.unhealthy + d.freshness.sources.stale} need attention` : undefined}
          definition="Sources that contributed at least one unique article in the period; enabled count from the source registry." />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Widget className="lg:col-span-2" title="Coverage over time" metric={`Unique articles per ${d?.period.granularity ?? 'day'} (local ${d?.period.timezone ?? tz}); duplicates excluded`} period={period}
          loading={ov.loading} error={ov.error} empty={!!d && totals!.records === 0}>
          {d && <ColumnChart label="Unique articles per period bucket" unit="unique articles" columns={['Period', 'Unique articles']}
            points={d.coverage.timeline.points.map((p) => ({ key: p.bucket, label: fmtBucket(p.bucket, d.period.granularity), value: p.articles, extra: `${p.records} records` }))} />}
          {d && <p className="mt-2 text-xs text-slate-500">Rolling: last day {fmtChange(d.coverage.rolling.day)}, last 7 days {fmtChange(d.coverage.rolling.week)}, last 30 days {fmtChange(d.coverage.rolling.month)} (each vs the window before). Source: {d.coverage.timeline.source.replace('_', ' ')}.</p>}
        </Widget>

        <Widget title="Tone of coverage" metric="Share of articles with a known tone; unknown and not-analysed are counted but excluded" period={period} loading={ov.loading} error={ov.error} empty={!!d && totals!.articles === 0}>
          {d && <>
            <HBars label="Tone shares" unit="%" max={100} colorFor={(k) => TONE_COLOR[k] ?? '#2a78d6'}
              rows={TONES.map((k) => ({ key: k, label: SENTIMENT_LABEL[k], value: d.sentiment.shares[k] ?? 0, note: `${d.sentiment.counts[k]} art.` }))} />
            <p className="mt-3 text-xs text-slate-600">Excluded: {d.sentiment.counts.unknown} unknown · {d.sentiment.counts.unanalysed} not analysed. Low-confidence: {fmtPct(d.sentiment.uncertainShare)} of known labels.</p>
            <p className="mt-1 text-xs"><Link className="text-brand-700 underline" href={mentionsLink({ sentiment: 'negative' })}>Negative-tone records →</Link></p>
          </>}
        </Widget>

        <Widget title="Share of voice" metric="Unique articles mentioning each entity ÷ the group total; no reach or impression estimates" period={period} loading={ov.loading} error={ov.error}
          empty={!!d && d.shareOfVoice.denominator === 0} emptyText="No article mentions the selected entities in this period.">
          {d && <>
            <HBars label="Share of voice" unit="%" max={100} rows={d.shareOfVoice.entities.map((e) => ({ key: e.id, label: e.name ?? e.id, value: e.share ?? 0, note: `${e.articles} art.` }))} />
            <p className="mt-2 text-xs text-slate-500">n = {d.shareOfVoice.eligibleArticles} articles. {d.shareOfVoice.formula}</p>
            {d.shareOfVoice.warnings.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-amber-800">{d.shareOfVoice.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          </>}
        </Widget>

        <Widget title="Top issues" metric="Detected issues active in the period, by severity" period={period} loading={ov.loading} error={ov.error} empty={!!d && d.topIssues.top.length === 0} emptyText="No issues in these statuses during the period.">
          {d && <ul className="space-y-3 text-sm">{d.topIssues.top.map((i) => (
            <li key={i.id}><div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={i.severity as Severity} /><StatusBadge status={i.status as IssueStatus} /></div>
              <Link className="mt-1 block text-brand-700 hover:underline" href={`/o/${org.id}/alerts/${i.id}`}>{i.title}</Link>
              <span className="text-xs text-slate-500">{i.project_name} · last detected {fmtDate(i.last_detected_at)}</span></li>))}</ul>}
        </Widget>

        <Widget title="Trending topics" metric="Topics with ≥ 3 articles that are new or up ≥ 50% on the previous equal period (descriptive, not a forecast)" period={period} loading={ov.loading} error={ov.error}
          empty={!!d && d.trendingTopics.length === 0} emptyText="No topic rose enough to qualify in this period.">
          {d && <table className="w-full text-left text-sm"><thead><tr className="text-xs text-slate-500"><th>Topic</th><th className="text-right">Articles</th><th className="text-right">Change</th></tr></thead>
            <tbody>{d.trendingTopics.map((t) => <tr key={t.key}><td><Link className="text-brand-700 hover:underline" href={mentionsLink({ topic: t.key })}>{t.label}</Link></td>
              <td className="text-right tabular-nums">{t.current}</td><td className="text-right tabular-nums">{fmtChange(t)}</td></tr>)}</tbody></table>}
        </Widget>

        <Widget title="Top topics" metric="Unique analysed articles per topic (an article can carry up to three topics)" period={period} loading={ov.loading} error={ov.error} empty={!!d && d.topTopics.length === 0}>
          {d && <HBars label="Articles per topic" rows={d.topTopics.map((t) => ({ key: t.key, label: t.label, value: t.articles, note: t.openIssues ? `${t.openIssues} issue(s)` : undefined }))} />}
        </Widget>

        <Widget className="lg:col-span-2" title="Entity comparison" metric="Unique articles mentioning each entity, with change vs the previous equal period" period={period} loading={ov.loading} error={ov.error} empty={!!d && d.entities.length === 0}>
          {d && <table className="w-full text-left text-sm"><thead><tr className="text-xs text-slate-500"><th>Entity</th><th>Type</th><th className="text-right">Articles</th><th className="text-right">Change</th><th className="text-right">Open issues</th></tr></thead>
            <tbody>{d.entities.map((e) => <tr key={e.id}><td><Link className="text-brand-700 hover:underline" href={mentionsLink({ entityId: e.id })}>{e.name}</Link></td><td className="text-xs text-slate-500">{e.type?.replace(/_/g, ' ')}</td>
              <td className="text-right tabular-nums">{e.articles}</td><td className="text-right tabular-nums">{fmtChange(e)}</td><td className="text-right tabular-nums">{e.openIssues}</td></tr>)}</tbody></table>}
        </Widget>

        <Widget title="Data freshness & connector health" metric="Latest collection and analysis; enabled sources needing attention" loading={ov.loading} error={ov.error}>
          {d && <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Latest record matched</dt><dd>{relTime(d.freshness.latestMatchedAt)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Latest analysis</dt><dd>{relTime(d.freshness.latestAnalysisAt)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Aggregates refreshed</dt><dd>{relTime(d.freshness.aggregates.refreshedAt)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Analysed share</dt><dd>{fmtPct(d.completeness.analysedShare)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-600">Sources enabled / healthy</dt><dd>{d.freshness.sources.enabled} / {d.freshness.sources.healthy}</dd></div>
            {d.freshness.sources.problems.length > 0 && <dd className="pt-2"><p className="text-xs font-medium text-slate-700">Needs attention</p><ul className="text-xs">{d.freshness.sources.problems.map((s) => (
              <li key={s.id}><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/sources/${s.id}`}>{s.name}</Link> — {s.health_status}, last success {relTime(s.last_success_at)}</li>))}</ul></dd>}
            {d.completeness.notes.map((n) => <dd key={n} className="pt-1 text-xs text-slate-500">{n}</dd>)}
          </dl>}
        </Widget>

        <Widget className="lg:col-span-3" title="Active sources" metric="Unique articles per publisher, share, active days and median collection lag. Frequency is not a measure of credibility." period={src.data ? fmtPeriod(src.data.period) : undefined}
          loading={src.loading} error={src.error} empty={!!src.data && src.data.publishers.length === 0}>
          {src.data && <>
            <p className="mb-2 text-xs text-slate-600">{src.data.activePublishers} publishers · Simpson diversity {fmtN(src.data.diversity.simpson, 3)} · top-5 share {fmtPct(src.data.diversity.top5Share)} · median lag {fmtN(src.data.medianLagMinutes)} min</p>
            <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm"><thead><tr className="text-xs text-slate-500"><th>Publisher</th><th className="text-right">Articles</th><th className="text-right">Share</th><th className="text-right">Active days</th>
              <th className="text-right">Median lag (min)</th><th>Top topics</th><th className="text-right">Net tone</th></tr></thead>
              <tbody>{src.data.publishers.map((p) => <tr key={p.domain}><td title={p.domain}>{p.publisher ?? p.domain}</td><td className="text-right tabular-nums">{p.articles}</td><td className="text-right tabular-nums">{fmtPct(p.share)}</td>
                <td className="text-right tabular-nums">{p.activeDays}</td><td className="text-right tabular-nums">{fmtN(p.medianLagMinutes)}</td><td className="text-xs">{p.topTopics.map((t) => t.label).join(', ') || '—'}</td>
                <td className="text-right tabular-nums">{p.sentiment.net == null ? '—' : `${fmtN(p.sentiment.net, 1)} pp (n=${p.sentiment.denominator})`}</td></tr>)}</tbody></table></div>
            <p className="mt-2 text-xs text-slate-500">{src.data.notes.join(' ')}</p>
          </>}
        </Widget>
      </div>
      <p className="mt-6 text-xs text-slate-500">Methodology: docs/ANALYTICS_METHODOLOGY.md. Periods are half-open [from, to) in {tz}. Stories and per-record analysis remain under <Link className="underline" href={`/o/${org.id}/stories`}>Stories</Link> and <Link className="underline" href={`/o/${org.id}/mentions`}>Mentions</Link>.</p>
    </>
  );
}
