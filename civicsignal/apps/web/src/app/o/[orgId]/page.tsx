'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Empty, Loading, PageHeader, Stat } from '@/components/ui';
import { api, can, canIngest, errorMessage, fmtDate, HEALTH_LABEL, HEALTH_TONE, relTime, type AuditEvent, type Member, type Mention, type Project, type Source, safeHref } from '@/lib/api';
import { useOrg } from '@/components/org-context';

interface Ingest { sources: Source[]; last24h: number; recent: Mention[]; worker: { online: boolean } | null; queueConfigured: boolean }
interface Data { projects: Project[]; archived: number; members: Member[] | null; audit: AuditEvent[] | null; ingest: Ingest | null; loadedAt: string }

function IngestionPanel({ orgId, ingest }: { orgId: string; ingest: Ingest | null }) {
  if (!ingest) return null;
  const { sources, recent } = ingest;
  const failing = sources.filter((x) => x.health === 'failing' || x.health === 'degraded');
  return (
    <div className="space-y-4">
      {!ingest.queueConfigured && <Alert tone="warning">Collection is not configured on this server (no ingestion queue). Data shown here is only what was collected earlier.</Alert>}
      {ingest.queueConfigured && !ingest.worker?.online && sources.some((x) => x.enabled) && <Alert tone="warning">No ingestion worker is running, so enabled sources are not being collected right now.</Alert>}
      {sources.length === 0 && <Alert tone="info">No sources are registered yet. <Link className="underline" href={`/o/${orgId}/sources`}>Register an authorized source</Link> to start collecting coverage. This dashboard never shows simulated figures.</Alert>}
      {failing.length > 0 && <Alert>{failing.length} source{failing.length > 1 ? 's need' : ' needs'} attention: {failing.map((x) => `${x.name} (${HEALTH_LABEL[x.health].toLowerCase()})`).join(', ')}. <Link className="underline" href={`/o/${orgId}/sources`}>View sources</Link></Alert>}
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card lg:col-span-2" aria-labelledby="recent-h">
          <div className="flex items-center justify-between"><h2 id="recent-h" className="font-semibold">Recent coverage</h2><Link href={`/o/${orgId}/mentions`} className="text-sm text-brand-600 underline">All mentions</Link></div>
          {recent.length === 0 ? <p className="mt-3 text-sm text-slate-500">Nothing collected yet{sources.some((x) => x.enabled) ? '; enabled sources will appear here after their first successful run' : ''}.</p> : (
            <ul className="mt-3 divide-y divide-slate-100">
              {recent.map((m) => (
                <li key={m.id} className="py-2 text-sm">
                  <a href={safeHref(m.url)} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-slate-800 hover:underline">{m.title}</a>
                  <p className="text-xs text-slate-500">{m.publisher ?? m.publisher_domain} · discovered {relTime(m.discovered_at)}{m.published_at ? ` · published ${fmtDate(m.published_at)}` : ''}{m.matches.length ? ` · ${m.matches.map((x) => x.projectName).join(', ')}` : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="health-h">
          <h2 id="health-h" className="font-semibold">Collection health</h2>
          {sources.length === 0 ? <p className="mt-3 text-sm text-slate-500">No sources.</p> : (
            <ul className="mt-3 space-y-2 text-sm">
              {sources.slice(0, 8).map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2">
                  <Link href={`/o/${orgId}/sources/${x.id}`} className="truncate hover:underline">{x.name}</Link>
                  <span className="shrink-0 text-right"><Badge tone={HEALTH_TONE[x.health]}>{HEALTH_LABEL[x.health]}</Badge><br /><span className="text-xs text-slate-500">{relTime(x.lastSuccessAt)}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default function Overview() {
  const org = useOrg();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const ingestP: Promise<Ingest | null> = canIngest.readSources(org.role)
          ? Promise.all([
            api<Source[]>(`/organizations/${org.id}/sources`),
            api<{ total: number }>(`/organizations/${org.id}/mentions?limit=1&dateField=discovered&from=${encodeURIComponent(since)}`),
            api<{ items: Mention[] }>(`/organizations/${org.id}/mentions?limit=6&sort=discovered`),
            api<{ worker: { online: boolean }; queueConfigured: boolean }>(`/organizations/${org.id}/ingestion/metrics?hours=24`),
          ]).then(([sources, l24, recent, m]) => ({ sources, last24h: l24.total, recent: recent.items, worker: m.worker, queueConfigured: m.queueConfigured }))
          : Promise.resolve(null);
        const [projects, archived, members, audit, ingest] = await Promise.all([
          api<Project[]>(`/organizations/${org.id}/projects`),
          api<Project[]>(`/organizations/${org.id}/projects?status=archived`),
          can.readMembers(org.role) ? api<Member[]>(`/organizations/${org.id}/members`) : Promise.resolve(null),
          can.readAudit(org.role) ? api<{ items: AuditEvent[] }>(`/organizations/${org.id}/audit-events?limit=8`).then((r) => r.items) : Promise.resolve(null),
          ingestP,
        ]);
        if (live) setData({ projects, archived: archived.length, members, audit, ingest, loadedAt: new Date().toISOString() });
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
          <IngestionPanel orgId={org.id} ingest={data.ingest} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Mentions (24 h)" value={data.ingest ? data.ingest.last24h.toLocaleString() : '—'} note={data.ingest ? 'Originals discovered in the last 24 hours, visible to you' : 'Not visible to your role'} />
            <Stat label="Active projects" value={data.projects.length} note={can.createProject(org.role) ? `${data.archived} archived` : 'Projects assigned to you'} />
            <Stat label="Sources collecting" value={data.ingest ? data.ingest.sources.filter((x) => x.enabled).length : '—'} note={data.ingest ? `${data.ingest.sources.length} registered` : undefined} />
            <Stat label="Team members" value={data.members?.length ?? '—'} note={data.members ? undefined : 'Not visible to your role'} />
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
