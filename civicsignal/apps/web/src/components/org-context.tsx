'use client';
import { createContext, useContext } from 'react';
import type { Org } from '@/lib/api';

export const OrgContext = createContext<Org | null>(null);

export function useOrg(): Org {
  const o = useContext(OrgContext);
  if (!o) throw new Error('useOrg outside org layout');
  return o;
}
