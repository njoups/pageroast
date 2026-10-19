'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { SessionProvider, useSession } from '@/components/session';
import { Alert } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

function Onboarding() {
  const { me } = useSession();
  const router = useRouter();
  const tokenFromLink = useSearchParams().get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createOrg(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = new FormData(e.currentTarget).get('name');
    setBusy(true); setError(null);
    try {
      const org = await api<{ id: string }>('/organizations', { method: 'POST', body: { name } });
      router.replace(`/o/${org.id}`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  async function accept(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = String(new FormData(e.currentTarget).get('token') ?? '').trim();
    setBusy(true); setError(null);
    try {
      const r = await api<{ organizationId: string }>('/invitations/accept', { method: 'POST', body: { token } });
      router.replace(`/o/${r.organizationId}`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">CivicSignal Intelligence</p>
      <h1 className="mt-2 text-2xl font-semibold">Welcome, {me.user.displayName}</h1>
      <p className="mt-1 text-sm text-slate-600">Create an organization workspace, or join one you were invited to.</p>
      {error && <div className="mt-6"><Alert>{error}</Alert></div>}
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <form onSubmit={createOrg} className="card space-y-4">
          <h2 className="font-semibold">Create an organization</h2>
          <div>
            <label htmlFor="name" className="label">Organization name</label>
            <input id="name" name="name" required minLength={2} maxLength={120} className="input" placeholder="e.g. Biro Humas Kementerian" />
          </div>
          <p className="text-xs text-slate-500">You will become the organization owner.</p>
          <button className="btn-primary" disabled={busy}>Create organization</button>
        </form>
        <form onSubmit={accept} className="card space-y-4">
          <h2 className="font-semibold">Join with an invitation</h2>
          <div>
            <label htmlFor="token" className="label">Invitation code</label>
            <input id="token" name="token" required defaultValue={tokenFromLink} className="input font-mono text-xs" />
          </div>
          <p className="text-xs text-slate-500">The invitation must have been sent to {me.user.email}.</p>
          <button className="btn-secondary" disabled={busy}>Join organization</button>
        </form>
      </div>
      {me.organizations.length > 0 && (
        <p className="mt-6 text-sm"><Link href="/" className="text-brand-600 underline">Back to my workspace</Link></p>
      )}
    </main>
  );
}

export default function OnboardingPage() {
  return <SessionProvider><Suspense><Onboarding /></Suspense></SessionProvider>;
}
