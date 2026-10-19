'use client';
import { useState, type ReactNode } from 'react';

/**
 * Hand-built SVG charts following the data-viz method: one y-axis, thin marks, recessive grid, hover tooltips that are
 * never the only way to a value (each chart has a table view), identity never by colour alone.
 * Palette: series blue #2a78d6, reference gray #8a8984, diverging poles blue #2a78d6 / red #e34948 (validated).
 */
const W = 720; const PAD = { l: 40, r: 12, t: 12, b: 26 };

function niceMax(v: number) { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; }
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div role="status" className="pointer-events-none absolute z-10 min-w-36 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md"
      style={{ left: `${(x / W) * 100}%`, top: y, transform: x > W * 0.7 ? 'translateX(-105%)' : 'translateX(8px)' }}>{children}</div>
  );
}

export interface VolumePoint { day: string; mentions: number | null; covered: boolean; detections: number; publishers: number | null }

/** Daily records with a trailing-median reference line; uncovered days are gaps (hatched), not zeros. */
export function VolumeChart({ points, height = 220 }: { points: VolumePoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const H = height; const iw = W - PAD.l - PAD.r; const ih = H - PAD.t - PAD.b;
  const med = points.map((_, i) => {
    const prev = points.slice(Math.max(0, i - 7), i).filter((p) => p.covered && p.mentions !== null).map((p) => p.mentions!);
    if (prev.length < 3) return null;
    const s = [...prev].sort((a, b) => a - b); const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  });
  const max = niceMax(Math.max(1, ...points.map((p) => p.mentions ?? 0), ...med.map((m) => m ?? 0)));
  const x = (i: number) => PAD.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const path = (vals: Array<number | null>) => vals.reduce((acc, v, i) => (v === null ? acc : acc + `${acc === '' || vals[i - 1] === null || vals[i - 1] === undefined ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`), '');
  const step = points.length > 1 ? iw / (points.length - 1) : iw;
  const hp = hover !== null ? points[hover] : null;
  if (points.length === 0) return <p className="text-sm text-slate-500">No aggregated activity in this range yet.</p>;
  return (
    <figure>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-slate-600" aria-hidden>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-[#2a78d6]" />Records per day</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed border-[#8a8984]" />Median of previous 7 covered days</span>
        <span className="flex items-center gap-1.5"><span className="text-[#d03b3b]">▲</span>Issue detected</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 bg-[repeating-linear-gradient(45deg,#cbd5e1_0,#cbd5e1_1px,transparent_1px,transparent_4px)]" />No collection (gap)</span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Daily records with baseline; exact values in the table view"
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(points.length - 1, Math.round((px - PAD.l) / step)))); }}>
          <defs><pattern id="gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#cbd5e1" strokeWidth="1.5" /></pattern></defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}><line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="#e7e5e4" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(max * f) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">{Math.round(max * f)}</text></g>
          ))}
          {points.map((p, i) => !p.covered && <rect key={`g${p.day}`} x={x(i) - step / 2} y={PAD.t} width={Math.max(step, 4)} height={ih} fill="url(#gap)" />)}
          <path d={path(med)} fill="none" stroke="#8a8984" strokeWidth={1.5} strokeDasharray="4 4" />
          <path d={path(points.map((p) => (p.covered ? p.mentions ?? 0 : null)))} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" />
          {points.map((p, i) => p.detections > 0 && <text key={`d${p.day}`} x={x(i)} y={PAD.t + 10} textAnchor="middle" className="fill-[#d03b3b] text-[11px]">▲</text>)}
          {[0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
            <text key={`x${i}`} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="fill-slate-500 text-[11px]">{fmtDay(points[i]!.day)}</text>
          ))}
          {hp && <><line x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={PAD.t + ih} stroke="#94a3b8" strokeWidth={1} />
            {hp.covered && <circle cx={x(hover!)} cy={y(hp.mentions ?? 0)} r={4} fill="#2a78d6" stroke="#fff" strokeWidth={2} />}</>}
        </svg>
        {hp && <Tooltip x={x(hover!)} y={8}>
          <p className="font-medium text-slate-900">{fmtDay(hp.day)}</p>
          {hp.covered ? <>
            <p><strong className="text-slate-900">{hp.mentions ?? 0}</strong> <span className="text-slate-500">records</span></p>
            <p><strong className="text-slate-900">{med[hover!] ?? '—'}</strong> <span className="text-slate-500">baseline median</span></p>
            {hp.publishers !== null && <p><strong className="text-slate-900">{hp.publishers}</strong> <span className="text-slate-500">publishers (max in an hour)</span></p>}
            {hp.detections > 0 && <p className="text-[#a32424]">▲ {hp.detections} issue{hp.detections === 1 ? '' : 's'} detected</p>}
          </> : <p className="text-slate-600">No successful collection: coverage unknown</p>}
        </Tooltip>}
      </div>
      <button className="mt-2 text-xs text-brand-700 underline" onClick={() => setTable(!table)} aria-expanded={table}>{table ? 'Hide' : 'Show'} table</button>
      {table && <table className="mt-2 w-full text-left text-xs"><thead><tr><th>Day (UTC)</th><th>Records</th><th>Baseline median</th><th>Detections</th><th>Collection</th></tr></thead>
        <tbody>{points.map((p, i) => <tr key={p.day}><td>{p.day}</td><td>{p.covered ? p.mentions ?? 0 : '—'}</td><td>{med[i] ?? '—'}</td><td>{p.detections}</td><td>{p.covered ? 'ok' : 'gap'}</td></tr>)}</tbody></table>}
    </figure>
  );
}

