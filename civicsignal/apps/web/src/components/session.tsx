'use client';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from '@/lib/api';
import { Alert, Loading } from './ui';

interface SessionValue { me: Me; refresh: () => Promise<void> }
const SessionContext = createContext<SessionValue | null>(null);

/** Loads /auth/me; redirects to /login on 401. Children render only with a confirmed session. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setError('Could not reach the CivicSignal API. Check that it is running and try again.');
    }
  }, [router]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <div className="mx-auto max-w-lg p-10"><Alert>{error}</Alert></div>;
  if (!me) return <div className="mx-auto max-w-lg p-10"><Loading label="Checking your session…" /></div>;
  return <SessionContext.Provider value={{ me, refresh }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
