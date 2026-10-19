'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useOrg } from '@/components/org-context';
import { useSession } from '@/components/session';
import { Alert, Empty, Loading, PageHeader } from '@/components/ui';
import { api, can, errorMessage, fmtDate, type AuditEvent } from '@/lib/api';

export default function AdminPage() {
  const org = useOrg();
  const { refresh } = useSession();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ name: string; settings: Record<string, string> } | null>(null);

  const loadAudit = useCallback(async (before?: number) => {
    try {
      const q = new URLSearchParams({ limit: '50' });
      if (before) q.set('before', String(before));
      if (filter) q.set('action', filter);
      const r = await api<{ items: AuditEvent[]; nextBefore: number | null }>(`/organizations/${org.id}/audit-events?${q}`);
      setEvents((prev) => (before && prev ? [...prev, ...r.items] : r.items)); setNext(r.nextBefore);
    } catch (e) { setError(errorMessage(e)); }
  }, [org.id, filter]);

  useEffect(() => {
    if (!can.readAudit(org.role)) return;
    setEvents(null); void loadAudit();
    api<{ name: string; settings: Record<string, string> }>(`/organizations/${org.id}`).then(setSettings).catch((e) => setError(errorMessage(e)));
  }, [org.id, org.role, loadAudit]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null); setNotice(null);
    try {
      await api(`/organizations/${org.id}`, { method: 'PATCH', body: { name: f.get('name'), settings: { brandColor: f.get('brandColor'), timezone: f.get('timezone') } } });
      setNotice('Organization settings saved.'); await refresh(); void loadAudit();
    } catch (err) { setError(errorMessage(err)); }
  }

  if (!can.readAudit(org.role)) return <><PageHeader title="Administration" /><Alert tone="info">Administration is available to owners and administrators.</Alert></>;

  return (
    <>
      <PageHeader title="Administration" description="Organization settings and the tamper-resistant audit log of sensitive operations." />
      <div className="mb-4 space-y-3">{error && <Alert>{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}</div>
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card space-y-4" aria-labelledby="set-h">
          <h2 id="set-h" className="font-semibold">Organization settings</h2>
          {!settings ? <Loading /> : (
            <form onSubmit={save} className="space-y-4">
              <div><label className="label" htmlFor="name">Name</label><input id="name" name="name" defaultValue={settings.name} required minLength={2} maxLength={120} className="input" disabled={!can.updateOrg(org.role)} /></div>
              <div><label className="label" htmlFor="brandColor">Report brand colour</label><input id="brandColor" name="brandColor" type="color" defaultValue={settings.settings.brandColor ?? '#1f5f99'} className="h-10 w-20 rounded border border-slate-300" /></div>
              <div><label className="label" htmlFor="timezone">Timezone</label>
                <select id="timezone" name="timezone" className="input" defaultValue={settings.settings.timezone ?? 'Asia/Jakarta'}>
                  {['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'UTC'].map((z) => <option key={z}>{z}</option>)}
                </select></div>
              <button className="btn-primary">Save settings</button>
            </form>
          )}
          <div className="border-t border-slate-100 pt-4 text-sm text-slate-600">
            <p className="font-medium text-slate-800">Retention, data export and deletion</p>
            <p className="mt-1">Self-service workflows ship in Milestone 6. Until then, contact your platform operator; requests are handled manually and audited.</p>
          </div>
        </section>
        <section className="card lg:col-span-2" aria-labelledby="audit-h">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="audit-h" className="font-semibold">Audit log</h2>
            <label className="flex items-center gap-2 text-sm"><span>Action</span>
              <select className="input w-auto py-1" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">All</option><option value="project.">Projects</option><option value="member.">Members</option>
                <option value="invitation.">Invitations</option><option value="org.">Organization</option>
              </select></label>
          </div>
          <div className="mt-4">
            {!events ? <Loading /> : events.length === 0 ? <Empty title="No matching events" /> : (
              <>
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead><tr><th className="th">When</th><th className="th">Actor</th><th className="th">Action</th><th className="th">Details</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {events.map((a) => (
                      <tr key={a.id}>
                        <td className="td whitespace-nowrap text-xs"><time dateTime={a.occurred_at}>{fmtDate(a.occurred_at)}</time></td>
                        <td className="td">{a.actor_name ?? 'System'}<br /><span className="text-xs text-slate-500">{a.ip ?? ''}</span></td>
                        <td className="td font-mono text-xs">{a.action}</td>
                        <td className="td max-w-xs truncate font-mono text-xs text-slate-500" title={JSON.stringify(a.metadata)}>{Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {next && <button className="btn-secondary mt-4" onClick={() => loadAudit(next)}>Load older events</button>}
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
