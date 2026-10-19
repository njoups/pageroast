'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { SeverityBadge } from '@/components/alerts-ui';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { SEVERITIES, SEVERITY_LABEL, type Severity } from '@/lib/alerts';
import { api, errorMessage, fmtDate } from '@/lib/api';

interface Item { id: string; issue_id: string | null; kind: string; read_at: string | null; created_at: string; payload: { title: string; heading: string; severity: Severity; rationale: string; link: string } }
interface Prefs { items: Array<{ channel: string; enabled: boolean; min_severity: Severity; destination: string | null }>;
  defaults: Record<string, { enabled: boolean; minSeverity: Severity }>; channels: Record<string, { configured: boolean; note: string | null }> }

export default function NotificationsPage() {
  const org = useOrg();
  const base = `/organizations/${org.id}/notifications`;
  const [inbox, setInbox] = useState<{ unread: number; items: Item[] } | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setInbox(await api(`${base}?limit=50${unreadOnly ? '&unread=true' : ''}`)); setPrefs(await api(`${base}/preferences`)); } catch (e) { setError(errorMessage(e)); }
  }, [base, unreadOnly]);
  useEffect(() => { void load(); }, [load]);

  async function mark(id: string, read: boolean) { try { await api(`${base}/${id}`, { method: 'PATCH', body: { read } }); await load(); } catch (e) { setError(errorMessage(e)); } }
  async function readAll() { try { await api(`${base}/read-all`, { method: 'POST' }); await load(); } catch (e) { setError(errorMessage(e)); } }
  async function savePrefs(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null);
    const f = new FormData(e.currentTarget);
    const items = (['in_app', 'email', 'whatsapp'] as const).map((ch) => ({ channel: ch, enabled: f.get(`${ch}_enabled`) === 'on', minSeverity: String(f.get(`${ch}_min`)),
      ...(ch === 'whatsapp' ? { destination: String(f.get('whatsapp_dest') ?? '').trim() || null } : {}) }));
    try { await api(`${base}/preferences`, { method: 'PUT', body: { items } }); setNotice('Preferences saved.'); await load(); } catch (x) { setError(errorMessage(x)); }
  }
  const pref = (ch: string) => { const p = prefs?.items.find((x) => x.channel === ch); const d = prefs?.defaults[ch]; return { enabled: p ? p.enabled : d?.enabled ?? false, min: p ? p.min_severity : d?.minSeverity ?? 'low', dest: p?.destination ?? '' }; };

  return (
    <>
      <PageHeader title="Notifications" description="Your in-app notifications about issues in projects you can access, and how you want to be notified." />
      <div className="mb-4 space-y-2">{error && <Alert>{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}</div>
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card lg:col-span-2" aria-labelledby="inbox-h">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="inbox-h" className="font-semibold">Inbox {inbox && <span className="text-sm font-normal text-slate-500">({inbox.unread} unread)</span>}</h2>
            <div className="flex gap-2 text-sm"><label className="flex items-center gap-1"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Unread only</label><button className="btn-secondary py-1" onClick={() => void readAll()}>Mark all read</button></div></div>
          {!inbox ? <Loading /> : inbox.items.length === 0 ? <div className="mt-3"><Empty title="No notifications" /></div> : (
            <ul className="mt-3 divide-y divide-slate-100">{inbox.items.map((n) => (
              <li key={n.id} className={`flex items-start justify-between gap-3 py-3 ${n.read_at ? 'opacity-70' : ''}`}>
                <div className="min-w-0"><p className="flex flex-wrap items-center gap-2 text-sm">{!n.read_at && <span className="h-2 w-2 rounded-full bg-brand-600" aria-label="unread" />}<SeverityBadge severity={n.payload.severity} /><span className="text-xs text-slate-500">{n.payload.heading}</span></p>
                  {n.issue_id ? <Link className="mt-1 block font-medium text-brand-700 hover:underline" href={`/o/${org.id}/alerts/${n.issue_id}`} onClick={() => !n.read_at && void mark(n.id, true)}>{n.payload.title}</Link> : <p className="mt-1 font-medium">{n.payload.title}</p>}
                  <p className="text-xs text-slate-600">{n.payload.rationale}</p><time className="text-xs text-slate-500" dateTime={n.created_at}>{fmtDate(n.created_at)}</time></div>
                <button className="shrink-0 text-xs text-brand-700 underline" onClick={() => void mark(n.id, !n.read_at)}>{n.read_at ? 'Mark unread' : 'Mark read'}</button>
              </li>
            ))}</ul>
          )}
        </section>
        <form className="card h-fit space-y-4" onSubmit={savePrefs} aria-labelledby="pref-h">
          <h2 id="pref-h" className="font-semibold">My preferences</h2>
          {prefs && (['in_app', 'email', 'whatsapp'] as const).map((ch) => (
            <fieldset key={ch} className="space-y-1"><legend className="flex items-center gap-2 text-sm font-medium">{ch === 'in_app' ? 'In-app' : ch === 'email' ? 'Email' : 'WhatsApp'}
              {!prefs.channels[ch]?.configured && <Badge tone="amber">Not configured on this server</Badge>}</legend>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`${ch}_enabled`} defaultChecked={pref(ch).enabled} />Notify me</label>
              <label className="flex items-center gap-2 text-sm">for severity ≥<select name={`${ch}_min`} className="input w-auto py-1" defaultValue={pref(ch).min}>{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}</select></label>
              {ch === 'whatsapp' && <><input name="whatsapp_dest" className="input" placeholder="+6281234567890" defaultValue={pref(ch).dest} aria-label="WhatsApp number (E.164)" />
                <p className="text-xs text-slate-500">Opt in with your own number. Messages use an approved WhatsApp Business template; no unofficial gateways.</p></>}
              {prefs.channels[ch]?.note && <p className="text-xs text-slate-500">{prefs.channels[ch]!.note}</p>}
            </fieldset>
          ))}
          <button className="btn-primary">Save</button>
          <p className="text-xs text-slate-500">You only receive notifications for rules that list you as a recipient or escalation contact, in projects you can access.</p>
        </form>
      </div>
    </>
  );
}
