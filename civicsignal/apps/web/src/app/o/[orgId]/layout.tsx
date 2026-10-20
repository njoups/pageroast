'use client';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NAV } from '@/components/nav';
import { OrgContext } from '@/components/org-context';
import { SessionProvider, useSession } from '@/components/session';
import { Alert } from '@/components/ui';
import { api, ROLE_LABEL } from '@/lib/api';


/** Unread in-app notification count, refreshed every minute. */
function NotificationBell({ orgId }: { orgId: string }) {
  const [n, setN] = useState<number | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    let alive = true;
    const load = () => api<{ unread: number }>(`/organizations/${orgId}/notifications?unread=true&limit=1`).then((r) => alive && setN(r.unread)).catch(() => undefined);
    void load(); const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [orgId, pathname]);
  return (
    <Link href={`/o/${orgId}/notifications`} className="relative rounded px-2 py-1 text-slate-700 hover:bg-slate-100" aria-label={`Notifications${n ? `, ${n} unread` : ''}`}>
      <span aria-hidden>🔔</span>{n ? <span className="absolute -right-1 -top-1 rounded-full bg-[#d03b3b] px-1.5 text-[10px] font-semibold text-white">{n > 99 ? '99+' : n}</span> : null}
    </Link>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const { orgId } = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const org = me.organizations.find((o) => o.id === orgId);

  if (!org) {
    return <div className="mx-auto max-w-lg p-10"><Alert>Organization not found, or you are no longer a member. <Link className="underline" href="/">Go to my workspace</Link></Alert></div>;
  }

  const base = `/o/${org.id}`;
  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  return (
    <OrgContext.Provider value={org}>
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 flex-col bg-brand-900 text-brand-50 md:flex">
          <div className="px-5 py-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-100">CivicSignal</p>
            <p className="mt-1 truncate font-semibold" title={org.name}>{org.name}</p>
            <p className="text-xs text-brand-100">{ROLE_LABEL[org.role]}</p>
          </div>
          <nav aria-label="Main" className="flex-1 space-y-0.5 px-3">
            {NAV.map((n) => {
              const href = n.slug ? `${base}/${n.slug}` : base;
              const active = n.slug ? pathname.startsWith(href) : pathname === base;
              return (
                <Link key={n.label} href={href} aria-current={active ? 'page' : undefined}
                  className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${active ? 'bg-white/15 font-medium text-white' : 'text-brand-100 hover:bg-white/10'}`}>
                  {n.label}
                  {!n.available && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-brand-100">Soon</span>}
                </Link>
              );
            })}
          </nav>
          {me.user.isPlatformAdmin && <Link href="/platform" className="mx-3 mb-2 rounded-md px-3 py-2 text-sm text-brand-100 hover:bg-white/10">Platform console</Link>}
          <p className="px-5 py-4 text-[11px] leading-snug text-brand-100">Identity: {me.identityProvider.name} adapter · MFA {me.identityProvider.mfa ? 'on' : 'not available'}</p>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">Switch organization</span>
              <select className="input w-auto py-1.5" value={org.id} onChange={(e) => router.push(e.target.value === '__new' ? '/onboarding' : `/o/${e.target.value}`)}>
                {me.organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                <option value="__new">+ Create or join organization…</option>
              </select>
            </label>
            <div className="flex items-center gap-3 text-sm">
              <NotificationBell orgId={org.id} />
              <span className="hidden text-slate-600 sm:inline">{me.user.displayName}</span>
              <button className="btn-secondary py-1.5" onClick={logout}>Sign out</button>
            </div>
          </header>
          <nav aria-label="Main (mobile)" className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2 md:hidden">
            {NAV.filter((n) => n.available).map((n) => (
              <Link key={n.label} href={n.slug ? `${base}/${n.slug}` : base} className="whitespace-nowrap rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-100">{n.label}</Link>
            ))}
          </nav>
          <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        </div>
      </div>
    </OrgContext.Provider>
  );
}

export default function OrgLayout({ children }: { children: ReactNode }) {
  return <SessionProvider><Shell>{children}</Shell></SessionProvider>;
}
