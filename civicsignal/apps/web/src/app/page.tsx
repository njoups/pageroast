'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { SessionProvider, useSession } from '@/components/session';
import { Loading } from '@/components/ui';

function Redirect() {
  const { me } = useSession();
  const router = useRouter();
  useEffect(() => {
    const first = me.organizations[0];
    router.replace(first ? `/o/${first.id}` : '/onboarding');
  }, [me, router]);
  return <div className="p-10"><Loading label="Opening your workspace…" /></div>;
}

export default function Home() {
  return <SessionProvider><Redirect /></SessionProvider>;
}
