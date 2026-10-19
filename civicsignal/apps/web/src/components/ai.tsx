'use client';
import type { ReactNode } from 'react';
import { Badge } from './ui';
import { METHOD_LABEL, METHOD_NOTE, SENTIMENT_LABEL, SENTIMENT_TONE, type Sentiment } from '@/lib/ai';

/** Labels a piece of content by where it came from, so source text, automated output and analyst input never blur together. */
export function Provenance({ kind, children }: { kind: 'source' | 'classification' | 'summary' | 'extractive' | 'analyst' | 'processing'; children?: ReactNode }) {
  const map = {
    source: ['Source content', 'border-slate-300 bg-white text-slate-700'],
    classification: ['Automated classification', 'border-violet-200 bg-violet-50 text-violet-900'],
    summary: ['AI-generated summary', 'border-indigo-200 bg-indigo-50 text-indigo-900'],
    extractive: ['Automated extract', 'border-sky-200 bg-sky-50 text-sky-900'],
    analyst: ['Analyst annotation', 'border-emerald-200 bg-emerald-50 text-emerald-900'],
    processing: ['Processing record', 'border-slate-200 bg-slate-50 text-slate-700'],
  } as const;
  const [label, cls] = map[kind];
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>{label}{children}</span>;
}

export function MethodBadge({ method, model }: { method: string | null | undefined; model?: string | null }) {
  if (!method) return null;
  const tone = method === 'llm' ? 'blue' : method === 'test' ? 'red' : 'slate';
  return <span title={METHOD_NOTE[method] ?? ''}><Badge tone={tone}>{METHOD_LABEL[method] ?? method}{model && method === 'llm' ? ` · ${model}` : ''}</Badge></span>;
}

export function SentimentBadge({ label, uncertain }: { label: Sentiment | null | undefined; uncertain?: boolean }) {
  if (!label) return null;
  return <Badge tone={uncertain ? 'slate' : SENTIMENT_TONE[label]}>{SENTIMENT_LABEL[label]}{uncertain ? ' (uncertain)' : ''}</Badge>;
}

/** Horizontal bars with the value printed next to every bar; screen readers get a plain list. */
export function BarList({ rows, max, unit = '', empty = 'No data' }: {
  rows: Array<{ key: string; label: ReactNode; value: number; color?: string; note?: ReactNode; href?: string }>; max?: number; unit?: string; empty?: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(8rem,14rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-slate-700" title={typeof r.label === 'string' ? r.label : undefined}>{r.href ? <a className="text-brand-700 hover:underline" href={r.href}>{r.label}</a> : r.label}</span>
          <span className="h-3 rounded bg-slate-100" aria-hidden>
            <span className={`block h-3 rounded ${r.color ?? 'bg-brand-500'}`} style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }} />
          </span>
          <span className="tabular-nums text-slate-900">{r.value.toLocaleString()}{unit}{r.note && <span className="ml-2 text-xs text-slate-500">{r.note}</span>}</span>
        </li>
      ))}
    </ul>
  );
}
