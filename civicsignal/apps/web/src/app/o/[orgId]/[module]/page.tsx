'use client';
import { notFound, useParams } from 'next/navigation';
import { NAV } from '@/components/nav';
import { Badge, PageHeader } from '@/components/ui';

export default function UnavailableModule() {
  const { module } = useParams<{ module: string }>();
  const item = NAV.find((n) => n.slug === module && !n.available);
  if (!item) notFound();
  return (
    <>
      <PageHeader title={item.label} description={item.summary} />
      <div className="card max-w-2xl">
        <div className="flex items-center gap-2"><Badge tone="amber">Not yet available</Badge><Badge>{item.milestone}</Badge></div>
        <p className="mt-4 text-sm text-slate-700">
          This module is not implemented in the current release. Nothing on this page is simulated: it will show
          real data once the module ships in {item.milestone} and, where applicable, once an authorized data source has been configured and verified.
        </p>
      </div>
    </>
  );
}
