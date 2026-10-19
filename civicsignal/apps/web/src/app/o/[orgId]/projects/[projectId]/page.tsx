'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, can, errorMessage, fmtDate, parseLanguages, ROLE_LABEL, type Member, type Project, type Role } from '@/lib/api';

type ProjectMember = { user_id: string; display_name: string; email: string; role: Role };

export default function ProjectDetail() {
  const org = useOrg();
  const router = useRouter();
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/organizations/${org.id}/projects/${projectId}`;
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [orgMembers, setOrgMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can.createProject(org.role);

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api<Project>(base), api<ProjectMember[]>(`${base}/members`)]);
      setProject(p); setMembers(m);
      if (manage && can.readMembers(org.role)) setOrgMembers(await api<Member[]>(`/organizations/${org.id}/members`));
    } catch (e) { setError(errorMessage(e)); }
  }, [base, manage, org.id, org.role]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void act(() => api(base, { method: 'PATCH', body: {
      name: f.get('name'), objective: f.get('objective'), languages: parseLanguages(String(f.get('languages') ?? '')),
      dateRangeStart: f.get('start') || null, dateRangeEnd: f.get('end') || null,
    } }), 'Project saved.');
  }

  async function remove() {
    if (!project || !window.confirm(`Permanently delete "${project.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try { await api(base, { method: 'DELETE' }); router.replace(`/o/${org.id}/projects`); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  if (!project) return error ? <Alert>{error}</Alert> : <Loading />;
  const archived = project.status === 'archived';
  const assignable = orgMembers.filter((m) => !members.some((pm) => pm.user_id === m.user_id) && m.role !== 'owner' && m.role !== 'admin');

  return (
    <>
      <p className="mb-2 text-sm"><Link href={`/o/${org.id}/projects`} className="text-brand-600 underline">← Projects</Link></p>
      <PageHeader title={project.name} description={`Created ${fmtDate(project.created_at)} · Last updated ${fmtDate(project.updated_at)}`}
        actions={<>
          {manage && <button className="btn-secondary" disabled={busy} onClick={() => act(() => api(`${base}/${archived ? 'unarchive' : 'archive'}`, { method: 'POST' }), archived ? 'Project restored.' : 'Project archived.')}>{archived ? 'Unarchive' : 'Archive'}</button>}
          {can.deleteProject(org.role) && <button className="btn-danger" disabled={busy} onClick={remove}>Delete</button>}
        </>} />
      <div className="mb-4 space-y-3">
        {archived && <Alert tone="warning">This project is archived and read-only. Unarchive it to make changes.</Alert>}
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <form onSubmit={save} className="card space-y-4 lg:col-span-2" aria-label="Project settings">
          <h2 className="font-semibold">Settings</h2>
          <fieldset disabled={!manage || archived || busy} className="grid gap-4 md:grid-cols-2">
            <div><label className="label" htmlFor="name">Name</label><input id="name" name="name" defaultValue={project.name} required minLength={2} maxLength={120} className="input" /></div>
            <div><label className="label" htmlFor="languages">Languages</label><input id="languages" name="languages" defaultValue={project.languages.join(', ')} className="input" /></div>
            <div className="md:col-span-2"><label className="label" htmlFor="objective">Objective</label><textarea id="objective" name="objective" defaultValue={project.objective} rows={3} maxLength={2000} className="input" /></div>
            <div><label className="label" htmlFor="start">Monitoring start</label><input id="start" name="start" type="date" defaultValue={project.date_range_start?.slice(0, 10) ?? ''} className="input" /></div>
            <div><label className="label" htmlFor="end">Monitoring end</label><input id="end" name="end" type="date" defaultValue={project.date_range_end?.slice(0, 10) ?? ''} className="input" /></div>
          </fieldset>
          {manage && !archived && <button className="btn-primary" disabled={busy}>Save changes</button>}
          <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-medium text-slate-800">Keywords, Boolean queries and sources</p>
            <p className="mt-1">Query configuration and source selection ship with news ingestion in Milestone 2. <Badge tone="amber">Not yet available</Badge></p>
          </div>
        </form>
        <section className="card" aria-labelledby="pm-h">
          <h2 id="pm-h" className="font-semibold">Assigned members</h2>
          <p className="mt-1 text-xs text-slate-500">Owners and administrators can always access every project.</p>
          <ul className="mt-4 space-y-2">
            {members.length === 0 && <li><Empty title="No one assigned" /></li>}
            {members.map((m) => (
              <li key={m.user_id} className="flex items-center justify-between gap-2 text-sm">
                <span><span className="font-medium">{m.display_name}</span><br /><span className="text-xs text-slate-500">{ROLE_LABEL[m.role]}</span></span>
                {manage && <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} aria-label={`Remove ${m.display_name} from project`}
                  onClick={() => act(() => api(`${base}/members/${m.user_id}`, { method: 'DELETE' }), 'Member removed from project.')}>Remove</button>}
              </li>
            ))}
          </ul>
          {manage && assignable.length > 0 && (
            <form className="mt-4 flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              const userId = new FormData(e.currentTarget).get('userId');
              void act(() => api(`${base}/members`, { method: 'POST', body: { userId } }), 'Member assigned.');
            }}>
              <label className="sr-only" htmlFor="userId">Member to assign</label>
              <select id="userId" name="userId" className="input" required>{assignable.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name} ({ROLE_LABEL[m.role]})</option>)}</select>
              <button className="btn-secondary" disabled={busy}>Assign</button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
