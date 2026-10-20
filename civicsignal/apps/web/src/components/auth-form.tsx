'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, errorMessage, safeNextPath } from '@/lib/api';
import { Alert } from './ui';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await api(`/auth/${mode}`, { method: 'POST', body: {
        email: f.get('email'), password: f.get('password'),
        ...(mode === 'register' ? { displayName: f.get('displayName') } : {}),
      } });
      router.replace(safeNextPath(next, window.location.origin));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const register = mode === 'register';
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">CivicSignal Intelligence</p>
          <h1 className="mt-2 text-2xl font-semibold">{register ? 'Create your account' : 'Sign in'}</h1>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4" noValidate={false}>
          {error && <Alert>{error}</Alert>}
          {register && (
            <div>
              <label htmlFor="displayName" className="label">Full name</label>
              <input id="displayName" name="displayName" required maxLength={120} autoComplete="name" className="input" />
            </div>
          )}
          <div>
            <label htmlFor="email" className="label">Work email</label>
            <input id="email" name="email" type="email" required autoComplete="email" className="input" />
          </div>
          <div>
            <label htmlFor="password" className="label">Password</label>
            <input id="password" name="password" type="password" required minLength={register ? 12 : 1} maxLength={128}
              autoComplete={register ? 'new-password' : 'current-password'} className="input" aria-describedby={register ? 'pw-help' : undefined} />
            {register && <p id="pw-help" className="mt-1 text-xs text-slate-500">At least 12 characters. A passphrase works well.</p>}
          </div>
          <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
          <p className="text-center text-sm text-slate-600">
            {register ? <>Already have an account? <Link className="text-brand-600 underline" href="/login">Sign in</Link></>
              : <>New to CivicSignal? <Link className="text-brand-600 underline" href="/register">Create an account</Link></>}
          </p>
          {!register && (
            <p className="text-center text-xs text-slate-500">
              <Link className="text-brand-600 underline" href="/forgot-password">Forgot your password?</Link> MFA requires a managed identity provider,
              which is not configured for this deployment.
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
