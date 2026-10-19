'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, can, errorMessage, fmtDate, parseLanguages, type Project } from '@/lib/api';
import { useOrg } from '@/components/org-context';

export default function ProjectsPage() {
  const org = useOrg();
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setProjects(null); setError(null);
    try { setProjects(await api<Project[]>(`/organizations/${org.id}/projects?status=${status}`)); }
    catch (e) { setError(errorMessage(e)); }
  }, [org.id, status]);
  useEffect(() => { void load(); }, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setFormError(null);
    try {
      await api(`/organizations/${org.id}/projects`, { method: 'POST', body: {
        name: f.get('name'), objective: f.get('objective') || undefined,
        languages: parseLanguages(String(f.get('languages') ?? '')),
        dateRangeStart: f.get('start') || undefined, dateRangeEnd: f.get('end') || undefined,
      } });
      setShowForm(false); setStatus('active'); await load();
    } catch (err) { setFormError(errorMessage(err)); }
    setBusy(false);
  }

  return (
    <>
      <PageHeader title="Projects" description="Each monitoring project groups the objectives, languages and (from Milestone 2) the keywords and sources you track."
        actions={can.createProject(org.role) && <button className="btn-primary" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>{showForm ? 'Cancel' : 'New project'}</button>} />
      {showForm && (
        <form onSubmit={create} className="card mb-6 grid gap-4 md:grid-cols-2" aria-label="Create project">
          {formError && <div className="md:col-span-2"><Alert>{formError}</Alert></div>}
          <div><label className="label" htmlFor="name">Name</label><input id="name" name="name" required minLength={2} maxLength={120} className="input" /></div>
          <div><label className="label" htmlFor="languages">Languages (ISO codes, comma-separated)</label><input id="languages" name="languages" placeholder="id, en" className="input" /></div>
          <div className="md:col-span-2"><label className="label" htmlFor="objective">Objective</label><textarea id="objective" name="objective" maxLength={2000} rows={3} className="input" /></div>
          <div><label className="label" htmlFor="start">Monitoring start</label><input id="start" name="start" type="date" className="input" /></div>
          <div><label className="label" htmlFor="end">Monitoring end</label><input id="end" name="end" type="date" className="input" /></div>
          <div className="md:col-span-2"><button className="btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button></div>
        </form>
      )}
      <div role="tablist" aria-label="Project status" className="mb-4 flex gap-2">
        {(['active', 'archived'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
            className={status === s ? 'btn-primary py-1.5' : 'btn-secondary py-1.5'}>{s === 'active' ? 'Active' : 'Archived'}</button>
        ))}
      </div>
      {error && <Alert>{error}</Alert>}
      {!projects && !error && <Loading />}
      {projects && projects.length === 0 && <Empty title={status === 'active' ? 'No active projects' : 'No archived projects'} />}
      {projects && projects.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Languages</th><th className="th">Members</th><th className="th">Collection</th><th className="th">Updated</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map((p) => (
                <tr key={p.id}>
                  <td className="td"><Link href={`/o/${org.id}/projects/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.name}</Link>
                    {p.objective && <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{p.objective}</p>}</td>
                  <td className="td">{p.languages.length ? p.languages.join(', ') : '—'}</td>
                  <td className="td">{p.member_count ?? 0} assigned</td>
                  <td className="td"><Badge tone="amber">No sources (M2)</Badge></td>
                  <td className="td text-xs">{fmtDate(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
