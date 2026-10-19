'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Empty, Loading, PageHeader } from '@/components/ui';
import { api, canIngest, errorMessage, fmtDate, type Project } from '@/lib/api';

interface Row { id: string; label: string; member_count: number; independent_count: number; publisher_count: number; visible_members: number; confidence: string; first_seen_at: string; last_seen_at: string }

export default function StoriesPage() {
  const org = useOrg();
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Project[]>(`/organizations/${org.id}/projects`).then(setProjects).catch(() => undefined); }, [org.id]);
  useEffect(() => {
    setRows(null); setError(null);
    api<{ clusters: Row[] }>(`/organizations/${org.id}/clusters?limit=100${projectId ? `&projectId=${projectId}` : ''}`).then((r) => setRows(r.clusters)).catch((e) => setError(errorMessage(e)));
  }, [org.id, projectId]);
  if (!canIngest.readMentions(org.role)) return <><PageHeader title="Stories" /><Alert tone="info">Your role includes reports only.</Alert></>;
  return (
    <>
      <PageHeader title="Stories" description="Records grouped automatically when they appear to cover the same event (similar headlines, shared entities, close in time). Grouping is an estimate: open a story to see why each record was included." />
      <div className="mb-4 max-w-xs"><label className="label" htmlFor="p">Project</label>
        <select id="p" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">All visible</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      {error && <Alert>{error}</Alert>}
      {!rows && !error && <Loading />}
      {rows && rows.length === 0 && <Empty title="No stories yet">Stories appear once two or more analysed records cover the same event.</Empty>}
      {rows && rows.length > 0 && (
        <ul className="space-y-3">{rows.map((c) => (
          <li key={c.id} className="card p-4">
            <Link className="font-medium text-brand-700 hover:underline" href={`/o/${org.id}/stories/${c.id}`}>{c.label}</Link>
            <p className="mt-1 text-xs text-slate-600">{c.member_count} records · {c.publisher_count} publisher{c.publisher_count === 1 ? '' : 's'} · {c.independent_count} independent (distinct publishers, syndicated copies excluded)
              {c.visible_members < c.member_count && ` · ${c.visible_members} visible to you`} · {fmtDate(c.first_seen_at)} – {fmtDate(c.last_seen_at)}</p>
          </li>
        ))}</ul>
      )}
    </>
  );
}
