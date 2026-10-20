'use client';
import { useState, type ReactNode } from 'react';
import { Alert, Loading } from './ui';

/**
 * Executive dashboard building blocks. Every widget states its title, the metric it shows (definition) and the period,
 * and has explicit loading, empty and error states. Charts have one axis, an accessible label, hover/focus tooltips
 * and a table view so no value is reachable by colour or hover alone. Series colour: blue #2a78d6.
 */
export function Widget({ title, metric, period, loading, error, empty, emptyText = 'No data for this period and filters.', actions, children, className = '' }: {
  title: string; metric: string; period?: string; loading?: boolean; error?: string | null; empty?: boolean; emptyText?: string; actions?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <section className={`card ${className}`} aria-labelledby={`w-${title.replace(/\W+/g, '-')}`}>
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <h2 id={`w-${title.replace(/\W+/g, '-')}`} className="font-semibold text-slate-900">{title}</h2>
        {actions}
      </div>
      <p className="mb-3 text-xs text-slate-500">{metric}{period ? ` · ${period}` : ''}</p>
      {loading ? <Loading /> : error ? <Alert>{error}</Alert> : empty ? <p className="py-6 text-center text-sm text-slate-500">{emptyText}</p> : children}
    </section>
  );
}

export function Kpi({ label, value, detail, definition }: { label: string; value: ReactNode; detail?: ReactNode; definition: string }) {
  return (
    <div className="card" title={definition}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
      {detail && <p className="mt-1 text-xs text-slate-600">{detail}</p>}
      <p className="sr-only">{definition}</p>
    </div>
  );
}

const W = 720; const PAD = { l: 40, r: 12, t: 12, b: 26 };
const niceMax = (v: number) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; };

/** Vertical columns over time (one series). */
export function ColumnChart({ points, label, unit, height = 200, columns }: {
  points: Array<{ key: string; label: string; value: number; extra?: string }>; label: string; unit: string; height?: number; columns: [string, string];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const H = height; const iw = W - PAD.l - PAD.r; const ih = H - PAD.t - PAD.b;
  const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
  const slot = iw / Math.max(1, points.length); const bw = Math.max(2, Math.min(32, slot - 3));
  const cx = (i: number) => PAD.l + (i + 0.5) * slot; const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const every = Math.ceil(points.length / 8);
  const hp = hover !== null ? points[hover] : null;
  return (
    <figure>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${label}; exact values in the table view`} onPointerLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => <g key={f}><line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="#e7e5e4" />
            <text x={PAD.l - 6} y={y(max * f) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">{Math.round(max * f)}</text></g>)}
          {points.map((p, i) => (
            <g key={p.key} tabIndex={0} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${p.label}: ${p.value} ${unit}`}>
              <rect x={cx(i) - slot / 2} y={PAD.t} width={slot} height={ih} fill="transparent" />
              {p.value > 0 && <rect x={cx(i) - bw / 2} y={y(p.value)} width={bw} height={PAD.t + ih - y(p.value)} rx={2} fill="#2a78d6" opacity={hover === null || hover === i ? 1 : 0.55} />}
              {i % every === 0 && <text x={cx(i)} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[11px]">{p.label}</text>}
            </g>
          ))}
        </svg>
        {hp && <div role="status" className="pointer-events-none absolute top-2 z-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md"
          style={{ left: `${(cx(hover!) / W) * 100}%`, transform: cx(hover!) > W * 0.7 ? 'translateX(-105%)' : 'translateX(8px)' }}>
          <p className="font-medium text-slate-900">{hp.label}</p><p><strong>{hp.value.toLocaleString()}</strong> <span className="text-slate-500">{unit}</span></p>
          {hp.extra && <p className="text-slate-500">{hp.extra}</p>}</div>}
      </div>
      <button className="mt-2 text-xs text-brand-700 underline" onClick={() => setTable(!table)} aria-expanded={table}>{table ? 'Hide' : 'Show'} table</button>
      {table && <table className="mt-2 w-full text-left text-xs"><thead><tr><th>{columns[0]}</th><th className="text-right">{columns[1]}</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.key}><td>{p.label}{p.extra ? ` · ${p.extra}` : ''}</td><td className="text-right tabular-nums">{p.value.toLocaleString()}</td></tr>)}</tbody></table>}
    </figure>
  );
}

/** Horizontal bars with the value printed at the bar end (identity by label, not colour). */
export function HBars({ rows, unit = '', max, label, colorFor }: {
  rows: Array<{ key: string; label: ReactNode; value: number; note?: ReactNode; title?: string }>; unit?: string; max?: number; label: string; colorFor?: (key: string) => string;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-3 text-sm" title={r.title}>
          <span className="truncate text-slate-700">{r.label}</span>
          <span className="h-3 rounded bg-slate-100" aria-hidden><span className="block h-3 rounded" style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / top) * 100)}%`, background: colorFor?.(r.key) ?? '#2a78d6' }} /></span>
          <span className="tabular-nums text-slate-900">{r.value.toLocaleString('en-GB', { maximumFractionDigits: 1 })}{unit}{r.note && <span className="ml-2 text-xs text-slate-500">{r.note}</span>}</span>
        </li>
      ))}
    </ul>
  );
}
