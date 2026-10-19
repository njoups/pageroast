'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Empty } from '@/components/ui';
import { api, errorMessage, type MonitoringQuery } from '@/lib/api';

const split = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function QueryForm({ orgId, initial, onSave, onCancel }: { orgId: string; initial?: MonitoringQuery; onSave: (body: Record<string, unknown>) => Promise<void>; onCancel?: () => void }) {
  const [expr, setExpr] = useState(initial?.boolean_expression ?? '');
  const [exprError, setExprError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Validate the Boolean expression as the user types (debounced), using the same parser as the server.
  useEffect(() => {
    if (!expr.trim()) { setExprError(null); return; }
    const t = setTimeout(() => {
      api<{ valid: boolean; error?: string; position?: number }>(`/organizations/${orgId}/queries/validate`, { method: 'POST', body: { booleanExpression: expr } })
        .then((r) => setExprError(r.valid ? null : `${r.error} (at character ${(r.position ?? 0) + 1})`)).catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [expr, orgId]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await onSave({
        name: String(f.get('name')).trim(), keywords: split(String(f.get('keywords'))), aliases: split(String(f.get('aliases'))),
        exclusions: split(String(f.get('exclusions'))), booleanExpression: expr.trim() || null,
        languages: split(String(f.get('languages'))).map((l) => l.toLowerCase()), isActive: f.get('isActive') === 'on',
      });
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-2" aria-label={initial ? 'Edit query' : 'New query'}>
      {error && <div className="md:col-span-2"><Alert>{error}</Alert></div>}
      <div><label className="label" htmlFor="q-name">Name</label><input id="q-name" name="name" required minLength={2} maxLength={120} defaultValue={initial?.name} className="input" /></div>
      <div><label className="label" htmlFor="q-lang">Languages (optional, e.g. id, en)</label><input id="q-lang" name="languages" defaultValue={initial?.languages.join(', ')} className="input" /></div>
      <div><label className="label" htmlFor="q-kw">Keywords or phrases (one per line or comma)</label><textarea id="q-kw" name="keywords" rows={3} defaultValue={initial?.keywords.join('\n')} className="input" /></div>
      <div><label className="label" htmlFor="q-al">Aliases (alternative names)</label><textarea id="q-al" name="aliases" rows={3} defaultValue={initial?.aliases.join('\n')} className="input" /></div>
      <div><label className="label" htmlFor="q-ex">Exclude records containing</label><textarea id="q-ex" name="exclusions" rows={2} defaultValue={initial?.exclusions.join('\n')} className="input" /></div>
      <div>
        <label className="label" htmlFor="q-expr">Boolean expression (optional)</label>
        <textarea id="q-expr" rows={2} value={expr} onChange={(e) => setExpr(e.target.value)} className="input font-mono text-xs" placeholder='("bantuan sosial" OR bansos) AND NOT hoaks' aria-describedby="q-expr-help" aria-invalid={!!exprError} />
        <p id="q-expr-help" className={`mt-1 text-xs ${exprError ? 'text-red-700' : 'text-slate-500'}`}>{exprError ?? 'Uppercase AND, OR, NOT (or -word), "exact phrases", (groups), prefix* (≥3 letters). Matching ignores case and accents.'}</p>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={initial?.is_active ?? true} />Active</label>
      <p className="text-xs text-slate-500 md:col-span-2">A record matches when any keyword or alias appears, the expression (if any) holds, and no exclusion appears. Saving re-checks the most recent 5,000 collected records.</p>
      <div className="flex gap-2 md:col-span-2"><button className="btn-primary" disabled={busy || !!exprError}>{busy ? 'Saving…' : 'Save query'}</button>{onCancel && <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>}</div>
    </form>
  );
}

export function QueryEditor({ orgId, projectId, canEdit }: { orgId: string; projectId: string; canEdit: boolean }) {
  const base = `/organizations/${orgId}/projects/${projectId}/queries`;
  const [queries, setQueries] = useState<MonitoringQuery[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setQueries(await api<MonitoringQuery[]>(base)); } catch (e) { setError(errorMessage(e)); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function save(id: string | null, body: Record<string, unknown>) {
    const r = await api<{ rematched: number }>(id ? `${base}/${id}` : base, { method: id ? 'PATCH' : 'POST', body });
    setEditing(null); setNotice(`Query saved. ${r.rematched} existing record${r.rematched === 1 ? '' : 's'} matched.`); await load();
  }
  async function remove(q: MonitoringQuery) {
    if (!window.confirm(`Delete query "${q.name}" and its ${q.match_count} matches?`)) return;
    try { await api(`${base}/${q.id}`, { method: 'DELETE' }); setNotice('Query deleted.'); await load(); } catch (e) { setError(errorMessage(e)); }
  }

  return (
    <section className="card space-y-4" aria-labelledby="queries-h">
      <div className="flex items-center justify-between">
        <h2 id="queries-h" className="font-semibold">Monitoring queries</h2>
        {canEdit && editing !== 'new' && <button className="btn-secondary py-1.5" onClick={() => setEditing('new')}>Add query</button>}
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {editing === 'new' && <div className="rounded-md border border-slate-200 p-4"><QueryForm orgId={orgId} onSave={(b) => save(null, b)} onCancel={() => setEditing(null)} /></div>}
      {queries?.length === 0 && editing !== 'new' && <Empty title="No queries yet">Queries decide which collected records belong to this project.</Empty>}
      <ul className="divide-y divide-slate-100">
        {queries?.map((q) => (
          <li key={q.id} className="py-3">
            {editing === q.id ? <QueryForm orgId={orgId} initial={q} onSave={(b) => save(q.id, b)} onCancel={() => setEditing(null)} /> : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="text-sm">
                  <p className="font-medium">{q.name} {!q.is_active && <Badge>inactive</Badge>} <Badge tone="blue">{q.match_count} matches</Badge></p>
                  {(q.keywords.length > 0 || q.aliases.length > 0) && <p className="text-slate-600">Any of: {[...q.keywords, ...q.aliases].map((k) => `“${k}”`).join(', ')}</p>}
                  {q.boolean_expression && <p className="font-mono text-xs text-slate-600">{q.boolean_expression}</p>}
                  {q.exclusions.length > 0 && <p className="text-slate-600">Excluding: {q.exclusions.join(', ')}</p>}
                  {q.languages.length > 0 && <p className="text-xs text-slate-500">Languages: {q.languages.join(', ')}</p>}
                </div>
                {canEdit && <div className="flex gap-2"><button className="btn-secondary px-2 py-1 text-xs" onClick={() => setEditing(q.id)}>Edit</button><button className="btn-danger px-2 py-1 text-xs" onClick={() => remove(q)}>Delete</button></div>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
