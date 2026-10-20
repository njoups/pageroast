import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'CivicSignal Intelligence',
  description: 'Media monitoring and public issue intelligence',
};

/** Rendered per request so Next.js can attach the CSP nonce from src/proxy.ts to its scripts (no static prerender). */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">{children}</body>
    </html>
  );
}
