'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, errorMessage, fmtDate } from '@/lib/api';
import { accessText, canBilling, fmtNum, limitText, money, priceText, STATUS_LABEL, usageLevel, type BillingOverview, type Invoice, type PlanInfo } from '@/lib/billing';

const BAR = { ok: 'bg-brand-600', warn: 'bg-amber-500', high: 'bg-orange-600', over: 'bg-red-600' };
const INVOICE_TONE: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = { paid: 'green', issued: 'blue', partially_paid: 'amber', overdue: 'red', void: 'slate', canceled: 'slate' };

export default function BillingPage() {
  const org = useOrg();
  const [data, setData] = useState<BillingOverview | null>(null);
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [history, setHistory] = useState<Array<{ start: string; end: string; usage: Record<string, number> }> | null>(null);
  const [open, setOpen] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sales, setSales] = useState<string | null>(null);
  const returned = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('checkout') === 'returned';

  const load = useCallback(async () => {
    try {
      const [o, p, i, h] = await Promise.all([
        api<BillingOverview>(`/organizations/${org.id}/billing`), api<{ plans: PlanInfo[] }>(`/organizations/${org.id}/billing/plans`),
        api<{ invoices: Invoice[] }>(`/organizations/${org.id}/billing/invoices`), api<{ periods: Array<{ start: string; end: string; usage: Record<string, number> }> }>(`/organizations/${org.id}/billing/usage/history?periods=6`),
      ]);
      setData(o); setPlans(p.plans); setInvoices(i.invoices); setHistory(h.periods);
    } catch (e) { setError(errorMessage(e)); }
  }, [org.id]);
  useEffect(() => { if (canBilling.read(org.role)) void load(); }, [load, org.role]);

  if (!canBilling.read(org.role)) return <><PageHeader title="Billing & usage" /><Alert tone="info">Billing is available to owners and administrators.</Alert></>;
  if (error && !data) return <><PageHeader title="Billing & usage" /><Alert>{error}</Alert></>;
  if (!data) return <><PageHeader title="Billing & usage" /><Loading /></>;

  const s = data.subscription; const st = STATUS_LABEL[s?.status ?? 'none'];
  const manage = canBilling.manage(org.role);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const checkout = (code: string) => act(async () => {
    const r = await api<{ url: string }>(`/organizations/${org.id}/billing/checkout`, { method: 'POST', body: { planCode: code } });
    window.location.assign(r.url);
  }, 'Redirecting to the payment provider…');
  const portal = () => act(async () => { const r = await api<{ url: string }>(`/organizations/${org.id}/billing/portal`, { method: 'POST' }); window.location.assign(r.url); }, 'Opening the billing portal…');
  const sendSales = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    void act(() => api(`/organizations/${org.id}/billing/sales-requests`, { method: 'POST', body: { kind: f.get('kind'), planCode: f.get('planCode') || undefined, message: f.get('message'), contactPhone: f.get('phone') || undefined } }),
      'Request sent. Our team will contact you.').then(() => setSales(null));
  };
  const showInvoice = async (id: string) => { try { setOpen(await api<Invoice>(`/organizations/${org.id}/billing/invoices/${id}`)); } catch (e) { setError(errorMessage(e)); } };
  const warnings = data.usage.filter((u) => (u.percentUsed ?? 0) >= 85);

  return (
    <>
      <PageHeader title="Billing & usage" description={`Plan, subscription status and usage for the current period (${fmtDate(data.usagePeriod.start)} – ${fmtDate(data.usagePeriod.end)}, ${data.usagePeriod.timezone}).`}
        actions={<button className="btn-secondary" onClick={() => setSales('quote')}>Contact sales</button>} />
      <div className="mb-4 space-y-3">
        {returned && <Alert tone="info">You returned from the payment page. Your plan changes only after the payment provider confirms the payment; this page updates when it does.</Alert>}
        {error && <Alert>{error}</Alert>}{notice && <Alert tone="success">{notice}</Alert>}
        {warnings.map((u) => <Alert key={u.metric} tone={u.atLimit && u.enforcement === 'hard' ? 'error' : 'warning'}>{u.label}: {fmtNum(u.used)} of {limitText(u)} used{u.atLimit && u.enforcement === 'hard' ? ' — new work of this kind is paused until the period resets or the plan changes. Collected data is kept.' : '.'}</Alert>)}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card space-y-3 lg:col-span-2" aria-labelledby="sub-h">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="sub-h" className="font-semibold">Subscription</h2>
            <Badge tone={st.tone}>{st.label}</Badge>
          </div>
          {data.plan ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-slate-500">Plan</dt><dd className="font-medium">{data.plan.name} <span className="text-slate-500">v{data.plan.version}</span></dd></div>
              <div><dt className="text-slate-500">Price</dt><dd>{priceText(data.plan)}</dd></div>
              <div><dt className="text-slate-500">Billing</dt><dd>{s?.billingMode === 'contract' ? 'Contract / purchase order' : s?.billingMode === 'manual' ? 'Invoiced manually' : 'Self-service'}</dd></div>
              <div><dt className="text-slate-500">{s?.status === 'trialing' ? 'Trial ends' : 'Current period ends'}</dt><dd>{fmtDate(s?.status === 'trialing' ? s.trialEndsAt : s?.currentPeriodEnd ?? null)}</dd></div>
              {s?.cancelAtPeriodEnd && <div className="sm:col-span-2"><Badge tone="amber">Cancels at the end of the period</Badge></div>}
              {s?.scheduledChange && <div className="sm:col-span-2 text-slate-700">Scheduled change to <strong>{s.scheduledChange.plan.name}</strong> on {fmtDate(s.scheduledChange.at)}.</div>}
            </dl>
          ) : <Empty title="No active subscription" />}
          <p className="text-sm text-slate-600">{accessText(data)}</p>
          <p className="text-xs text-slate-500">Online payment: {data.payments.onlinePayments === 'not_configured' ? 'not configured on this server — plans are arranged through sales and invoiced.' : data.payments.onlinePayments === 'test_mode' ? 'TEST MODE (simulator, no real charges).' : 'available.'}</p>
          {manage && (
            <div className="flex flex-wrap gap-2">
              {data.actions.cancelAtPeriodEnd && <button className="btn-secondary" disabled={busy} onClick={() => { if (confirm('Cancel at the end of the current period? Data stays available until then and remains exportable afterwards.')) void act(() => api(`/organizations/${org.id}/billing/cancel`, { method: 'POST' }), 'Cancellation scheduled for the end of the period.'); }}>Cancel at period end</button>}
              {data.actions.resume && <button className="btn-secondary" disabled={busy} onClick={() => void act(() => api(`/organizations/${org.id}/billing/resume`, { method: 'POST' }), 'Cancellation withdrawn.')}>Keep subscription</button>}
              {data.actions.portal && <button className="btn-secondary" disabled={busy} onClick={() => void portal()}>Payment details</button>}
            </div>
          )}
        </section>

        <section className="card space-y-3" aria-labelledby="inv-sum-h">
          <h2 id="inv-sum-h" className="font-semibold">{data.contract ? 'Contract' : 'Invoices'}</h2>
          {data.contract && (
            <dl className="space-y-1 text-sm">
              <div><dt className="inline text-slate-500">Reference: </dt><dd className="inline">{data.contract.contract_reference}</dd></div>
              {data.contract.po_reference && <div><dt className="inline text-slate-500">Purchase order: </dt><dd className="inline">{data.contract.po_reference}</dd></div>}
              <div><dt className="inline text-slate-500">Term: </dt><dd className="inline">{data.contract.start_date} – {data.contract.end_date}</dd></div>
              <div><dt className="inline text-slate-500">Billing: </dt><dd className="inline">{data.contract.billing_frequency}, payment within {data.contract.payment_terms_days} days</dd></div>
              {data.contract.renewal_date && <div><dt className="inline text-slate-500">Renewal: </dt><dd className="inline">{data.contract.renewal_date}</dd></div>}
              {data.contract.contact_name && <div><dt className="inline text-slate-500">Account contact: </dt><dd className="inline">{data.contract.contact_name}{data.contract.contact_email ? ` (${data.contract.contact_email})` : ''}</dd></div>}
            </dl>
          )}
          <p className="text-sm">{data.invoices.open} open invoice{data.invoices.open === 1 ? '' : 's'}{data.invoices.balance ? ` · balance ${money(data.invoices.balance.amount, data.invoices.balance.currency)}` : ''}</p>
          <p className="text-xs text-slate-500">{data.notice}</p>
        </section>
      </div>

      <section className="card mt-6" aria-labelledby="use-h">
        <h2 id="use-h" className="mb-3 font-semibold">Usage this period</h2>
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          {data.usage.filter((u) => u.metric !== 'api_requests').map((u) => {
            const lv = usageLevel(u);
            return (
              <div key={u.metric}>
                <div className="flex justify-between gap-2 text-sm"><span className="font-medium" title={u.description}>{u.label}</span>
                  <span className="text-slate-600">{fmtNum(u.used)} / {limitText(u)}{u.source === 'override' ? ' · custom' : ''}</span></div>
                {lv ? (
                  <div className="mt-1 h-2 rounded bg-slate-100" role="progressbar" aria-label={`${u.label} usage`} aria-valuenow={Math.round(lv.pct)} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-2 rounded ${BAR[lv.tone]}`} style={{ width: `${lv.pct}%` }} />
                  </div>
                ) : <p className="mt-1 text-xs text-slate-500">No limit on this plan</p>}
                {lv && u.remaining !== null && <p className="mt-0.5 text-xs text-slate-500">{fmtNum(u.remaining)} remaining{u.kind === 'counter' ? ' this period' : ''}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {history && history.length > 1 && (
        <section className="card mt-6 overflow-x-auto" aria-labelledby="hist-h">
          <h2 id="hist-h" className="mb-3 font-semibold">Previous periods</h2>
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Period</th><th>Mentions</th><th>AI analyses</th><th>AI tokens</th><th>Reports</th><th>Exports</th></tr></thead>
            <tbody>{history.map((h) => (
              <tr key={h.start} className="border-t border-slate-100"><td className="py-1">{h.start.slice(0, 10)} – {h.end.slice(0, 10)}</td>
                {['mentions_ingested', 'ai_analyses', 'ai_tokens', 'reports_generated', 'exports'].map((m) => <td key={m}>{h.usage[m] !== undefined ? fmtNum(h.usage[m]!) : '—'}</td>)}</tr>
            ))}</tbody>
          </table>
        </section>
      )}

      <section className="card mt-6" aria-labelledby="plans-h">
        <h2 id="plans-h" className="mb-3 font-semibold">Plans</h2>
        {!plans?.length ? <Empty title="No plans are published yet">Contact sales for a proposal.</Empty> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {plans.map((p) => {
              const current = data.plan?.code === p.code;
              return (
                <div key={p.code} className={`rounded-lg border p-4 ${current ? 'border-brand-600' : 'border-slate-200'}`}>
                  <div className="flex items-center justify-between"><h3 className="font-semibold">{p.name}</h3>{current && <Badge tone="blue">Current</Badge>}</div>
                  <p className="mt-1 text-sm text-slate-700">{priceText(p)}</p>
                  {p.description && <p className="mt-1 text-xs text-slate-500">{p.description}</p>}
                  <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                    {Object.entries(p.quotas).slice(0, 6).map(([k, q]) => <li key={k}>{k.replace(/_/g, ' ')}: {q.limit === null ? 'unlimited' : fmtNum(q.limit)}</li>)}
                  </ul>
                  {!current && (
                    <div className="mt-3">
                      {p.price && data.actions.checkout && manage
                        ? <button className="btn-primary" disabled={busy} onClick={() => void checkout(p.code)}>Choose {p.name}</button>
                        : <button className="btn-secondary" onClick={() => setSales(p.code)}>{p.price ? 'Request this plan' : 'Request a quote'}</button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card mt-6 overflow-x-auto" aria-labelledby="inv-h">
        <h2 id="inv-h" className="mb-3 font-semibold">Invoices</h2>
        {!invoices?.length ? <Empty title="No invoices yet" /> : (
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Number</th><th>Issued</th><th>Due</th><th>Total</th><th>Status</th><th /></tr></thead>
            <tbody>{invoices.map((i) => (
              <tr key={i.id} className="border-t border-slate-100"><td className="py-1">{i.number}</td><td>{fmtDate(i.issuedAt)}</td><td>{fmtDate(i.dueAt)}</td>
                <td>{money(i.total, i.currency)}</td><td><Badge tone={INVOICE_TONE[i.status] ?? 'slate'}>{i.status.replace('_', ' ')}</Badge></td>
                <td><button className="text-brand-700 underline" onClick={() => void showInvoice(i.id)}>View</button></td></tr>
            ))}</tbody>
          </table>
        )}
        {open && (
          <div className="mt-4 rounded-md border border-slate-200 p-4 text-sm" aria-live="polite">
            <div className="flex justify-between"><h3 className="font-semibold">Invoice {open.number}</h3><button className="text-slate-500" onClick={() => setOpen(null)}>Close</button></div>
            <ul className="mt-2 space-y-1">{open.lines?.map((l, n) => <li key={n} className="flex justify-between gap-4"><span>{l.description} × {fmtNum(l.quantity)}</span><span>{money(l.amount, open.currency)}</span></li>)}</ul>
            <p className="mt-2 text-right">Tax {money(open.taxAmount, open.currency)} · <strong>Total {money(open.total, open.currency)}</strong> · Balance {money(open.balance, open.currency)}</p>
            {!!open.payments?.length && <p className="mt-2 text-slate-600">Payments: {open.payments.map((p) => `${money(p.amount, p.currency)} (${p.reference}, ${fmtDate(p.receivedAt)})`).join('; ')}</p>}
            <p className="mt-2 text-xs text-slate-500">{open.notice}</p>
          </div>
        )}
      </section>

      {sales && (
        <section className="card mt-6" aria-labelledby="sales-h">
          <h2 id="sales-h" className="mb-3 font-semibold">Contact sales</h2>
          <form onSubmit={sendSales} className="grid gap-3 md:grid-cols-2">
            <div><label className="label" htmlFor="kind">Request</label>
              <select id="kind" name="kind" className="input" defaultValue={sales === 'quote' ? 'quote' : 'plan_change'}>
                <option value="quote">Quote / proposal</option><option value="plan_change">Plan change</option><option value="contract">Contract or purchase order (government, enterprise)</option><option value="other">Other</option>
              </select></div>
            <div><label className="label" htmlFor="planCode">Plan</label>
              <select id="planCode" name="planCode" className="input" defaultValue={sales === 'quote' ? '' : sales}><option value="">Not sure yet</option>{plans?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></div>
            <div className="md:col-span-2"><label className="label" htmlFor="message">Message</label><textarea id="message" name="message" required maxLength={4000} rows={4} className="input" placeholder="Number of users, monitoring scope, procurement requirements…" /></div>
            <div><label className="label" htmlFor="phone">Phone (optional)</label><input id="phone" name="phone" maxLength={50} className="input" /></div>
            <div className="flex items-end gap-2"><button className="btn-primary" disabled={busy}>Send request</button><button type="button" className="btn-secondary" onClick={() => setSales(null)}>Cancel</button></div>
          </form>
        </section>
      )}
    </>
  );
}
