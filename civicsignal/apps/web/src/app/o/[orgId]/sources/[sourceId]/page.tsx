'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useOrg } from '@/components/org-context';
import { SourceForm, type SourcePayload } from '@/components/source-form';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, canIngest, errorMessage, fmtDate, HEALTH_LABEL, HEALTH_TONE, KIND_LABEL, relTime, type Run, type Source } from '@/lib/api';

const RUN_TONE: Record<Run['status'], 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  succeeded: 'green', queued: 'slate', running: 'blue', retrying: 'amber', failed: 'red', dead_lettered: 'red',
};

export default function SourceDetail() {
  const org = useOrg();
  const router = useRouter();
  const { sourceId } = useParams<{ sourceId: string }>();
  const base = `/organizations/${org.id}/sources/${sourceId}`;
  const [source, setSource] = useState<Source | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const manage = canIngest.manageSources(org.role);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api<Source>(base), api<Run[]>(`${base}/runs?limit=30`)]);
      setSource(s); setRuns(r);
    } catch (e) { setError(errorMessage(e)); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  // While a run is queued/running, refresh every 3 s so its outcome appears without a manual reload.
  useEffect(() => {
    if (!runs.some((r) => r.status === 'queued' || r.status === 'running' || r.status === 'retrying')) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [runs, load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  }
  async function save(p: SourcePayload) {
    await api(base, { method: 'PATCH', body: p }).catch((e) => { throw new Error(errorMessage(e)); });
    setEditing(false); setNotice('Source saved.'); await load();
  }
  async function remove() {
    if (!source || !window.confirm(`Delete source "${source.name}"? Sources with collected records cannot be deleted; disable them instead.`)) return;
    setBusy(true);
    try { await api(base, { method: 'DELETE' }); router.replace(`/o/${org.id}/sources`); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  if (!source) return error ? <Alert>{error}</Alert> : <Loading />;
  const authorized = source.authorizationStatus === 'authorized';

  return (
    <>
      <p className="mb-2 text-sm"><Link href={`/o/${org.id}/sources`} className="text-brand-600 underline">← Sources</Link></p>
      <PageHeader title={source.name} description={`${KIND_LABEL[source.connector.kind]} · ${source.domain} · connector ${source.connector.version ?? ''}`}
        actions={manage && <>
          <button className="btn-primary" disabled={busy || !authorized} title={authorized ? undefined : 'Authorize the source first'}
            onClick={() => act(() => api(`${base}/collect`, { method: 'POST' }), 'Collection queued. Results appear below when the worker finishes.')}>Collect now</button>
          {source.enabled
            ? <button className="btn-secondary" disabled={busy} onClick={() => act(() => api(`${base}/disable`, { method: 'POST' }), 'Collection disabled.')}>Disable</button>
            : <button className="btn-secondary" disabled={busy || !authorized} title={authorized ? undefined : 'Only authorized sources can be enabled'} onClick={() => act(() => api(`${base}/enable`, { method: 'POST' }), 'Scheduled collection enabled.')}>Enable</button>}
          <button className="btn-secondary" onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel edit' : 'Edit'}</button>
          <button className="btn-danger" disabled={busy} onClick={remove}>Delete</button>
        </>} />
      <div className="mb-4 space-y-3">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {!authorized && <Alert tone="warning">This source is <strong>{source.authorizationStatus}</strong>. Nothing is collected until an authorization basis is recorded and the status is set to authorized.</Alert>}
        {source.lastError && <Alert>Last error ({source.lastError.kind}{source.lastError.httpStatus ? `, HTTP ${source.lastError.httpStatus}` : ''}): {source.lastError.message}{source.lastError.at ? ` (${fmtDate(source.lastError.at)})` : ''}</Alert>}
      </div>
      {editing && <div className="card mb-6"><SourceForm initial={source} onSubmit={save} submitLabel="Save source" /></div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card space-y-3 text-sm" aria-labelledby="status-h">
          <h2 id="status-h" className="font-semibold">Status</h2>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <dt className="text-slate-500">Health</dt><dd><Badge tone={HEALTH_TONE[source.health]}>{HEALTH_LABEL[source.health]}</Badge></dd>
            <dt className="text-slate-500">Collection</dt><dd>{source.enabled ? `every ${Math.round(source.refreshIntervalSeconds / 60)} min` : 'disabled'}</dd>
            <dt className="text-slate-500">Next scheduled</dt><dd>{source.schedule.active ? relTime(source.schedule.nextDueAt) : '—'}</dd>
            <dt className="text-slate-500">Last success</dt><dd>{relTime(source.lastSuccessAt)}</dd>
            <dt className="text-slate-500">Last attempt</dt><dd>{relTime(source.lastAttemptAt)}</dd>
            <dt className="text-slate-500">Failures in a row</dt><dd>{source.consecutiveFailures}</dd>
            <dt className="text-slate-500">Records collected</dt><dd>{source.recordsCollected.toLocaleString()}</dd>
            <dt className="text-slate-500">Verified</dt><dd>{source.verificationStatus === 'verified' ? `yes, ${fmtDate(source.connector.verifiedAt)}` : 'not yet (needs one successful live collection)'}</dd>
            <dt className="text-slate-500">Rate limit</dt><dd>{source.rateLimitPerMinute ? `${source.rateLimitPerMinute}/min` : 'host default'}{source.quotaPerDay ? ` · ${source.quotaPerDay}/day` : ''}</dd>
          </dl>
          {source.feedUrl && <p className="break-all text-xs text-slate-500">Feed: {source.feedUrl}</p>}
          {source.connector.kind === 'gdelt' && <p className="break-all text-xs text-slate-500">Query: {String(source.connector.config.query)} · window {String(source.connector.config.timespan)}</p>}
        </section>
        <section className="card space-y-2 text-sm lg:col-span-2" aria-labelledby="lic-h">
          <h2 id="lic-h" className="font-semibold">Authorization and licence</h2>
          <p><Badge tone={authorized ? 'green' : 'amber'}>{source.authorizationStatus}</Badge> {source.authorizationBasis ?? <span className="text-slate-500">No basis recorded</span>}</p>
          <p><span className="text-slate-500">Stored fields:</span> {source.permittedFields.join(', ')}{source.permitsFullText ? ', full text' : ' (no full text)'}</p>
          <p><span className="text-slate-500">Retention:</span> {source.retentionDays ? `${source.retentionDays} days` : 'not set'} · <span className="text-slate-500">Attribution:</span> {source.attributionRequirement || 'not specified'}</p>
          {source.licenseTerms && <p><span className="text-slate-500">Licence:</span> {source.licenseTerms}</p>}
          {source.usageRestrictions && <p><span className="text-slate-500">Usage restrictions:</span> {source.usageRestrictions}</p>}
          {source.redistributionRestrictions && <p><span className="text-slate-500">Redistribution:</span> {source.redistributionRestrictions}</p>}
        </section>
      </div>
      <section className="mt-6" aria-labelledby="runs-h">
        <h2 id="runs-h" className="mb-3 font-semibold">Recent collection runs</h2>
        {runs.length === 0 ? <Empty title="No runs yet">{authorized ? 'Use “Collect now” or enable scheduled collection.' : 'Authorize the source to allow collection.'}</Empty> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Trigger</th><th className="th">Status</th><th className="th">Records</th><th className="th">HTTP · time</th><th className="th">Error</th><th className="th"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="td whitespace-nowrap text-xs">{fmtDate(r.created_at)}</td>
                    <td className="td text-xs">{r.trigger}{r.requested_by_name ? ` · ${r.requested_by_name}` : ''}{r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}</td>
                    <td className="td"><Badge tone={RUN_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>{r.not_modified && <span className="ml-1 text-xs text-slate-500">unchanged</span>}</td>
                    <td className="td text-xs">{r.status === 'succeeded' ? `${r.records_new} new · ${r.records_known} known · ${r.records_duplicate} dup · ${r.records_rejected} rejected · ${r.matches} matches` : '—'}</td>
                    <td className="td text-xs">{r.http_status ?? '—'} · {r.duration_ms !== null ? `${r.duration_ms} ms` : '—'}{r.rate_limited ? ' · rate-limited' : ''}</td>
                    <td className="td max-w-xs truncate text-xs text-red-700" title={r.error?.message}>{r.error ? `${r.error.kind}: ${r.error.message}` : ''}</td>
                    <td className="td">{manage && (r.status === 'failed' || r.status === 'dead_lettered') &&
                      <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => act(() => api(`${base}/runs/${r.id}/retry`, { method: 'POST' }), 'Retry queued.')}>Retry</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
