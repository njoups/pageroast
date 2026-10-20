'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader, Stat } from '@/components/ui';
import { api, errorMessage, fmtDate, relTime, safeHref, type Project } from '@/lib/api';
import {
  ACCESS_LABEL, canSocial, connectorStatus, CONTENT_LABEL, costText, PLATFORM_LABEL, quotaPercent, shareText, youtubeConfig,
  type ProviderInfo, type SocialAnalytics, type SocialConnector, type SocialRun, type SocialUsage,
} from '@/lib/social';

type Tab = 'connectors' | 'analytics' | 'mentions' | 'providers' | 'budgets';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'connectors', label: 'Connectors' }, { id: 'analytics', label: 'Analytics' }, { id: 'mentions', label: 'Mentions' },
  { id: 'providers', label: 'Providers & capabilities' }, { id: 'budgets', label: 'Budgets & usage' },
];

export default function SocialPage() {
  const org = useOrg();
  const [tab, setTab] = useState<Tab>('connectors');
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [connectors, setConnectors] = useState<SocialConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api<{ providers: ProviderInfo[] }>(`/organizations/${org.id}/social/providers`), api<{ connectors: SocialConnector[] }>(`/organizations/${org.id}/social/connectors`)]);
      setProviders(p.providers); setConnectors(c.connectors);
    } catch (e) { setError(errorMessage(e)); }
  }, [org.id]);
  useEffect(() => { void load(); }, [load]);

  if (!canSocial.read(org.role)) return <><PageHeader title="Social listening" /><Alert tone="info">Your role does not include social listening.</Alert></>;
  return (
    <>
      <PageHeader title="Social listening"
        description="Authorized social-platform connectors, their quotas and data-rights obligations, and analytics over the permitted records they collect. Social data is reported separately from news coverage." />
      {error && <Alert>{error}</Alert>}
      <div role="tablist" aria-label="Social listening sections" className="mb-6 flex flex-wrap gap-2 border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} id={`tab-${t.id}`} onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-brand-600 font-semibold text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {(!providers || !connectors) && !error && <Loading />}
        {providers && connectors && tab === 'connectors' && <ConnectorsPanel providers={providers} connectors={connectors} reload={load} />}
        {providers && tab === 'providers' && <ProvidersPanel providers={providers} />}
        {tab === 'analytics' && <AnalyticsPanel />}
        {tab === 'mentions' && <MentionsPanel />}
        {connectors && tab === 'budgets' && <BudgetsPanel connectors={connectors} />}
      </div>
    </>
  );
}

// ── Connectors ─────────────────────────────────────────────────────────────────────────────────────