export interface TonePoint { day: string; positive: number; negative: number; neutral: number; mixed: number; uncertain: number }

/** Diverging daily bars: positive share up (blue), negative share down (red), of confident classifications only. */
export function ToneChart({ points, minSample = 5, height = 200 }: { points: TonePoint[]; minSample?: number; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const H = height; const iw = W - PAD.l - PAD.r; const ih = H - PAD.t - PAD.b; const mid = PAD.t + ih / 2;
  if (points.length === 0) return <p className="text-sm text-slate-500">No analysed records in this range.</p>;
  const bw = Math.max(3, Math.min(28, iw / points.length - 2));
  const cx = (i: number) => PAD.l + (i + 0.5) * (iw / points.length);
  const conf = (p: TonePoint) => p.positive + p.negative + p.neutral + p.mixed;
  const hp = hover !== null ? points[hover] : null;
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  return (
    <figure>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-slate-600" aria-hidden>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-[#2a78d6]" />Positive share (up)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-[#e34948]" />Negative share (down)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm border border-dashed border-slate-400" />Fewer than {minSample} confident classifications</span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Daily share of positive and negative records among confident classifications; values in the table view" onPointerLeave={() => setHover(null)}>
          {[1, 0.5, 0, -0.5, -1].map((f) => <g key={f}><line x1={PAD.l} x2={W - PAD.r} y1={mid - f * ih / 2} y2={mid - f * ih / 2} stroke={f === 0 ? '#a8a29e' : '#f1f0ee'} strokeWidth={1} />
            <text x={PAD.l - 6} y={mid - f * ih / 2 + 4} textAnchor="end" className="fill-slate-500 text-[11px]">{Math.abs(f * 100)}%</text></g>)}
          {points.map((p, i) => {
            const n = conf(p); const low = n < minSample;
            const up = n ? (p.positive / n) * ih / 2 : 0; const down = n ? (p.negative / n) * ih / 2 : 0;
            return (
              <g key={p.day} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${p.day}: ${pct(p.positive, n)} positive, ${pct(p.negative, n)} negative of ${n} confident`}>
                <rect x={cx(i) - (iw / points.length) / 2} y={PAD.t} width={iw / points.length} height={ih} fill="transparent" />
                {low ? <rect x={cx(i) - bw / 2} y={mid - 10} width={bw} height={20} fill="none" stroke="#94a3b8" strokeDasharray="2 2" rx={2} />
                  : <>{up > 0 && <rect x={cx(i) - bw / 2} y={mid - up - 1} width={bw} height={up} rx={2} fill="#2a78d6" opacity={hover === i ? 0.8 : 1} />}
                    {down > 0 && <rect x={cx(i) - bw / 2} y={mid + 1} width={bw} height={down} rx={2} fill="#e34948" opacity={hover === i ? 0.8 : 1} />}</>}
              </g>
            );
          })}
          {[0, points.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => <text key={i} x={cx(i)} y={H - 6} textAnchor={i === 0 ? 'start' : 'end'} className="fill-slate-500 text-[11px]">{fmtDay(points[i]!.day)}</text>)}
        </svg>
        {hp && <Tooltip x={cx(hover!)} y={8}>
          <p className="font-medium text-slate-900">{fmtDay(hp.day)}</p>
          <p><strong className="text-slate-900">{pct(hp.positive, conf(hp))}</strong> <span className="text-slate-500">positive</span></p>
          <p><strong className="text-slate-900">{pct(hp.negative, conf(hp))}</strong> <span className="text-slate-500">negative</span></p>
          <p className="text-slate-500">{conf(hp)} confident · {hp.uncertain} uncertain (excluded)</p>
        </Tooltip>}
      </div>
      <button className="mt-2 text-xs text-brand-700 underline" onClick={() => setTable(!table)} aria-expanded={table}>{table ? 'Hide' : 'Show'} table</button>
      {table && <table className="mt-2 w-full text-left text-xs"><thead><tr><th>Day</th><th>Positive</th><th>Negative</th><th>Neutral</th><th>Mixed</th><th>Uncertain (excluded)</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.day}><td>{p.day}</td><td>{p.positive}</td><td>{p.negative}</td><td>{p.neutral}</td><td>{p.mixed}</td><td>{p.uncertain}</td></tr>)}</tbody></table>}
    </figure>
  );
}
