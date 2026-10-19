'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MethodBadge, Provenance } from './ai';
import { Alert, Badge, Empty } from './ui';
import type { Summary } from '@/lib/ai';
import { api, errorMessage, fmtDate } from '@/lib/api';

interface Categories { taxonomyVersion: string; default: Array<{ key: string; label: string; labelId: string; description: string }>;
  custom: Array<{ id: string; key: string; label: string; description: string | null; keywords: string[] }> }

/** Project-specific topic categories, shown next to the fixed default taxonomy. */
export function TopicCategories({ orgId, projectId, canEdit }: { orgId: string; projectId: string; canEdit: boolean }) {
  const base = `/organizations/${orgId}/projects/${projectId}/topic-categories`;
  const [d, setD] = useState<Categories | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<Categories>(base).then(setD).catch((e) => setError(errorMessage(e))), [base]);
  useEffect(() => { void load(); }, [load]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null);
    const form = e.currentTarget; const f = new FormData(form);
    const label = String(f.get('label') ?? '').trim();
    const key = `custom:${label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}`;
    const keywords = String(f.get('keywords') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const r = await api<{ note: string }>(base, { method: 'POST', body: { key, label, description: String(f.get('description') ?? '') || undefined, keywords } });
      setNotice(r.note); form.reset(); await load();
    } catch (x) { setError(errorMessage(x)); }
  }
  async function remove(id: string) {
    setError(null);
    try { await api(`${base}/${id}`, { method: 'DELETE' }); await load(); } catch (x) { setError(errorMessage(x)); }
  }

  return (
    <section className="card" aria-labelledby="tc-h">
      <h2 id="tc-h" className="font-semibold">Topic categories</h2>
      <p className="mt-1 text-xs text-slate-500">Records are classified into the default taxonomy ({d?.taxonomyVersion ?? '…'}) plus this project&apos;s own categories. A record with no clear evidence is labelled “Unknown” rather than forced into a category.</p>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {notice && <div className="mt-3"><Alert tone="success">{notice}</Alert></div>}
      {d && (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase text-slate-500">Project categories</h3>
          {d.custom.length === 0 ? <p className="mt-1 text-sm text-slate-500">None yet.</p> : (
            <ul className="mt-2 space-y-2 text-sm">{d.custom.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2">
                <span><span className="font-medium">{c.label}</span>{c.description && <span className="text-slate-600"> — {c.description}</span>}
                  {c.keywords.length > 0 && <span className="block text-xs text-slate-500">Cue words: {c.keywords.join(', ')}</span>}</span>
                {canEdit && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void remove(c.id)} aria-label={`Delete category ${c.label}`}>Delete</button>}
              </li>
            ))}</ul>
          )}
          {canEdit && (
            <form onSubmit={add} className="mt-4 grid gap-2 md:grid-cols-3" aria-label="Add topic category">
              <div><label className="label" htmlFor="tc-label">Name</label><input id="tc-label" name="label" required minLength={2} maxLength={80} className="input" placeholder="e.g. Bantuan sosial" /></div>
              <div><label className="label" htmlFor="tc-desc">Description</label><input id="tc-desc" name="description" maxLength={500} className="input" /></div>
              <div><label className="label" htmlFor="tc-kw">Cue words (comma-separated)</label><input id="tc-kw" name="keywords" className="input" placeholder="bansos, bantuan sosial" /></div>
              <div><button className="btn-secondary">Add category</button></div>
            </form>
          )}
          <details className="mt-4 text-sm"><summary className="cursor-pointer text-slate-600">Default taxonomy ({d.default.length} categories)</summary>
            <ul className="mt-2 grid gap-1 md:grid-cols-2">{d.default.map((t) => <li key={t.key}><span className="font-medium">{t.label}</span> <span className="text-xs text-slate-500">({t.labelId}) — {t.description}</span></li>)}</ul>
          </details>
        </>
      )}
    </section>
  );
}

/** Project and period summaries with numbered citations to the records behind each claim. */
export function ProjectSummaries({ orgId, projectId, canRequest }: { orgId: string; projectId: string; canRequest: boolean }) {
  const base = `/organizations/${orgId}/projects/${projectId}/summaries`;
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Summary[]>(base).then(setRows).catch((e) => setError(errorMessage(e))), [base]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!rows?.some((r) => r.status === 'queued')) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [rows, load]);

  async function request(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(null);
    const f = new FormData(e.currentTarget); const from = String(f.get('from') ?? ''); const to = String(f.get('to') ?? '');
    const body = from && to ? { periodStart: new Date(`${from}T00:00:00`).toISOString(), periodEnd: new Date(`${to}T23:59:59`).toISOString() } : {};
    try { await api(base, { method: 'POST', body }); await load(); } catch (x) { setError(errorMessage(x)); } finally { setBusy(false); }
  }

  const s = rows?.find((r) => r.status !== 'queued') ?? null;
  const queued = rows?.some((r) => r.status === 'queued');
  return (
    <section className="card" aria-labelledby="ps-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ps-h" className="font-semibold">Project summary</h2>
        {s && <span className="flex gap-1"><Provenance kind={s.method === 'llm' ? 'summary' : 'extractive'} /><MethodBadge method={s.method ?? undefined} model={s.model} /></span>}
      </div>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {canRequest && (
        <form onSubmit={request} className="mt-3 flex flex-wrap items-end gap-2 text-sm" aria-label="Request summary">
          <div><label className="label" htmlFor="ps-from">Period from (default: last 7 days)</label><input id="ps-from" name="from" type="date" className="input" /></div>
          <div><label className="label" htmlFor="ps-to">to</label><input id="ps-to" name="to" type="date" className="input" /></div>
          <button className="btn-secondary" disabled={busy || queued}>{queued ? 'Generating…' : 'Generate summary'}</button>
        </form>
      )}
      {rows && !s && !queued && <div className="mt-3"><Empty title="No summary yet">Generate one to get an evidence-linked overview of this project&apos;s coverage.</Empty></div>}
      {s && (
        <div className="mt-4 text-sm">
          <p className="text-xs text-slate-500">{s.scope === 'period' ? `Period ${fmtDate(s.period_start ?? null)} – ${fmtDate(s.period_end ?? null)}` : '7 days before generation'} · generated {fmtDate(s.generated_at)}</p>
          {s.status === 'insufficient_evidence' && <p className="mt-2 text-slate-600">Not enough analysed coverage to summarise.</p>}
          <ul className="mt-2 space-y-2">{s.claims.map((c, i) => (
            <li key={i}><Badge tone={c.kind === 'source_fact' ? 'blue' : 'amber'}>{c.kind === 'source_fact' ? 'From records' : 'Interpretation'}</Badge> {c.text}
              {c.supportingMentionIds.slice(0, 8).map((id, j) => <Link key={id} className="ml-1 text-xs text-brand-700" href={`/o/${orgId}/mentions/${id}`}>[{j + 1}]</Link>)}
              {c.supportingMentionIds.length > 8 && <span className="ml-1 text-xs text-slate-500">+{c.supportingMentionIds.length - 8} more</span>}</li>
          ))}</ul>
          {(s.conflicts ?? []).length > 0 && <ul className="mt-2 list-disc pl-5 text-slate-700">{s.conflicts!.map((c, i) => <li key={i}>Conflict: {c.description}</li>)}</ul>}
          {(s.uncertainty_notes ?? []).length > 0 && <p className="mt-3 text-xs text-slate-500">Caveats: {s.uncertainty_notes!.join(' ')}</p>}
        </div>
      )}
    </section>
  );
}