function ConnectorsPanel({ providers, connectors, reload }: { providers: ProviderInfo[]; connectors: SocialConnector[]; reload: () => Promise<void> }) {
  const org = useOrg();
  const manage = canSocial.manage(org.role);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const implemented = providers.filter((p) => p.implementation === 'implemented');
  return (
    <section aria-labelledby="conn-h">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="conn-h" className="font-semibold">Connected providers</h2>
        {manage && implemented.length > 0 && <button className="btn-primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>{adding ? 'Cancel' : 'Add connector'}</button>}
      </div>
      {adding && <AddConnector providers={implemented} onDone={async () => { setAdding(false); await reload(); }} />}
      {connectors.length === 0 && !adding && (
        <Empty title="No social connectors">
          {manage ? 'Add a YouTube connector with your organization’s own API key. Other providers are listed under “Providers & capabilities” with what they would require.' : 'Ask an administrator or project manager to add a connector.'}
        </Empty>
      )}
      <ul className="space-y-3">
        {connectors.map((c) => {
          const st = connectorStatus(c);
          return (
            <li key={c.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">{c.name}</h3>
                  <p className="text-xs text-slate-500">{c.providerName} · {String(c.config.mode) === 'channel' ? `${(c.config.channelIds as string[] ?? []).length} channel(s)` : `search “${String(c.config.query ?? '')}”`}
                    {c.config.includeComments ? ' · with public comments' : ''}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <Badge tone={c.rights.derivedAnalysisAllowed ? 'green' : 'amber'}>{c.rights.derivedAnalysisAllowed ? 'AI analysis approved' : 'AI analysis not approved'}</Badge>
                  <button className="btn-secondary" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>{open === c.id ? 'Close' : 'Details'}</button>
                </div>
              </div>
              {st.detail && <p className="mt-2 text-sm text-slate-600">{st.detail}</p>}
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-slate-500">Last successful sync</dt><dd>{relTime(c.lastSuccessAt)}</dd></div>
                <div><dt className="text-xs text-slate-500">Records stored</dt><dd>{c.recordsStored.toLocaleString()} <span className="text-xs text-slate-500">(max {c.retentionDays ?? '—'} days)</span></dd></div>
                <div><dt className="text-xs text-slate-500">Refresh due / past deadline</dt><dd>{c.lifecycle.refreshDue} / <span className={c.lifecycle.pastDeletionDeadline ? 'font-semibold text-red-700' : ''}>{c.lifecycle.pastDeletionDeadline}</span></dd></div>
                <div><dt className="text-xs text-slate-500">Quota day {c.quota.day}</dt><dd>{c.quota.buckets.map((b) => <QuotaBar key={b.key} b={b} />)}</dd></div>
              </dl>
              {c.lastError && <p className="mt-2 text-xs text-red-700">Last error ({c.lastError.kind}): {c.lastError.message}</p>}
              {c.notices.length > 0 && <div className="mt-2"><Alert tone="warning">{c.notices.map((n) => `${n.level === 'provider_quota' ? 'Provider quota' : `Budget ${n.level}`}: ${n.metric} ${Number(n.value)} / ${Number(n.threshold)} (${n.period_key})`).join(' · ')}</Alert></div>}
              {open === c.id && <ConnectorDetail c={c} reload={reload} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function QuotaBar({ b }: { b: SocialConnector['quota']['buckets'][number] }) {
  const p = quotaPercent(b);
  return (
    <div className="mb-1">
      <div className="flex justify-between text-xs"><span>{b.label}</span><span>{b.used.toLocaleString()}{b.limit !== null ? ` / ${b.limit.toLocaleString()}` : ''}</span></div>
      {p !== null && <div className="h-1.5 w-full rounded bg-slate-100" role="meter" aria-valuemin={0} aria-valuemax={b.limit ?? 0} aria-valuenow={b.used} aria-label={`${b.label} used`}>
        <div className={`h-1.5 rounded ${p >= 90 ? 'bg-red-500' : p >= 70 ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${p}%` }} /></div>}
    </div>
  );
}

function AddConnector({ providers, onDone }: { providers: ProviderInfo[]; onDone: () => Promise<void> }) {
  const org = useOrg();
  const [mode, setMode] = useState<'search' | 'channel'>('search');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = providers[0]!;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      const created = await api<{ id: string }>(`/organizations/${org.id}/social/connectors`, { method: 'POST', body: {
        provider: p.provider, name: String(f.get('name')),
        config: youtubeConfig({ mode, query: String(f.get('query') ?? ''), channelIds: String(f.get('channelIds') ?? ''), lookbackHours: Number(f.get('lookbackHours')), maxPages: Number(f.get('maxPages')), includeComments: f.get('includeComments') === 'on' }),
        authorizationStatus: f.get('authorized') === 'on' ? 'authorized' : 'unverified', authorizationBasis: String(f.get('basis') ?? '') || null,
        permittedFields: ['title', 'url', 'published_at', 'excerpt', ...(f.get('metrics') === 'on' ? ['metrics'] : []), ...(f.get('author') === 'on' ? ['author'] : [])],
      } });
      const key = String(f.get('apiKey') ?? '');
      if (key) await api(`/organizations/${org.id}/social/connectors/${created.id}/credentials`, { method: 'PUT', body: { secret: key } });
      await onDone();
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="card mb-6 space-y-4" aria-label="Add social connector">
      <h3 className="font-semibold">Add {p.displayName} connector</h3>
      {err && <Alert>{err}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label className="label" htmlFor="sc-name">Name</label><input id="sc-name" name="name" className="input" required minLength={2} maxLength={120} placeholder="YouTube: banjir Jakarta" /></div>
        <div><span className="label">Collect</span>
          <div className="flex gap-4 text-sm">
            <label><input type="radio" name="mode" checked={mode === 'search'} onChange={() => setMode('search')} /> Keyword search</label>
            <label><input type="radio" name="mode" checked={mode === 'channel'} onChange={() => setMode('channel')} /> Channel monitoring</label>
          </div></div>
        {mode === 'search'
          ? <div><label className="label" htmlFor="sc-q">Search query</label><input id="sc-q" name="query" className="input" required minLength={2} maxLength={200} placeholder="banjir jakarta" />
            <p className="mt-1 text-xs text-slate-500">Sent to YouTube search (supports - and |). Hashtags are searched as ordinary keywords: YouTube has no hashtag endpoint.</p></div>
          : <div><label className="label" htmlFor="sc-ch">Channel ids</label><textarea id="sc-ch" name="channelIds" className="input" required placeholder="UC…, one per line or comma-separated (up to 20)" /></div>}
        <div><label className="label" htmlFor="sc-lb">Look back (hours)</label><input id="sc-lb" name="lookbackHours" type="number" min={1} max={720} defaultValue={48} className="input" /></div>
        <div><label className="label" htmlFor="sc-mp">Result pages per sync (1–4)</label><input id="sc-mp" name="maxPages" type="number" min={1} max={4} defaultValue={1} className="input" />
          <p className="mt-1 text-xs text-slate-500">Each search page uses 1 of the 100 daily search calls; each detail call uses 1 of 10,000 daily units.</p></div>
        <div className="space-y-1 text-sm">
          <label className="block"><input type="checkbox" name="includeComments" /> Collect public comments on the newest videos (personal data; check your legal basis)</label>
          <label className="block"><input type="checkbox" name="metrics" defaultChecked /> Store engagement counts as returned (refreshed or deleted within 30 days)</label>
          <label className="block"><input type="checkbox" name="author" /> Store channel/author identifiers</label>
        </div>
        <div><label className="label" htmlFor="sc-key">{p.auth.credentialLabel}</label><input id="sc-key" name="apiKey" type="password" autoComplete="off" className="input" placeholder="Stored encrypted; never shown again" />
          <p className="mt-1 text-xs text-slate-500">Use a key restricted to the YouTube Data API v3. You can also add it later.</p></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="sc-basis">Authorization basis</label>
          <textarea id="sc-basis" name="basis" className="input" maxLength={2000} placeholder="e.g. YouTube API Services Terms accepted for Google Cloud project … on …; purpose: public-information monitoring" />
          <label className="mt-1 block text-sm"><input type="checkbox" name="authorized" /> I confirm this basis and mark the connector authorized</label></div>
      </div>
      <p className="text-xs text-slate-500">Records are kept at most {p.rights.storageMaxDays} days and refreshed before then (provider terms). AI analysis stays off until an owner or admin records the derived-metrics approval. New connectors start disabled.</p>
      <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add connector'}</button>
    </form>
  );
}

function ConnectorDetail({ c, reload }: { c: SocialConnector; reload: () => Promise<void> }) {
  const org = useOrg();
  const manage = canSocial.manage(org.role); const approve = canSocial.approve(org.role);
  const base = `/organizations/${org.id}/social/connectors/${c.id}`;
  const [runs, setRuns] = useState<SocialRun[] | null>(null);
  const [usage, setUsage] = useState<SocialUsage | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const loadDetail = useCallback(async () => {
    const [h, u] = await Promise.all([api<{ runs: SocialRun[] }>(`${base}/health`), api<SocialUsage>(`${base}/usage?days=30`)]);
    setRuns(h.runs); setUsage(u);
  }, [base]);
  useEffect(() => { void loadDetail().catch((e) => setMsg({ tone: 'error', text: errorMessage(e) })); }, [loadDetail]);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ tone: 'success', text: typeof r === 'string' ? r : `${label}: done` }); await reload(); await loadDetail(); }
    catch (e) { setMsg({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="mt-4 space-y-5 border-t border-slate-100 pt-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {manage && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={busy || !c.credentials.configured} title={c.credentials.configured ? undefined : 'Add the API key first'}
            onClick={() => act('Test', async () => { const r = await api<{ ok: boolean; detail?: string; error?: { kind: string; message: string } }>(`${base}/test`, { method: 'POST' }); if (!r.ok) throw new Error(`${r.error!.kind}: ${r.error!.message}`); return r.detail!; })}>Test connection</button>
          <button className="btn-secondary" disabled={busy || !c.credentials.configured || c.authorizationStatus !== 'authorized' || (!!c.paused && c.paused.reason !== 'budget_soft_limit')}
            title={c.paused ? 'Paused: see the notice above' : c.authorizationStatus !== 'authorized' ? 'Authorize the connector first' : undefined}
            onClick={() => act('Sync', async () => { await api(`${base}/sync`, { method: 'POST' }); return 'Sync queued. Results appear in the history below when the worker has run it.'; })}>Sync now</button>
          {c.enabled
            ? <button className="btn-secondary" disabled={busy} onClick={() => act('Disable', () => api(`${base}/disable`, { method: 'POST' }))}>Disable schedule</button>
            : <button className="btn-secondary" disabled={busy || !c.credentials.configured || c.authorizationStatus !== 'authorized'} onClick={() => act('Enable', () => api(`${base}/enable`, { method: 'POST' }))}>Enable schedule</button>}
          <CredentialForm label={c.credentials.label} configured={c.credentials.configured} hint={c.credentials.hint}
            onSave={(secret) => act(c.credentials.configured ? 'Reauthorize' : 'Credentials', () => api(`${base}/credentials`, { method: 'PUT', body: { secret } }))}
            onRemove={() => act('Remove credentials', () => api(`${base}/credentials`, { method: 'DELETE' }))} />
        </div>
      )}
      <section aria-label="Data rights">
        <h4 className="mb-1 text-sm font-semibold">Data rights and lifecycle</h4>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>Stored at most {c.rights.storageMaxDays ?? '—'} days; records are re-read before then and deleted if the provider no longer returns them.</li>
          <li>Attribution: {c.rights.attribution ?? '—'}</li>
          <li>Redistribution: {c.rights.redistribution ?? '—'}</li>
          <li>AI analysis (sentiment, topics, entities): {c.rights.derivedAnalysisAllowed
            ? <>approved{c.rights.approval ? ` on ${fmtDate(c.rights.approval.approvedAt)} (${c.rights.approval.reference})` : ''}; results are CivicSignal estimates, not provider data.</>
            : 'not approved. YouTube’s policies prohibit derived metrics unless the derived-metrics amendment is accepted.'}</li>
        </ul>
        {approve && <ApprovalForm approved={c.rights.derivedAnalysisAllowed} onSubmit={(approved, reference) => act('Approval', () => api(`${base}/derived-analysis-approval`, { method: 'PUT', body: approved ? { approved, reference } : { approved } }))} />}
      </section>
      <section aria-label="Capabilities">
        <h4 className="mb-1 text-sm font-semibold">Capabilities</h4>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {c.capabilities.map((op) => <li key={op.operation}><Badge tone={op.supported ? 'green' : 'slate'}>{op.supported ? 'Yes' : 'No'}</Badge> {op.label}{op.reason && <span className="block text-xs text-slate-500">{op.reason}</span>}</li>)}
        </ul>
      </section>
      {usage && (
        <section aria-label="Usage">
          <h4 className="mb-1 text-sm font-semibold">Usage (last {usage.windowDays} days)</h4>
          <div className="grid gap-3 sm:grid-cols-5">
            <Stat label="API requests" value={usage.totals.requests} note={`${usage.totals.units} quota units`} />
            <Stat label="Records retrieved" value={usage.totals.recordsRetrieved} note={`${usage.totals.recordsRejected} rejected`} />
            <Stat label="Rate-limited" value={usage.totals.rateLimited} />
            <Stat label="Stored" value={usage.storage.records} note={`≈ ${(usage.storage.approxBytes / 1024).toFixed(0)} KB`} />
            <Stat label="AI analyses" value={usage.processing.analyses} note={`${usage.processing.tokens.toLocaleString()} tokens`} />
          </div>
          <p className="mt-2 text-sm"><strong>Estimated provider charges:</strong> {costText(usage.cost)}</p>
        </section>
      )}
      <section aria-label="Sync history">
        <h4 className="mb-1 text-sm font-semibold">Sync history</h4>
        {!runs ? <Loading /> : runs.length === 0 ? <p className="text-sm text-slate-500">No syncs yet.</p> : (
          <div className="overflow-x-auto"><table className="min-w-full text-sm">
            <thead><tr><th className="th">When</th><th className="th">Trigger</th><th className="th">Status</th><th className="th">Seen / new / rejected</th><th className="th">Matches</th><th className="th">Error</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id}><td className="td">{fmtDate(r.created_at)}</td><td className="td">{r.trigger}</td>
                <td className="td"><Badge tone={r.status === 'succeeded' ? 'green' : r.status === 'running' || r.status === 'queued' || r.status === 'retrying' ? 'blue' : 'red'}>{r.status}</Badge></td>
                <td className="td">{r.records_seen ?? '—'} / {r.records_new ?? '—'} / {r.records_rejected ?? '—'}</td><td className="td">{r.matches ?? '—'}</td>
                <td className="td text-xs text-red-700">{r.error ? `${r.error.kind}: ${r.error.message}` : ''}</td></tr>))}
            </tbody></table></div>)}
      </section>
    </div>
  );
}

function CredentialForm({ label, configured, hint, onSave, onRemove }: { label: string | null; configured: boolean; hint: string | null; onSave: (s: string) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <><button className="btn-secondary" onClick={() => setOpen(true)}>{configured ? `Reauthorize (key ${hint ?? 'set'})` : `Add ${label ?? 'credentials'}`}</button>
    {configured && <button className="btn-danger" onClick={onRemove}>Remove key</button>}</>;
  return (
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('secret')); if (v) onSave(v); setOpen(false); }}>
      <label className="sr-only" htmlFor="cred-secret">{label}</label>
      <input id="cred-secret" name="secret" type="password" autoComplete="off" minLength={8} required className="input" placeholder={label ?? 'Secret'} />
      <button className="btn-primary">Save</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

function ApprovalForm({ approved, onSubmit }: { approved: boolean; onSubmit: (approved: boolean, reference?: string) => void }) {
  if (approved) return <button className="btn-secondary mt-2" onClick={() => onSubmit(false)}>Revoke AI-analysis approval</button>;
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(true, String(new FormData(e.currentTarget).get('reference'))); }}>
      <div><label className="label" htmlFor="appr-ref">Approval reference</label>
        <input id="appr-ref" name="reference" className="input" required minLength={3} maxLength={500} placeholder="Derived-metrics amendment acceptance (date, Google ticket)" /></div>
      <button className="btn-primary">Record approval</button>
    </form>
  );
}

