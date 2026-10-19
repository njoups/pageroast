'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useOrg } from '@/components/org-context';
import { SourceForm, type SourcePayload } from '@/components/source-form';
import { Alert, Badge, Empty, Loading, PageHeader, Stat } from '@/components/ui';
import { api, canIngest, errorMessage, HEALTH_LABEL, HEALTH_TONE, KIND_LABEL, relTime, type Source } from '@/lib/api';

interface Metrics {
  windowHours: number; worker: { online: boolean; instances: number }; queueConfigured: boolean;
  runs: { attempts: number; succeeded: number; failed: number; dead_lettered: number; in_progress: number; discovered: number; new_records: number;
    rejected: number; duplicates: number; already_known: number; matches: number; retries: number; rate_limited_responses: number;
    avg_latency_ms: number | null; p95_latency_ms: number | null };
  definitions: Record<string, string>;
}

export default function SourcesPage() {
  const org = useOrg();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const manage = canIngest.manageSources(org.role);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api<Source[]>(`/organizations/${org.id}/sources`), api<Metrics>(`/organizations/${org.id}/ingestion/metrics?hours=24`)]);
      setSources(s); setMetrics(m);
    } catch (e) { setError(errorMessage(e)); }
  }, [org.id]);
  useEffect(() => { void load(); }, [load]);

  if (!canIngest.readSources(org.role)) return <><PageHeader title="Sources" /><Alert tone="info">Your role does not include the source registry.</Alert></>;

  async function create(p: SourcePayload) {
    await api(`/organizations/${org.id}/sources`, { method: 'POST', body: p }).catch((e) => { throw new Error(errorMessage(e)); });
    setAdding(false); await load();
  }

  return (
    <>
      <PageHeader title="Sources" description="Registry of authorized news sources, their licence terms and live collection health. Health reflects actual collection results only."
        actions={manage && <button className="btn-primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>{adding ? 'Cancel' : 'Add source'}</button>} />
      {error && <Alert>{error}</Alert>}
      {metrics && !metrics.queueConfigured && <div className="mb-4"><Alert tone="warning">The ingestion queue is not configured on this server (REDIS_URL). Sources can be registered, but nothing will be collected.</Alert></div>}
      {metrics?.queueConfigured && !metrics.worker.online && <div className="mb-4"><Alert tone="warning"><strong>No ingestion worker is running.</strong> Scheduled and manual collections are queued but will not run until a worker starts (<code>npm run worker -w apps/api</code>).</Alert></div>}
      {adding && <div className="card mb-6"><h2 className="mb-4 font-semibold">Register a source</h2><SourceForm onSubmit={create} submitLabel="Register source" /><p className="mt-3 text-xs text-slate-500">New sources start disabled. Enable collection from the source page after reviewing its licence.</p></div>}
      {metrics && (
        <section aria-labelledby="ops-h" className="mb-6">
          <h2 id="ops-h" className="sr-only">Collection metrics, last 24 hours</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Runs (24 h)" value={metrics.runs.attempts} note={`${metrics.runs.succeeded} ok · ${metrics.runs.failed} failed · ${metrics.runs.dead_lettered} dead-lettered`} />
            <Stat label="New records" value={metrics.runs.new_records} note={`${metrics.runs.discovered} discovered · ${metrics.runs.rejected} rejected`} />
            <Stat label="Duplicates" value={metrics.runs.duplicates} note={`${metrics.runs.already_known} already known`} />
            <Stat label="Query matches" value={metrics.runs.matches} />
            <Stat label="Latency" value={metrics.runs.avg_latency_ms !== null ? `${metrics.runs.avg_latency_ms} ms` : '—'} note={`p95 ${metrics.runs.p95_latency_ms ?? '—'} ms · ${metrics.runs.retries} retries · ${metrics.runs.rate_limited_responses} rate-limited`} />
          </div>
          <p className="mt-2 text-xs text-slate-500">Worker: {metrics.queueConfigured ? (metrics.worker.online ? `online (${metrics.worker.instances})` : 'offline') : 'queue not configured'} · Metrics come from the run ledger for the last {metrics.windowHours} hours.</p>
        </section>
      )}
      {!sources && !error && <Loading />}
      {sources?.length === 0 && <Empty title="No sources registered">{manage ? 'Add an RSS/Atom feed or a GDELT query you are authorized to collect.' : 'Ask an administrator or project manager to register sources.'}</Empty>}
      {sources && sources.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Source</th><th className="th">Authorization</th><th className="th">Collection</th><th className="th">Health</th><th className="th">Last success</th><th className="th">Records</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {sources.map((s) => (
                <tr key={s.id}>
                  <td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/o/${org.id}/sources/${s.id}`}>{s.name}</Link>
                    <p className="text-xs text-slate-500">{KIND_LABEL[s.connector.kind]} · {s.domain}</p></td>
                  <td className="td"><Badge tone={s.authorizationStatus === 'authorized' ? 'green' : s.authorizationStatus === 'revoked' ? 'red' : 'amber'}>{s.authorizationStatus}</Badge>
                    {s.verificationStatus === 'verified' && <> <Badge tone="blue">verified</Badge></>}</td>
                  <td className="td">{s.enabled ? `every ${Math.round(s.refreshIntervalSeconds / 60)} min` : <span className="text-slate-500">disabled</span>}</td>
                  <td className="td"><Badge tone={HEALTH_TONE[s.health]}>{HEALTH_LABEL[s.health]}</Badge>
                    {s.lastError && <p className="mt-1 max-w-xs truncate text-xs text-red-700" title={s.lastError.message}>{s.lastError.kind}: {s.lastError.message}</p>}</td>
                  <td className="td text-xs">{relTime(s.lastSuccessAt)}<br /><span className="text-slate-500">attempted {relTime(s.lastAttemptAt)}</span></td>
                  <td className="td">{s.recordsCollected.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
