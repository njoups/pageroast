'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, errorMessage, type MonitoringQuery, type Project } from '@/lib/api';

/** Overview of all monitoring queries across the projects the user can see. Editing happens on each project page. */
export default function MonitoringPage() {
  const org = useOrg();
  const [rows, setRows] = useState<Array<{ project: Project; queries: MonitoringQuery[] }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const projects = await api<Project[]>(`/organizations/${org.id}/projects`);
        setRows(await Promise.all(projects.map(async (p) => ({ project: p, queries: await api<MonitoringQuery[]>(`/organizations/${org.id}/projects/${p.id}/queries`) }))));
      } catch (e) { setError(errorMessage(e)); }
    })();
  }, [org.id]);

  return (
    <>
      <PageHeader title="Monitoring" description="Keyword, alias and Boolean queries per project. Collected records are matched as they arrive." />
      {error && <Alert>{error}</Alert>}
      {!rows && !error && <Loading />}
      {rows?.length === 0 && <Empty title="No active projects">Create a project, then add monitoring queries to it.</Empty>}
      <div className="space-y-4">
        {rows?.map(({ project, queries }) => (
          <section key={project.id} className="card">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold"><Link className="text-brand-700 hover:underline" href={`/o/${org.id}/projects/${project.id}`}>{project.name}</Link></h2>
              <Link className="text-sm text-brand-600 underline" href={`/o/${org.id}/projects/${project.id}`}>Edit queries</Link>
            </div>
            {queries.length === 0 ? <p className="mt-2 text-sm text-amber-800">No queries: nothing will be matched to this project.</p> : (
              <ul className="mt-2 space-y-1 text-sm">
                {queries.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{q.name}</span>{!q.is_active && <Badge>inactive</Badge>}<Badge tone="blue">{q.match_count} matches</Badge>
                    <span className="truncate text-xs text-slate-500">{[...q.keywords, ...q.aliases].join(', ')}{q.boolean_expression ? ` · ${q.boolean_expression}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
