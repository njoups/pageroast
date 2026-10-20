'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** The token arrives in the URL fragment (never sent to servers or logs); it is removed from the address bar on load. */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setToken(t);
    if (t) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null);
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) { setError('The passwords do not match.'); return; }
    try { await api('/auth/password-reset/confirm', { method: 'POST', body: { token, newPassword: f.get('password') } }); setDone(true); }
    catch (x) { setError(errorMessage(x)); }
  }
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-2xl font-semibold">Choose a new password</h1>
        <div className="card space-y-4">
          {error && <Alert>{error}</Alert>}
          {done ? <Alert tone="success">Your password was changed and every session was signed out. <Link className="underline" href="/login">Sign in</Link>.</Alert>
            : !token ? <Alert>This page needs the link from the reset email.</Alert> : (
              <form onSubmit={submit} className="space-y-4">
                <div><label htmlFor="password" className="label">New password</label><input id="password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className="input" /></div>
                <div><label htmlFor="confirm" className="label">Repeat new password</label><input id="confirm" name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className="input" /></div>
                <button className="btn-primary w-full">Set password</button>
              </form>)}
        </div>
      </div>
    </main>
  );
}