// ── Providers ──────────────────────────────────────────────────────────────────────────────────────

function ProvidersPanel({ providers }: { providers: ProviderInfo[] }) {
  return (
    <section aria-labelledby="prov-h">
      <h2 id="prov-h" className="mb-1 font-semibold">Provider capability matrix</h2>
      <p className="mb-4 text-sm text-slate-600">From official documentation, with the date it was read. “Implemented” means a connector exists and passes contract tests against a simulated API; no provider has been verified with live credentials yet.</p>
      <div className="space-y-3">
        {providers.map((p) => (
          <details key={p.provider} className="card">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="font-medium">{p.displayName}</span>
              <Badge tone={p.implementation === 'implemented' ? 'green' : 'slate'}>{p.implementation === 'implemented' ? 'Connector available' : 'No connector'}</Badge>
              <Badge tone={p.access === 'requires_credentials' ? 'blue' : 'amber'}>{ACCESS_LABEL[p.access]}</Badge>
              <Badge tone={p.liveVerified ? 'green' : 'amber'}>{p.liveVerified ? 'Live-verified' : 'Not live-verified'}</Badge>
              <span className="text-xs text-slate-500">docs read {p.verifiedAt ?? 'not verified'}</span>
            </summary>
            <div className="mt-3 grid gap-4 text-sm md:grid-cols-2">
              <div>
                <p className="mb-2 text-slate-700">{p.relevance}</p>
                <h4 className="font-semibold">Operations</h4>
                <ul className="mb-2">{p.operationsDetail.map((o) => <li key={o.operation}>{o.supported ? '✓' : '✗'} {o.label}{o.reason && !o.supported && o.reason !== 'Not offered by this provider or connector' ? <span className="block pl-4 text-xs text-slate-500">{o.reason}</span> : null}</li>)}</ul>
                <p><strong>Authentication:</strong> {p.auth.method}{p.auth.credentialLabel ? ` (${p.auth.credentialLabel})` : ''}</p>
                {p.auth.setup.length > 0 && <ol className="mt-1 list-decimal pl-5 text-xs text-slate-600">{p.auth.setup.map((s) => <li key={s}>{s}</li>)}</ol>}
                <p className="mt-2"><strong>History:</strong> {p.historicalCoverage}</p>
                {p.metrics.length > 0 && <p><strong>Metrics returned:</strong> {p.metrics.join(', ')}</p>}
              </div>
              <div>
                <h4 className="font-semibold">Quota and cost</h4>
                {p.quota.buckets.length ? <ul>{p.quota.buckets.map((b) => <li key={b.key}>{b.label}: {b.perDay?.toLocaleString() ?? 'unknown'}/day: {b.costNote}</li>)}</ul> : null}
                <p className="text-xs text-slate-600">{p.quota.resetNote}</p>
                <p className="text-xs text-slate-600">{p.pricing.note}</p>
                <h4 className="mt-2 font-semibold">Data rights</h4>
                <ul className="text-xs text-slate-700">
                  <li>Storage: {p.rights.storageMaxDays ? `max ${p.rights.storageMaxDays} days` : 'unverified'}; refresh within {p.rights.refreshWithinDays ?? '—'} days; deletion on request within {p.rights.deletionOnRequestDays ?? '—'} days</li>
                  <li>Derived analysis: {p.rights.derivedAnalysis.replace('_', ' ')}: {p.rights.derivedAnalysisNote}</li>
                  <li>Aggregating metrics: {p.rights.metricAggregation}</li>
                  <li>Redistribution: {p.rights.redistribution}</li><li>Attribution: {p.rights.attribution}</li><li>Commercial use: {p.rights.commercialUse}</li>
                </ul>
                {p.limitations.length > 0 && <><h4 className="mt-2 font-semibold">Limitations</h4><ul className="list-disc pl-5 text-xs text-slate-700">{p.limitations.map((l) => <li key={l}>{l}</li>)}</ul></>}
                {p.docs.length > 0 && <><h4 className="mt-2 font-semibold">Sources</h4><ul className="text-xs">{p.docs.map((d) => <li key={d.url}><a className="text-brand-700 underline" href={safeHref(d.url)} target="_blank" rel="noreferrer noopener">{d.title}</a></li>)}</ul></>}
              </div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

// ── Analytics ──────────────────────────────────────────────────────────────────────────────────────

function AnalyticsPanel() {
  const org = useOrg();
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [data, setData] = useState<SocialAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<Project[]>(`/organizations/${org.id}/projects`).then(setProjects).catch(() => setProjects([])); }, [org.id]);
  useEffect(() => {
    setData(null); setError(null);
    void api<SocialAnalytics>(`/organizations/${org.id}/social/analytics?days=${days}${projectId ? `&projectId=${projectId}` : ''}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [org.id, days, projectId]);
  return (
    <section aria-labelledby="an-h">
      <h2 id="an-h" className="sr-only">Social analytics</h2>
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="text-sm">Period <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select></label>
        <label className="text-sm">Project <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">All visible projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      {error && <Alert>{error}</Alert>}
      {!data && !error && <Loading />}
      {data && data.totals.records === 0 && <Empty title="No social records in this period">Records appear once an authorized connector has synced and its records match a project query.</Empty>}
      {data && data.totals.records > 0 && (
        <div className="space-y-6">
          <Alert tone="info">{data.definitions.caution} Tone figures for social posts are reported here only; news-article tone is on the Analytics page. Engagement counts are as returned by the provider and are not reach or impressions.</Alert>
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Social records" value={data.totals.records} note={`${fmtDate(data.period.from)}: ${fmtDate(data.period.to)}`} />
            <Stat label="Analysed" value={data.totals.analysed} note="with a derived-analysis approval" />
            <Stat label="With hashtags" value={data.totals.withHashtags} />
            <Stat label="Latest record" value={relTime(data.freshness.latestRecordDiscoveredAt)} note={data.freshness.oldestMetricsObservedAt ? `oldest metrics observed ${relTime(data.freshness.oldestMetricsObservedAt)}` : undefined} />
          </div>
          <Table caption="Volume by platform and content type" note={data.definitions.volumeShare} head={['Platform', 'Content', 'Records', 'Share']}
            rows={data.volume.map((v) => [PLATFORM_LABEL[v.platform] ?? v.platform, CONTENT_LABEL[v.contentType] ?? v.contentType, v.records.toLocaleString(), shareText(v.share)])} />
          <Table caption="Trend" note={`Records per ${data.period.granularity}, by platform (${data.period.timezone}).`} head={['Period', ...data.trend.platforms.map((p) => PLATFORM_LABEL[p] ?? p)]}
            rows={data.trend.points.filter((pt) => data.trend.platforms.some((p) => Number(pt[p]) > 0)).map((pt) => [String(pt.bucket), ...data.trend.platforms.map((p) => String(pt[p] ?? 0))])} />
          <Table caption="Record-level tone by platform and content type" note={data.definitions.sentiment}
            head={['Platform', 'Content', 'Records', 'Analysed', 'Uncertain', 'Not permitted', 'Positive', 'Neutral', 'Negative', 'Mixed']}
            rows={data.sentiment.map((g) => [PLATFORM_LABEL[g.platform] ?? g.platform, CONTENT_LABEL[g.contentType] ?? g.contentType, g.records, g.analysed, g.uncertain, g.notPermitted,
              shareText(g.shares.positive ?? null), shareText(g.shares.neutral ?? null), shareText(g.shares.negative ?? null), shareText(g.shares.mixed ?? null)].map(String))} />
          {data.conversations.length > 0 && <Table caption="Conversation-level tone (comments under one video)" note={data.definitions.conversation}
            head={['Video', 'Comments', 'Analysed', 'Positive', 'Neutral', 'Negative', 'Mixed', 'Uncertain']}
            rows={data.conversations.map((cv) => [cv.title ?? cv.parentExternalId, cv.comments, cv.analysed, cv.counts.positive ?? 0, cv.counts.neutral ?? 0, cv.counts.negative ?? 0, cv.counts.mixed ?? 0, cv.uncertain].map(String))} />}
          <div className="grid gap-6 md:grid-cols-2">
            <Table caption="Hashtags" note={data.definitions.hashtagShare} head={['Hashtag', 'Records', 'Share']} rows={data.hashtags.map((h) => [`#${h.tag}`, String(h.records), shareText(h.share)])} />
            <Table caption="Topics" note={data.definitions.topicShare} head={['Topic', 'Records', 'Share']} rows={data.topics.map((t) => [t.label, String(t.records), shareText(t.share)])} />
          </div>
          {data.engagement.map((e) => (
            <div key={e.platform} className="card">
              <h3 className="font-semibold">Engagement on {PLATFORM_LABEL[e.platform] ?? e.platform}</h3>
              <p className="text-xs text-slate-600">{data.definitions.engagement} {e.note}</p>
              <p className="mt-2 text-sm">{e.metrics.map((m) => `${m.metric}: available on ${m.recordsWithMetric} of ${m.recordsWithMetric + m.recordsWithoutMetric} records`).join(' · ')}</p>
              {e.top.length > 0 && <table className="mt-2 min-w-full text-sm"><caption className="sr-only">Records with the highest {e.sortedBy}</caption>
                <thead><tr><th className="th">Record</th>{e.metrics.map((m) => <th key={m.metric} className="th">{m.metric}</th>)}<th className="th">Observed</th></tr></thead>
                <tbody>{e.top.map((r) => <tr key={r.id}><td className="td"><a href={safeHref(r.url)} target="_blank" rel="noreferrer noopener" className="text-brand-700 underline">{r.title}</a> <span className="text-xs text-slate-500">{CONTENT_LABEL[r.content_type]}</span></td>
                  {e.metrics.map((m) => <td key={m.metric} className="td">{r.engagement[m.metric]?.toLocaleString() ?? 'not returned'}</td>)}<td className="td text-xs">{relTime(r.observedAt)}</td></tr>)}</tbody></table>}
            </div>
          ))}
          <div className="grid gap-6 md:grid-cols-2">
            <Table caption="Account and channel coverage" note={data.definitions.accounts} head={['Platform', 'Distinct accounts', 'Posts with account id', 'Posts']}
              rows={data.accounts.map((a) => [PLATFORM_LABEL[a.platform] ?? a.platform, String(a.accounts), String(a.recordsWithAccountId), String(a.records)])} />
            <Table caption="Entities across news and social" note={data.definitions.crossPlatformEntities} head={['Entity', 'News articles', 'Social records']}
              rows={data.crossPlatformEntities.map((x) => [x.name, String(x.news), String(x.social)])} />
          </div>
          <Table caption="Tone toward entities (social records)" note={data.definitions.entitySentiment} head={['Entity', 'Results', 'Positive', 'Neutral', 'Negative', 'Mixed', 'Uncertain']}
            rows={data.entitySentiment.map((x) => [x.name, x.results, x.counts.positive ?? 0, x.counts.neutral ?? 0, x.counts.negative ?? 0, x.counts.mixed ?? 0, x.uncertain].map(String))} />
        </div>
      )}
    </section>
  );
}

function Table({ caption, note, head, rows }: { caption: string; note?: string; head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="px-3 pt-3 text-left"><span className="font-semibold">{caption}</span>{note && <span className="block text-xs font-normal text-slate-500">{note}</span>}</caption>
        <thead className="bg-slate-50"><tr>{head.map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="td">{c}</td>)}</tr>) : <tr><td className="td text-slate-500" colSpan={head.length}>No data</td></tr>}</tbody>
      </table>
    </div>
  );
}

