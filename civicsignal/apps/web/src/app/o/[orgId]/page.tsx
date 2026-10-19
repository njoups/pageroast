'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Empty, Loading, PageHeader, Stat } from '@/components/ui';
import { api, can, errorMessage, fmtDate, type AuditEvent, type Member, type Project } from '@/lib/api';
import { useOrg } from '@/components/org-context';

interface Data { projects: Project[]; archived: number; members: Member[] | null; audit: AuditEvent[] | null; loadedAt: string }

export default function Overview() {
  const org = useOrg();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [projects, archived, members, audit] = await Promise.all([
          api<Project[]>(`/organizations/${org.id}/projects`),
          api<Project[]>(`/organizations/${org.id}/projects?status=archived`),
          can.readMembers(org.role) ? api<Member[]>(`/organizations/${org.id}/members`) : Promise.resolve(null),
          can.readAudit(org.role) ? api<{ items: AuditEvent[] }>(`/organizations/${org.id}/audit-events?limit=8`).then((r) => r.items) : Promise.resolve(null),
        ]);
        if (live) setData({ projects, archived: archived.length, members, audit, loadedAt: new Date().toISOString() });
      } catch (e) { if (live) setError(errorMessage(e)); }
    })();
    return () => { live = false; };
  }, [org.id, org.role]);

  return (
    <>
      <PageHeader title="Overview" description={`Workspace status for ${org.name}.`}
        actions={data && <span className="text-xs text-slate-500">Last updated {fmtDate(data.loadedAt)}</span>} />
      {error && <Alert>{error}</Alert>}
      {!data && !error && <Loading />}
      {data && (
        <div className="space-y-6">
          <Alert tone="warning">
            <strong>No coverage is being collected yet.</strong> News ingestion, sentiment, alerts and analytics arrive in later
            milestones. Mention volume, sentiment, trending topics, top sources and active alerts will appear here only once
            authorized sources are configured — this dashboard never shows simulated figures.
          </Alert>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Active projects" value={data.projects.length} note={can.createProject(org.role) ? undefined : 'Projects assigned to you'} />
            <Stat label="Archived projects" value={data.archived} />
            <Stat label="Team members" value={data.members?.length ?? '—'} note={data.members ? undefined : 'Not visible to your role'} />
            <Stat label="Sources connected" value={0} note="Source registry: Milestone 2" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card" aria-labelledby="proj-h">
              <div className="flex items-center justify-between">
                <h2 id="proj-h" className="font-semibold">Monitoring projects</h2>
                <Link href={`/o/${org.id}/projects`} className="text-sm text-brand-600 underline">View all</Link>
              </div>
              <div className="mt-4">
                {data.projects.length === 0 ? (
                  <Empty title="No projects yet">
                    {can.createProject(org.role) ? <Link className="text-brand-600 underline" href={`/o/${org.id}/projects`}>Create your first monitoring project</Link> : 'Ask a project manager to assign you to a project.'}
                  </Empty>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {data.projects.slice(0, 6).map((p) => (
                      <li key={p.id} className="flex items-center justify-between py-2">
                        <Link className="text-sm font-medium text-slate-800 hover:underline" href={`/o/${org.id}/projects/${p.id}`}>{p.name}</Link>
                        <span className="flex gap-1">{p.languages.map((l) => <Badge key={l}>{l}</Badge>)}<Badge tone="amber">Not collecting</Badge></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
            <section className="card" aria-labelledby="act-h">
              <h2 id="act-h" className="font-semibold">Recent activity</h2>
              <div className="mt-4">
                {data.audit === null ? <p className="text-sm text-slate-500">The activity log is visible to owners and administrators.</p>
                  : data.audit.length === 0 ? <Empty title="No activity recorded" />
                  : (
                    <ul className="space-y-2 text-sm">
                      {data.audit.map((a) => (
                        <li key={a.id} className="flex justify-between gap-3">
                          <span><span className="font-mono text-xs text-brand-700">{a.action}</span> <span className="text-slate-600">by {a.actor_name ?? 'system'}</span></span>
                          <time className="shrink-0 text-xs text-slate-500" dateTime={a.occurred_at}>{fmtDate(a.occurred_at)}</time>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
