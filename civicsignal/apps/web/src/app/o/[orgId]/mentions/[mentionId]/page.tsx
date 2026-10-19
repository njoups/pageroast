'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { MethodBadge, Provenance, SentimentBadge } from '@/components/ai';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Loading, PageHeader } from '@/components/ui';
import { canAi, CONTENT_STATUS_LABEL, ENTITY_TYPE_LABEL, pct, STATUS_LABEL, type MentionAnalysis } from '@/lib/ai';
import { api, errorMessage, fmtDate } from '@/lib/api';

const ACTIVE = ['queued', 'running', 'retrying'];

export default function MentionDetail() {
  const org = useOrg();
  const { mentionId } = useParams<{ mentionId: string }>();
  const base = `/organizations/${org.id}/mentions/${mentionId}`;
  const [d, setD] = useState<MentionAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await api<MentionAnalysis>(`${base}/analysis`)); } catch (e) { setError(errorMessage(e)); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!d || !ACTIVE.includes(d.processing.latest?.status ?? '')) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [d, load]);

  async function reprocess() {
    setBusy(true); setNotice(null); setError(null);
    try { await api(`${base}/reprocess`, { method: 'POST' }); setNotice('Reprocessing queued. This page refreshes when it finishes.'); await load(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  if (error && !d) return <><PageHeader title="Mention" /><Alert>{error}</Alert></>;
  if (!d) return <Loading />;
  const m = d.mention; const cur = d.processing.current; const latest = d.processing.latest;
  const article = d.sentiment.find((s) => s.target_type === 'article');
  const entityTone = d.sentiment.filter((s) => s.target_type === 'entity');

  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/mentions`}>← Mentions</Link></p>
      <PageHeader title={m.title} description={`${m.publisher ?? m.publisher_domain} (${m.publisher_domain})`}
        actions={canAi.reprocess(org.role) ? <button className="btn-secondary" disabled={busy} onClick={() => void reprocess()}>{busy ? 'Queuing…' : 'Reprocess analysis'}</button> : undefined} />
      {notice && <div className="mb-4"><Alert tone="success">{notice}</Alert></div>}
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card" aria-labelledby="src-h">
            <div className="mb-2 flex items-center justify-between gap-2"><h2 id="src-h" className="font-semibold">Original record</h2><Provenance kind="source" /></div>
            <p className="text-sm"><a href={m.url} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-700 hover:underline">Open at publisher ↗</a></p>
            {m.excerpt ? <blockquote className="mt-3 border-l-4 border-slate-200 pl-3 text-sm text-slate-700">{m.excerpt}</blockquote>
              : <p className="mt-3 text-sm text-slate-500">The licence for this source permits the headline only; analysis used the headline alone.</p>}
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600">
              <div><dt className="font-medium">Published</dt><dd>{m.published_at ? fmtDate(m.published_at) : 'not stated by publisher'}</dd></div>
              <div><dt className="font-medium">Discovered</dt><dd>{fmtDate(m.discovered_at)}</dd></div>
              <div><dt className="font-medium">Feed-declared language</dt><dd>{d.language.feedDeclared ?? '—'}</dd></div>
              <div><dt className="font-medium">Detected language</dt><dd>{d.language.detected ?? '—'} {d.language.method && <span className="text-slate-400">({d.language.method}{d.language.confidence ? `, ${pct(d.language.confidence)}` : ''})</span>}</dd></div>
            </dl>
          </section>

          <section className="card" aria-labelledby="sum-h">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 id="sum-h" className="font-semibold">Summary</h2>
              <span className="flex gap-1"><Provenance kind={d.summary?.method === 'llm' ? 'summary' : 'extractive'} /><MethodBadge method={d.summary?.method === 'extractive' ? 'extractive' : cur?.method} model={d.summary?.model} /></span>
            </div>
            {!d.summary && <p className="text-sm text-slate-500">No summary yet.</p>}
            {d.summary?.status === 'insufficient_evidence' && <p className="text-sm text-slate-600">Not enough source text to summarise without speculation.</p>}
            {d.summary?.status === 'ready' && (
              <ul className="space-y-2 text-sm">
                {d.summary.claims.map((c, i) => (
                  <li key={i}>
                    <Badge tone={c.kind === 'source_fact' ? 'blue' : 'amber'}>{c.kind === 'source_fact' ? 'Reported in source' : 'Interpretation'}</Badge>{' '}{c.text}
                    {c.quote && <q className="mt-1 block text-xs italic text-slate-500">{c.quote}</q>}
                  </li>
                ))}
              </ul>
            )}
            {(d.summary?.uncertainty_notes ?? []).length > 0 && <p className="mt-3 text-xs text-slate-500">Caveats: {d.summary!.uncertainty_notes!.join(' ')}</p>}
          </section>

          <section className="card" aria-labelledby="cls-h">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="cls-h" className="font-semibold">Classifications</h2>
              <span className="flex gap-1"><Provenance kind="classification" /><MethodBadge method={cur?.method} model={cur?.model} /></span>
            </div>
            {!cur && <p className="text-sm text-slate-500">No completed analysis yet ({STATUS_LABEL[m.processing_status] ?? m.processing_status}).</p>}
            {cur && (
              <div className="space-y-5 text-sm">
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Article tone</h3>
                  {article ? (
                    <>
                      <p><SentimentBadge label={article.label} uncertain={article.uncertain} /> <span className="text-slate-600">confidence {pct(article.confidence)} · from {article.text_scope.replace(/_/g, ' ')}</span></p>
                      {(article.evidence.quotes ?? []).length > 0 && <p className="mt-1 text-xs text-slate-600">Evidence: {article.evidence.quotes!.map((q) => `“${q}”`).join(', ')}</p>}
                      {article.evidence.rationale && <p className="mt-1 text-xs text-slate-500">{article.evidence.rationale}</p>}
                    </>
                  ) : <p className="text-slate-500">—</p>}
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Topics <span className="font-normal normal-case">(taxonomy {d.taxonomy.version})</span></h3>
                  <ul className="space-y-1">{d.topics.map((t) => (
                    <li key={t.topic_key}><Badge tone="blue">{t.topic_key.startsWith('custom:') ? t.custom_label : d.taxonomy.labels[t.topic_key] ?? t.topic_key}</Badge>{' '}
                      <span className="text-slate-600">{t.topic_key === 'unknown' ? 'no clear topic evidence' : `confidence ${pct(t.confidence)}`}</span>
                      {t.evidence.length > 0 && <span className="text-xs text-slate-500"> · cues: {t.evidence.join(', ')}</span>}</li>
                  ))}</ul>
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Entities</h3>
                  {d.entities.length === 0 ? <p className="text-slate-500">None identified with verifiable evidence.</p> : (
                    <ul className="space-y-1">{d.entities.map((e) => {
                      const tone = entityTone.find((s) => s.target_label?.toLowerCase() === e.mentioned_as.toLowerCase());
                      return (
                        <li key={e.entity_id + e.mentioned_as}>
                          <Link className="font-medium text-brand-700 hover:underline" href={`/o/${org.id}/mentions?entityId=${e.entity_id}`}>{e.display_name}</Link>{' '}
                          <span className="text-xs text-slate-500">{ENTITY_TYPE_LABEL[e.entity_type] ?? e.entity_type} · {pct(e.confidence)} · “{e.evidence_text}”</span>
                          {tone && <> {' '}<SentimentBadge label={tone.label} uncertain={tone.uncertain} /></>}
                        </li>);
                    })}</ul>
                  )}
                </div>
              </div>
            )}
            <p className="mt-4 text-xs text-slate-500">{d.disclaimer}</p>
          </section>
        </div>

        <aside className="space-y-6">
          {d.cluster && (
            <section className="card text-sm">
              <h2 className="mb-1 font-semibold">Story</h2>
              <Link className="text-brand-700 hover:underline" href={`/o/${org.id}/stories/${d.cluster.id}`}>{d.cluster.label}</Link>
              <p className="mt-1 text-xs text-slate-600">{d.cluster.member_count} records · {d.cluster.publisher_count} publisher{d.cluster.publisher_count === 1 ? '' : 's'} · {d.cluster.independent_count} independent</p>
            </section>
          )}
          <section className="card text-sm" aria-labelledby="proc-h">
            <div className="mb-2 flex items-center justify-between gap-2"><h2 id="proc-h" className="font-semibold">Processing</h2><Provenance kind="processing" /></div>
            <p><Badge tone={latest?.status === 'failed' ? 'red' : ACTIVE.includes(latest?.status ?? '') ? 'amber' : 'slate'}>{STATUS_LABEL[latest?.status ?? m.processing_status] ?? latest?.status}</Badge></p>
            {cur && (
              <dl className="mt-3 space-y-1 text-xs text-slate-600">
                <div><dt className="inline font-medium">Method: </dt><dd className="inline">{cur.method} · {cur.provider}{cur.model ? ` · ${cur.model}` : ''}</dd></div>
                <div><dt className="inline font-medium">Prompt: </dt><dd className="inline">{cur.prompt_versions?.article ?? '—'} · taxonomy {cur.prompt_versions?.taxonomy ?? '—'}</dd></div>
                <div><dt className="inline font-medium">Text used: </dt><dd className="inline">{CONTENT_STATUS_LABEL[cur.content_status ?? ''] ?? cur.content_status}</dd></div>
                <div><dt className="inline font-medium">Finished: </dt><dd className="inline">{fmtDate(cur.finished_at)}</dd></div>
                {cur.tokens_in > 0 && <div><dt className="inline font-medium">Tokens: </dt><dd className="inline">{cur.tokens_in.toLocaleString()} in / {cur.tokens_out.toLocaleString()} out{cur.cost_estimate ? ` · est. ${Number(cur.cost_estimate).toFixed(4)} ${cur.cost_currency}` : ''}</dd></div>}
                {cur.stages.fallbackReason && <div className="text-amber-800">Fell back to the rule-based baseline: {cur.stages.fallbackReason}</div>}
              </dl>
            )}
            {latest && latest.status === 'skipped' && <p className="mt-2 text-xs text-slate-600">{CONTENT_STATUS_LABEL[latest.content_status ?? ''] ?? 'Skipped'}.</p>}
            {latest?.error && <p className="mt-2 text-xs text-red-700">{latest.error.kind}: {latest.error.message}</p>}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-slate-600">History ({d.processing.history.length})</summary>
              <ul className="mt-2 space-y-1">{d.processing.history.map((h) => (
                <li key={h.id}>{fmtDate(h.queued_at)} · {h.trigger} · {STATUS_LABEL[h.status] ?? h.status}{h.method ? ` · ${h.method}` : ''}{h.is_current ? ' · current' : ''}</li>
              ))}</ul>
            </details>
          </section>
        </aside>
      </div>
    </>
  );
}
