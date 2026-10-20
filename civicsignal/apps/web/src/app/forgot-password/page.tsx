'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ message: string }>('/auth/password-reset/request', { method: 'POST', body: { email: new FormData(e.currentTarget).get('email') } });
      setDone(r.message);
    } catch (x) { setError(errorMessage(x)); } finally { setBusy(false); }
  }
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-2xl font-semibold">Reset your password</h1>
        <form onSubmit={submit} className="card space-y-4">
          {error && <Alert>{error}</Alert>}
          {done ? <Alert tone="success">{done}</Alert> : <>
            <div><label htmlFor="email" className="label">Work email</label><input id="email" name="email" type="email" required autoComplete="email" className="input" /></div>
            <button className="btn-primary w-full" disabled={busy}>{busy ? 'Please wait…' : 'Send reset link'}</button>
          </>}
          <p className="text-center text-sm"><Link className="text-brand-600 underline" href="/login">Back to sign in</Link></p>
        </form>
      </div>
    </main>
  );
}
