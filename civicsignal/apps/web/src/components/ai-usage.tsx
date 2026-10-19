'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MethodBadge } from './ai';
import { Alert, Loading } from './ui';
import { STATUS_LABEL } from '@/lib/ai';
import { api, errorMessage, fmtDate } from '@/lib/api';

interface Usage {
  provider: { name: string; model: string; method: string };
  byDay: Array<{ day: string; provider: string; model: string; tokens_in: string; tokens_out: string; tokens_cache_read: string; cost_estimate: string | null;
    unpriced_calls: number; currency: string | null; pricing_updated_at: string | null; calls: number }>;
  analyses: Array<{ status: string; method: string | null; n: number }>;
  settings: { auto_analyze: boolean; daily_mention_limit: number; monthly_token_limit: string | number; updated_at: string | null };
  consumption: { tokensThisMonth: number; analysesToday: number };
  notice: string;
}

export function AiUsagePanel({ orgId }: { orgId: string }) {
  const [u, setU] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<Usage>(`/organizations/${orgId}/ai/usage?days=30`).then(setU).catch((e) => setError(errorMessage(e))), [orgId]);
  useEffect(() => { void load(); }, [load]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null);
    const f = new FormData(e.currentTarget);
    try {
      await api(`/organizations/${orgId}/ai/settings`, { method: 'PUT', body: { autoAnalyze: f.get('auto') === 'on',
        dailyMentionLimit: Number(f.get('daily')), monthlyTokenLimit: Number(f.get('monthly')) } });
      setNotice('AI settings saved.'); await load();
    } catch (x) { setError(errorMessage(x)); }
  }

  if (!u) return <section className="card lg:col-span-3">{error ? <Alert>{error}</Alert> : <Loading />}</section>;
  const tokens = u.byDay.reduce((n, d) => n + Number(d.tokens_in) + Number(d.tokens_out), 0);
  const priced = u.byDay.filter((d) => d.cost_estimate !== null);
  const cost = priced.reduce((n, d) => n + Number(d.cost_estimate), 0);
  const unpriced = u.byDay.reduce((n, d) => n + d.unpriced_calls, 0);
  const currency = priced.find((d) => d.currency)?.currency ?? '';
  const monthly = Number(u.settings.monthly_token_limit);

  return (
    <section className="card lg:col-span-3" aria-labelledby="ai-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-h" className="font-semibold">AI analysis: usage and limits</h2>
        <span className="text-sm">Active method: <MethodBadge method={u.provider.method} model={u.provider.model} /></span>
      </div>
      {u.provider.method === 'baseline' && <p className="mt-2 text-xs text-amber-800">No AI model is configured on this server, so records are analysed by the rule-based baseline (no token cost). An operator can configure a provider; see docs/AI_PROVIDERS.md.</p>}
      <div className="mt-3 space-y-2">{error && <Alert>{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}</div>
      <div className="mt-4 grid gap-6 md:grid-cols-3">
        <div className="text-sm">
          <h3 className="text-xs font-semibold uppercase text-slate-500">This month</h3>
          <p className="mt-1">{u.consumption.tokensThisMonth.toLocaleString()} of {monthly.toLocaleString()} tokens</p>
          <div className="mt-1 h-2 rounded bg-slate-100" aria-hidden><div className="h-2 rounded bg-brand-500" style={{ width: `${Math.min(100, (u.consumption.tokensThisMonth / Math.max(1, monthly)) * 100)}%` }} /></div>
          <p className="mt-2">{u.consumption.analysesToday} of {u.settings.daily_mention_limit} analyses today</p>
        </div>
        <div className="text-sm">
          <h3 className="text-xs font-semibold uppercase text-slate-500">Last 30 days</h3>
          <p className="mt-1">{tokens.toLocaleString()} tokens across {u.byDay.reduce((n, d) => n + d.calls, 0)} AI calls</p>
          <p className="mt-1">Estimated cost: {priced.length ? `${cost.toFixed(4)} ${currency}` : 'not available'}{unpriced > 0 && <span className="text-xs text-slate-500"> ({unpriced} call(s) without a configured price)</span>}</p>
          <p className="mt-1 text-xs text-slate-500">{u.notice}</p>
          <p className="mt-2 text-xs text-slate-600">Analyses: {u.analyses.map((a) => `${STATUS_LABEL[a.status] ?? a.status}${a.method ? ` (${a.method})` : ''} ${a.n}`).join(' · ') || 'none'}</p>
        </div>
        <form onSubmit={save} className="space-y-2 text-sm" aria-label="AI settings">
          <label className="flex items-center gap-2"><input type="checkbox" name="auto" defaultChecked={u.settings.auto_analyze} />Analyse new records automatically</label>
          <div><label className="label" htmlFor="daily">Daily analysis limit</label><input id="daily" name="daily" type="number" min={1} max={100000} defaultValue={u.settings.daily_mention_limit} className="input" /></div>
          <div><label className="label" htmlFor="monthly">Monthly token limit</label><input id="monthly" name="monthly" type="number" min={1000} defaultValue={monthly} className="input" /></div>
          <button className="btn-secondary">Save</button>
          {u.settings.updated_at && <p className="text-xs text-slate-500">Updated {fmtDate(u.settings.updated_at)}</p>}
        </form>
      </div>
      {u.byDay.length > 0 && (
        <details className="mt-4 text-xs"><summary className="cursor-pointer text-slate-600">Daily breakdown</summary>
          <table className="mt-2 w-full text-left">
            <thead><tr><th>Day</th><th>Provider / model</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th><th>Cache read</th><th>Est. cost</th><th>Price as of</th></tr></thead>
            <tbody>{u.byDay.map((d) => (
              <tr key={`${d.day}${d.provider}${d.model}`}><td>{d.day}</td><td>{d.provider} / {d.model}</td><td>{d.calls}</td><td>{Number(d.tokens_in).toLocaleString()}</td>
                <td>{Number(d.tokens_out).toLocaleString()}</td><td>{Number(d.tokens_cache_read).toLocaleString()}</td>
                <td>{d.cost_estimate === null ? '—' : `${Number(d.cost_estimate).toFixed(4)} ${d.currency}`}</td><td>{d.pricing_updated_at ? fmtDate(d.pricing_updated_at) : '—'}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
    </section>
  );
}
