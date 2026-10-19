'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge } from './ui';
import { SEVERITIES, SEVERITY_LABEL } from '@/lib/alerts';
import { api, errorMessage, fmtDate } from '@/lib/api';

interface Hook { id: string; name: string; url: string; is_active: boolean; verified_at: string | null; min_severity: string; consecutive_failures: number; previous_secret_expires_at: string | null; delivered: number; failed: number }
interface Log { channels: Record<string, { configured: boolean; note: string | null }>; recent: Array<{ id: string; channel: string; kind: string; status: string; attempts: number; last_error: string | null; created_at: string; recipient: string | null; not_before: string | null }>; summary: Array<{ channel: string; status: string; n: number }> }

/** Administration panel: channel configuration status, delivery log with retry, and webhook endpoints. */
export function AlertsAdmin({ orgId }: { orgId: string }) {
  const base = `/organizations/${orgId}`;
  const [log, setLog] = useState<Log | null>(null);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setLog(await api(`${base}/notifications/deliveries`)); setHooks(await api(`${base}/webhooks`)); } catch (e) { setError(errorMessage(e)); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, msg: string) => { setError(null); setNotice(null); try { await fn(); setNotice(msg); await load(); } catch (e) { setError(errorMessage(e)); } };

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form);
    await run(async () => { const r = await api<{ secret: string }>(`${base}/webhooks`, { method: 'POST', body: { name: f.get('name'), url: f.get('url'), minSeverity: f.get('minSeverity') } });
      setSecret({ name: String(f.get('name')), value: r.secret }); form.reset(); }, 'Webhook added. Verify it before it can receive alerts.');
  }

  return (
    <section className="card space-y-5 lg:col-span-3" aria-labelledby="ntf-h">
      <h2 id="ntf-h" className="font-semibold">Alert notifications</h2>
      {error && <Alert>{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}
      {log && <div className="grid gap-3 md:grid-cols-4">{Object.entries(log.channels).map(([ch, s]) => (
        <div key={ch} className="rounded border border-slate-200 p-3 text-sm"><p className="flex items-center justify-between font-medium">{ch === 'in_app' ? 'In-app' : ch[0]!.toUpperCase() + ch.slice(1)}{s.configured ? <Badge tone="green">Configured</Badge> : <Badge tone="amber">Not configured</Badge>}</p>
          {s.note && <p className="mt-1 text-xs text-slate-600">{s.note}</p>}
          <p className="mt-1 text-xs text-slate-500">{log.summary.filter((x) => x.channel === ch).map((x) => `${x.status} ${x.n}`).join(' · ') || 'no deliveries in 7 days'}</p></div>
      ))}</div>}

      <div><h3 className="text-sm font-semibold">Webhooks</h3>
        <p className="text-xs text-slate-500">HTTPS endpoints that receive signed JSON for issues (header <code>X-CivicSignal-Signature</code>, HMAC-SHA256). An endpoint must answer the verification challenge before it receives anything. See docs/NOTIFICATIONS.md.</p>
        {secret && <div className="mt-2"><Alert tone="warning">Signing secret for “{secret.name}” (shown once): <code className="break-all">{secret.value}</code></Alert></div>}
        <ul className="mt-2 divide-y divide-slate-100 text-sm">{hooks.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0"><span className="font-medium">{h.name}</span> <span className="break-all text-xs text-slate-500">{h.url}</span>
              <span className="block text-xs text-slate-600">{h.verified_at ? `verified ${fmtDate(h.verified_at)}` : 'not verified'} · severity ≥ {h.min_severity} · {h.delivered} delivered · {h.failed} failed{h.previous_secret_expires_at ? ` · old secret valid until ${fmtDate(h.previous_secret_expires_at)}` : ''}</span></span>
            <span className="flex flex-wrap gap-2">{h.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Disabled</Badge>}
              <button className="text-xs text-brand-700 underline" onClick={() => void run(() => api(`${base}/webhooks/${h.id}/verify`, { method: 'POST' }), 'Endpoint verified.')}>Verify</button>
              <button className="text-xs text-brand-700 underline" onClick={() => void run(async () => { const r = await api<{ secret: string }>(`${base}/webhooks/${h.id}/rotate-secret`, { method: 'POST', body: { graceHours: 24 } }); setSecret({ name: h.name, value: r.secret }); }, 'Secret rotated; the old one stays valid for 24 h.')}>Rotate secret</button>
              <button className="text-xs text-brand-700 underline" onClick={() => void run(() => api(`${base}/webhooks/${h.id}`, { method: 'PATCH', body: { isActive: !h.is_active } }), h.is_active ? 'Disabled.' : 'Enabled.')}>{h.is_active ? 'Disable' : 'Enable'}</button>
              <button className="text-xs text-red-700 underline" onClick={() => confirm(`Delete webhook “${h.name}”?`) && void run(() => api(`${base}/webhooks/${h.id}`, { method: 'DELETE' }), 'Deleted.')}>Delete</button></span>
          </li>
        ))}</ul>
        <form onSubmit={create} className="mt-3 grid gap-2 md:grid-cols-4" aria-label="Add webhook">
          <input name="name" required minLength={2} maxLength={80} placeholder="Name" className="input" aria-label="Webhook name" />
          <input name="url" required placeholder="https://…" className="input md:col-span-2" aria-label="Webhook URL" />
          <div className="flex gap-2"><select name="minSeverity" className="input" defaultValue="medium" aria-label="Minimum severity">{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}</select><button className="btn-secondary">Add</button></div>
        </form>
      </div>

      {log && <div><h3 className="text-sm font-semibold">Recent email / WhatsApp deliveries</h3>
        {log.recent.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
          <div className="overflow-x-auto"><table className="mt-2 w-full text-left text-xs"><thead className="text-slate-500"><tr><th>When</th><th>Channel</th><th>Event</th><th>Recipient</th><th>Status</th><th>Attempts</th><th>Detail</th><th /></tr></thead>
            <tbody>{log.recent.map((d) => <tr key={d.id} className="border-t border-slate-100"><td className="py-1">{fmtDate(d.created_at)}</td><td>{d.channel}</td><td>{d.kind}</td><td>{d.recipient ?? '—'}</td>
              <td><Badge tone={d.status === 'delivered' ? 'green' : ['failed', 'dead'].includes(d.status) ? 'red' : ['unconfigured', 'suppressed', 'deferred'].includes(d.status) ? 'amber' : 'slate'}>{d.status}</Badge></td>
              <td>{d.attempts}</td><td className="max-w-xs truncate" title={d.last_error ?? ''}>{d.status === 'deferred' && d.not_before ? `quiet hours until ${fmtDate(d.not_before)}` : d.last_error ?? ''}</td>
              <td>{['failed', 'dead'].includes(d.status) && <button className="text-brand-700 underline" onClick={() => void run(() => api(`${base}/notifications/deliveries/${d.id}/retry`, { method: 'POST' }), 'Retry queued.')}>Retry</button>}</td></tr>)}</tbody></table></div>
        )}</div>}
    </section>
  );
}
