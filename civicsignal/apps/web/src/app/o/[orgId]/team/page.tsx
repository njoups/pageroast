'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useOrg } from '@/components/org-context';
import { useSession } from '@/components/session';
import { Alert, Badge, Loading, PageHeader } from '@/components/ui';
import { api, can, errorMessage, fmtDate, ROLE_LABEL, type Member, type Role } from '@/lib/api';

type Invitation = { id: string; email: string; role: Role; expires_at: string; created_at: string };
const ROLES: Role[] = ['owner', 'admin', 'project_manager', 'analyst', 'report_viewer'];
const PRIVILEGED = new Set<Role>(['owner', 'admin']);

export default function TeamPage() {
  const org = useOrg();
  const { me } = useSession();
  const router = useRouter();
  async function leave() {
    if (!window.confirm(`Leave ${org.name}? You will lose access immediately.`)) return;
    try { await api(`/organizations/${org.id}/leave`, { method: 'POST' }); router.replace('/'); }
    catch (e) { setError(errorMessage(e)); }
  }
  const leaveButton = <button className="btn-danger" onClick={leave}>Leave organization</button>;
  const manage = can.manageMembers(org.role);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers(await api<Member[]>(`/organizations/${org.id}/members`));
      if (manage) setInvites(await api<Invitation[]>(`/organizations/${org.id}/invitations`));
    } catch (e) { setError(errorMessage(e)); }
  }, [org.id, manage]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(errorMessage(e)); await load(); }
    setBusy(false);
  }

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true); setError(null); setNotice(null); setLink(null);
    try {
      const r = await api<{ token: string; email: string }>(`/organizations/${org.id}/invitations`, { method: 'POST', body: { email: f.get('email'), role: f.get('role') } });
      setLink(`${window.location.origin}/onboarding#token=${encodeURIComponent(r.token)}`);
      form.reset(); await load();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  if (!can.readMembers(org.role)) {
    return <><PageHeader title="Team" actions={leaveButton} />{error && <Alert>{error}</Alert>}<Alert tone="info">Your role does not include viewing the member list.</Alert></>;
  }

  return (
    <>
      <PageHeader title="Team" description="Members of this organization and their roles. Role changes and removals take effect immediately and are recorded in the audit log." actions={leaveButton} />
      <div className="mb-4 space-y-3">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {link && (
          <Alert tone="info">
            <p className="font-medium">Invitation created. Email delivery is not configured, so share this one-time link with the invitee securely:</p>
            <div className="mt-2 flex gap-2">
              <input readOnly value={link} className="input font-mono text-xs" aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn-secondary" onClick={() => navigator.clipboard?.writeText(link).then(() => setNotice('Link copied.'))}>Copy</button>
            </div>
            <p className="mt-1 text-xs">It will not be shown again and expires in 7 days.</p>
          </Alert>
        )}
      </div>
      {!members ? <Loading /> : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Joined</th>{manage && <th className="th"><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((m) => (
                <tr key={m.user_id}>
                  <td className="td font-medium">{m.display_name}{m.user_id === me.user.id && <> <Badge tone="blue">You</Badge></>}</td>
                  <td className="td">{m.email}</td>
                  <td className="td">
                    {manage && (org.role === 'owner' || !PRIVILEGED.has(m.role)) ? (
                      <select className="input w-auto py-1" aria-label={`Role for ${m.display_name}`} value={m.role} disabled={busy}
                        onChange={(e) => act(() => api(`/organizations/${org.id}/members/${m.user_id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated.')}>
                        {ROLES.filter((r) => org.role === 'owner' || !PRIVILEGED.has(r)).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    ) : ROLE_LABEL[m.role]}
                  </td>
                  <td className="td text-xs">{fmtDate(m.created_at)}</td>
                  {manage && <td className="td text-right">
                    {(org.role === 'owner' || !PRIVILEGED.has(m.role)) && <button className="btn-danger px-2 py-1 text-xs" disabled={busy} onClick={() => {
                      if (window.confirm(`Remove ${m.display_name} from ${org.name}?`)) void act(() => api(`/organizations/${org.id}/members/${m.user_id}`, { method: 'DELETE' }), 'Member removed.');
                    }}>Remove</button>}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manage && (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <form onSubmit={invite} className="card space-y-4" aria-label="Invite member">
            <h2 className="font-semibold">Invite a member</h2>
            <div><label className="label" htmlFor="email">Email</label><input id="email" name="email" type="email" required className="input" /></div>
            <div><label className="label" htmlFor="role">Role</label>
              <select id="role" name="role" className="input" defaultValue="analyst">
                {ROLES.filter((r) => r !== 'owner' && (org.role === 'owner' || r !== 'admin')).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select></div>
            <button className="btn-primary" disabled={busy}>Create invitation</button>
          </form>
          <section className="card" aria-labelledby="inv-h">
            <h2 id="inv-h" className="font-semibold">Pending invitations</h2>
            {invites.length === 0 ? <p className="mt-3 text-sm text-slate-500">None.</p> : (
              <ul className="mt-3 divide-y divide-slate-100">
                {invites.map((i) => (
                  <li key={i.id} className="flex items-center justify-between py-2 text-sm">
                    <span>{i.email} <Badge>{ROLE_LABEL[i.role]}</Badge><br /><span className="text-xs text-slate-500">Expires {fmtDate(i.expires_at)}</span></span>
                    <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => act(() => api(`/organizations/${org.id}/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation revoked.')}>Revoke</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