// ── Mentions ───────────────────────────────────────────────────────────────────────────────────────

interface SocialMention { id: string; title: string; url: string; platform: string; content_type: string; publisher: string | null; published_at: string | null; discovered_at: string;
  hashtags: string[]; engagement: Record<string, number>; engagement_observed_at: string | null; provider_delete_by: string | null; sentiment: { label: string; uncertain: boolean } | null }

function MentionsPanel() {
  const org = useOrg();
  const [q, setQ] = useState(''); const [contentType, setContentType] = useState(''); const [hashtag, setHashtag] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ items: SocialMention[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams({ limit: '25', offset: String(offset), sort: 'discovered' });
    if (q) p.set('q', q); if (contentType) p.set('contentType', contentType); if (hashtag) p.set('hashtag', hashtag);
    void api<{ items: SocialMention[]; total: number }>(`/organizations/${org.id}/social/mentions?${p}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [org.id, q, contentType, hashtag, offset]);
  return (
    <section aria-labelledby="sm-h">
      <h2 id="sm-h" className="sr-only">Social mentions</h2>
      <form className="mb-4 flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); setOffset(0); setQ(String(f.get('q') ?? '')); setHashtag(String(f.get('hashtag') ?? '').replace(/^#/, '')); }}>
        <label className="text-sm">Text <input name="q" className="input" defaultValue={q} placeholder="search text" /></label>
        <label className="text-sm">Hashtag <input name="hashtag" className="input" defaultValue={hashtag} placeholder="#banjir" /></label>
        <label className="text-sm">Type <select className="input" value={contentType} onChange={(e) => { setOffset(0); setContentType(e.target.value); }}>
          <option value="">All</option>{['video', 'live_stream', 'comment'].map((t) => <option key={t} value={t}>{CONTENT_LABEL[t]}</option>)}</select></label>
        <button className="btn-secondary self-end">Search</button>
      </form>
      {error && <Alert>{error}</Alert>}
      {!data && !error && <Loading />}
      {data?.total === 0 && <Empty title="No social records">Only records matched to projects you can see are listed.</Empty>}
      {data && data.total > 0 && (
        <>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {data.items.map((m) => (
              <li key={m.id} className="p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <Badge tone="blue">{PLATFORM_LABEL[m.platform] ?? m.platform}</Badge><span>{CONTENT_LABEL[m.content_type] ?? m.content_type}</span>
                  {m.publisher && <span>{m.publisher}</span>}<span>published {fmtDate(m.published_at)}</span><span>collected {relTime(m.discovered_at)}</span>
                  {m.sentiment && <Badge tone="slate">{m.sentiment.label}{m.sentiment.uncertain ? ' (uncertain)' : ''}: CivicSignal estimate</Badge>}
                </div>
                <Link href={`/o/${org.id}/mentions/${m.id}`} className="mt-1 block font-medium text-brand-700 hover:underline">{m.title}</Link>
                <p className="text-xs text-slate-600">
                  <a href={safeHref(m.url)} target="_blank" rel="noreferrer noopener" className="underline">Open on {PLATFORM_LABEL[m.platform] ?? m.platform}</a>
                  {Object.keys(m.engagement).length > 0 && <> · {Object.entries(m.engagement).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ')} (as of {relTime(m.engagement_observed_at)})</>}
                  {m.hashtags.length > 0 && <> · {m.hashtags.map((h) => `#${h}`).join(' ')}</>}
                  {m.provider_delete_by && <> · removed by {fmtDate(m.provider_delete_by)} unless refreshed</>}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-3 text-sm">
            <button className="btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</button>
            <span>{offset + 1}–{Math.min(offset + 25, data.total)} of {data.total}</span>
            <button className="btn-secondary" disabled={offset + 25 >= data.total} onClick={() => setOffset(offset + 25)}>Next</button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Budgets ────────────────────────────────────────────────────────────────────────────────────────

interface BudgetsResponse {
  budgets: Array<{ id: string; connector_id: string | null; metric: string; period: string; warn_at: string | null; soft_limit: string | null; hard_limit: string | null }>;
  events: Array<{ id: string; level: string; metric: string; period_key: string; value: string; threshold: string; created_at: string; acknowledged_at: string | null }>;
  states: Array<{ connectorId: string; level: string; items: Array<{ budgetId: string; metric: string; period: string; value: number; level: string; costStatus?: string }> }>;
  levels: Record<string, string>;
}

function BudgetsPanel({ connectors }: { connectors: SocialConnector[] }) {
  const org = useOrg();
  const manage = canSocial.manage(org.role);
  const [data, setData] = useState<BudgetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<BudgetsResponse>(`/organizations/${org.id}/social/budgets`).then(setData).catch((e) => setError(errorMessage(e))), [org.id]);
  useEffect(() => { void load(); }, [load]);
  const name = (id: string | null) => (id ? connectors.find((c) => c.connectorId === id)?.name ?? 'One connector' : 'All social connectors');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null);
    const f = new FormData(e.currentTarget); const num = (k: string) => (f.get(k) ? Number(f.get(k)) : null);
    try {
      await api(`/organizations/${org.id}/social/budgets`, { method: 'PUT', body: { connectorId: null, metric: String(f.get('metric')), period: String(f.get('period')), warnAt: num('warnAt'), softLimit: num('softLimit'), hardLimit: num('hardLimit') } });
      await load();
    } catch (x) { setError(errorMessage(x)); }
  }
  return (
    <section aria-labelledby="bud-h" className="space-y-4">
      <h2 id="bud-h" className="font-semibold">Budgets</h2>
      {error && <Alert>{error}</Alert>}
      {data && <p className="text-sm text-slate-600">Warn: {data.levels.warn} · Soft limit: {data.levels.soft} · Hard limit: {data.levels.hard}. Provider quotas are enforced separately (see each connector).</p>}
      {data?.budgets.length === 0 && <Empty title="No budgets">Provider quotas still apply. Budgets add your own limits per day or month.</Empty>}
      {data && data.budgets.length > 0 && <Table caption="Configured budgets" head={['Scope', 'Metric', 'Period', 'Warn', 'Soft', 'Hard']}
        rows={data.budgets.map((b) => [name(b.connector_id), b.metric, b.period, b.warn_at ?? '—', b.soft_limit ?? '—', b.hard_limit ?? '—'])} />}
      {manage && (
        <form onSubmit={save} className="card grid gap-3 sm:grid-cols-6" aria-label="Set budget">
          <label className="text-sm sm:col-span-2">Metric <select name="metric" className="input"><option value="quota_units">Quota units</option><option value="requests">API requests</option><option value="records_retrieved">Records retrieved</option><option value="estimated_cost">Estimated cost (needs verified pricing)</option></select></label>
          <label className="text-sm">Period <select name="period" className="input"><option value="day">Day</option><option value="month">Month</option></select></label>
          <label className="text-sm">Warn at <input name="warnAt" type="number" min={0} step="any" className="input" /></label>
          <label className="text-sm">Soft limit <input name="softLimit" type="number" min={0} step="any" className="input" /></label>
          <label className="text-sm">Hard limit <input name="hardLimit" type="number" min={0} step="any" className="input" /></label>
          <div className="sm:col-span-6"><button className="btn-primary">Save budget (all connectors)</button></div>
        </form>
      )}
      {data && data.events.length > 0 && <Table caption="Notices" head={['When', 'Level', 'Metric', 'Value / threshold', 'Period', 'Acknowledged']}
        rows={data.events.map((ev) => [fmtDate(ev.created_at), ev.level, ev.metric, `${Number(ev.value)} / ${Number(ev.threshold)}`, ev.period_key, ev.acknowledged_at ? fmtDate(ev.acknowledged_at) : 'no'])} />}
    </section>
  );
}
