'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { SessionProvider, useSession } from '@/components/session';
import { Alert, Badge, Empty, Loading, PageHeader } from '@/components/ui';
import { api, errorMessage, fmtDate } from '@/lib/api';
import { fmtNum, limitText, money, STATUS_LABEL, type Invoice, type SubStatus, type UsageRow } from '@/lib/billing';

type Tab = 'health' | 'tenants' | 'plans' | 'invoices' | 'costs' | 'sales' | 'audit';
const P = (path: string) => `/platform/commercial${path}`;
// Operator views render API rows as returned (shapes are defined and validated by the API, not duplicated here).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** Operator console. The API (session + platform-admin flag) is the authorization boundary; this page only renders it. */
function Console() {
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('health');
  const [tenant, setTenant] = useState<string | null>(null);
  if (!me.user.isPlatformAdmin) return <div className="mx-auto max-w-lg p-10"><Alert tone="info">The platform console is available to platform operators only.</Alert></div>;
  const tabs: Array<[Tab, string]> = [['health', 'Billing health'], ['tenants', 'Organizations'], ['plans', 'Plans'], ['invoices', 'Invoices'], ['costs', 'Costs & margin'], ['sales', 'Sales requests'], ['audit', 'Commercial audit']];
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title="Platform console" description="Commercial operations across organizations. Every change requires a reason and is recorded in the audit log."
        actions={me.organizations[0] ? <Link className="btn-secondary" href={`/o/${me.organizations[0].id}`}>Back to workspace</Link> : undefined} />
      <nav aria-label="Console sections" className="mb-6 flex flex-wrap gap-2">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'btn-primary' : 'btn-secondary'} aria-current={tab === k ? 'page' : undefined} onClick={() => { setTab(k); setTenant(null); }}>{l}</button>)}
      </nav>
      {tab === 'health' && <Health />}
      {tab === 'tenants' && (tenant ? <TenantDetail id={tenant} back={() => setTenant(null)} /> : <Tenants open={setTenant} />)}
      {tab === 'plans' && <Plans />}
      {tab === 'invoices' && <Invoices />}
      {tab === 'costs' && <Costs />}
      {tab === 'sales' && <Sales />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { if (!path) return; try { setData(await api<T>(path)); setError(null); } catch (e) { setError(errorMessage(e)); } }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const Section = ({ title, children }: { title: string; children: ReactNode }) => <section className="card mb-6 overflow-x-auto"><h2 className="mb-3 font-semibold">{title}</h2>{children}</section>;
const Reason = () => <div><label className="label" htmlFor="reason">Reason (required, audited)</label><input id="reason" name="reason" required minLength={5} maxLength={1000} className="input" /></div>;
const statusBadge = (s: string | null) => { const v = STATUS_LABEL[(s ?? 'none') as SubStatus | 'none'] ?? STATUS_LABEL.none; return <Badge tone={v.tone}>{v.label}</Badge>; };

/** Form helper: submits, shows the API's answer (success or refusal) and reloads. */
function useAction(reload: () => Promise<void>) {
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ tone: 'success', text: ok }); await reload(); return true; } catch (e) { setMsg({ tone: 'error', text: errorMessage(e) }); return false; }
  };
  return { msg: msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>, run };
}
const form = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; };

function Health() {
  const { data, error } = useLoad<Json>(P('/health'));
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <>
      <Section title="Payment provider">
        <p className="text-sm">{data.provider.name === 'none' ? 'No payment provider is configured. Online checkout is disabled; use contracts and manual invoices.' : `Adapter "${data.provider.name}" — ${data.provider.live ? 'live' : 'TEST MODE, no real charges'}.`}</p>
      </Section>
      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Subscriptions">
          <ul className="text-sm">{data.subscriptions.map((s: Json) => <li key={s.status} className="flex justify-between">{statusBadge(s.status)}<span>{s.n}</span></li>)}</ul>
          <p className="mt-2 text-sm text-slate-600">Without subscription: {data.tenantsWithoutSubscription} · trials ending within 7 days: {data.trialsEndingIn7Days} · open sales requests: {data.openSalesRequests}</p>
        </Section>
        <Section title="Invoices and notices">
          <ul className="text-sm">{data.invoices.map((s: Json) => <li key={s.status} className="flex justify-between"><span>{s.status}</span><span>{s.n}</span></li>)}</ul>
          <p className="mt-2 text-sm text-slate-600">Usage notice emails: {data.noticesPendingEmail.map((n: Json) => `${n.email_status} ${n.n}`).join(' · ') || 'none'}</p>
        </Section>
      </div>
      <Section title="Webhooks (last 7 days) and failures">
        <p className="mb-2 text-sm">{data.webhooks.map((w: Json) => `${w.status}: ${w.n}`).join(' · ') || 'No webhook events received.'}</p>
        {!data.failedWebhooks.length ? <Empty title="No failed or rejected webhooks" /> : (
          <table className="w-full min-w-[640px] text-sm"><thead><tr className="text-left text-slate-500"><th>Received</th><th>Provider</th><th>Type</th><th>Status</th><th>Error</th></tr></thead>
            <tbody>{data.failedWebhooks.map((w: Json) => <tr key={w.id} className="border-t border-slate-100"><td className="py-1">{fmtDate(w.received_at)}</td><td>{w.provider}</td><td>{w.event_type}</td><td>{w.status}</td><td className="max-w-md truncate" title={w.error}>{w.error}</td></tr>)}</tbody></table>
        )}
      </Section>
    </>
  );
}

function Tenants({ open }: { open: (id: string) => void }) {
  const { data, error } = useLoad<{ tenants: Json[] }>(P('/tenants'));
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <Section title="Organizations">
      <table className="w-full min-w-[720px] text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">Name</th><th>Plan</th><th>Status</th><th>Billing</th><th>Period / trial end</th><th>Overdue</th><th /></tr></thead>
        <tbody>{data.tenants.map((t) => (
          <tr key={t.id} className="border-t border-slate-100"><td className="py-1">{t.name}</td><td>{t.plan_code ?? '—'}</td><td>{statusBadge(t.status)}</td><td>{t.billing_mode ?? '—'}</td>
            <td>{fmtDate(t.status === 'trialing' ? t.trial_ends_at : t.current_period_end)}</td><td>{t.overdue_invoices || ''}</td>
            <td><button className="text-brand-700 underline" onClick={() => open(t.id)}>Manage</button></td></tr>
        ))}</tbody></table>
    </Section>
  );
}

function TenantDetail({ id, back }: { id: string; back: () => void }) {
  const { data, error, reload } = useLoad<Json>(P(`/tenants/${id}`));
  const plans = useLoad<{ plans: Json[]; metrics: string[] }>(P('/plans'));
  const { msg, run } = useAction(reload);
  const [inv, setInv] = useState<string | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data || !plans.data) return <Loading />;
  const sub = data.subscription; const codes = plans.data.plans.filter((p) => p.isActive).map((p) => p.code as string);
  const post = (path: string, body: object) => api(P(`/tenants/${id}${path}`), { method: 'POST', body });
  const planSelect = <div><label className="label" htmlFor="planCode">Plan</label><select id="planCode" name="planCode" className="input">{codes.map((c) => <option key={c}>{c}</option>)}</select></div>;
  return (
    <>
      <button className="btn-secondary mb-4" onClick={back}>← All organizations</button>
      {msg}
      <Section title={data.tenant.name}>
        <div className="flex flex-wrap items-center gap-3 text-sm">{statusBadge(sub?.status ?? null)}<span>Plan {sub?.plan_code ?? '—'}</span><span>Mode {sub?.billing_mode ?? '—'}</span>
          <span>Period {fmtDate(sub?.current_period_start ?? null)} – {fmtDate(sub?.current_period_end ?? null)}</span><span>Access {data.entitlements.access}</span><span>TZ {data.tenant.timezone ?? 'Asia/Jakarta'}</span></div>
        <div className="mt-4 grid gap-x-8 gap-y-2 md:grid-cols-2">{data.usage.map((u: UsageRow) => <p key={u.metric} className="flex justify-between text-sm"><span>{u.label}</span><span>{fmtNum(u.used)} / {limitText(u)}{u.source === 'override' ? ' (override)' : ''}</span></p>)}</div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Assign plan (manual provisioning)">
          <form className="space-y-3" onSubmit={(e) => { const f = form(e); void run(() => post('/subscription/assign', { planCode: f.planCode, billingMode: f.billingMode, status: f.status, reason: f.reason, ...(f.trialEndsAt ? { trialEndsAt: new Date(f.trialEndsAt).toISOString() } : {}), resetUsagePeriod: f.reset === 'on' }), 'Plan assigned.'); }}>
            {planSelect}
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label" htmlFor="billingMode">Billing mode</label><select id="billingMode" name="billingMode" className="input"><option value="contract">contract</option><option value="manual">manual</option><option value="self_service">self_service</option></select></div>
              <div><label className="label" htmlFor="status">Status</label><select id="status" name="status" className="input"><option>active</option><option>pending_activation</option><option>trialing</option></select></div>
            </div>
            <div><label className="label" htmlFor="trialEndsAt">Trial ends (only for trialing)</label><input id="trialEndsAt" name="trialEndsAt" type="date" className="input" /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="reset" /> Start a new usage period now</label>
            <Reason /><button className="btn-primary">Assign</button>
          </form>
        </Section>

        <Section title="Lifecycle action">
          {!sub ? <p className="text-sm text-slate-600">No current subscription — assign a plan first.</p> : (
            <form className="space-y-3" onSubmit={(e) => { const f = form(e); void run(() => post('/subscription/transition', { event: f.event, reason: f.reason }), 'Subscription updated.'); }}>
              <div><label className="label" htmlFor="event">Allowed from “{sub.status}”</label>
                <select id="event" name="event" className="input">{data.allowedEvents.filter((e: string) => !['trial_expired', 'period_end_cancel'].includes(e)).map((e: string) => <option key={e}>{e}</option>)}</select></div>
              <Reason /><button className="btn-primary">Apply</button>
            </form>
          )}
          {sub && (
            <form className="mt-6 space-y-3 border-t border-slate-100 pt-4" onSubmit={(e) => { const f = form(e); void run(() => post('/subscription/change-plan', { planCode: f.planCode, when: f.when, reason: f.reason }), f.when === 'now' ? 'Plan changed.' : 'Change scheduled.'); }}>
              {planSelect}
              <div><label className="label" htmlFor="when">When</label><select id="when" name="when" className="input"><option value="now">now (upgrade)</option><option value="period_end">at period end (downgrade)</option></select></div>
              <Reason /><button className="btn-secondary">Change plan</button>
            </form>
          )}
        </Section>

        <Section title="Quota overrides">
          <ul className="mb-3 space-y-1 text-sm">{data.overrides.filter((o: Json) => !o.revoked_at).map((o: Json) => <li key={o.id} className="flex justify-between gap-2"><span>{o.metric}: {o.quota_limit ?? 'unlimited'} ({o.enforcement}) — {o.reason}</span>
            <button className="text-red-700 underline" onClick={() => { const reason = prompt('Reason for revoking this override'); if (reason) void run(() => api(P(`/tenants/${id}/overrides/${o.id}`), { method: 'DELETE', body: { reason } }), 'Override revoked.'); }}>Revoke</button></li>)}</ul>
          <form className="space-y-3" onSubmit={(e) => { const f = form(e); void run(() => post('/overrides', { metric: f.metric, limit: f.limit === '' ? null : Number(f.limit), enforcement: f.enforcement, reason: f.reason, ...(f.expiresAt ? { expiresAt: new Date(f.expiresAt).toISOString() } : {}) }), 'Override set.'); }}>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="label" htmlFor="metric">Metric</label><select id="metric" name="metric" className="input">{plans.data.metrics.map((m: string) => <option key={m}>{m}</option>)}</select></div>
              <div><label className="label" htmlFor="limit">Limit (empty = unlimited)</label><input id="limit" name="limit" type="number" min={0} className="input" /></div>
              <div><label className="label" htmlFor="enforcement">Enforcement</label><select id="enforcement" name="enforcement" className="input"><option>hard</option><option>soft</option></select></div>
            </div>
            <div><label className="label" htmlFor="expiresAt">Expires (optional)</label><input id="expiresAt" name="expiresAt" type="date" className="input" /></div>
            <Reason /><button className="btn-secondary">Set override</button>
          </form>
        </Section>

        <Section title="Contract (government / enterprise)">
          <ul className="mb-3 text-sm">{data.contracts.map((k: Json) => <li key={k.id}>{k.contract_reference} · {k.status} · {k.start_date} – {k.end_date}{k.po_reference ? ` · PO ${k.po_reference}` : ''}</li>)}</ul>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { const f = form(e); void run(() => post('/contracts', { customerName: f.customerName, contractReference: f.contractReference, poReference: f.poReference || undefined, planCode: f.planCode,
            startDate: f.startDate, endDate: f.endDate, billingFrequency: f.billingFrequency, paymentTermsDays: Number(f.paymentTermsDays || 30), ...(f.contractValue ? { contractValue: Number(f.contractValue), currency: f.currency || 'IDR' } : {}),
            contactName: f.contactName || undefined, contactEmail: f.contactEmail || undefined, activation: f.activation, reason: f.reason }), 'Contract recorded.'); }}>
            <div><label className="label" htmlFor="customerName">Customer</label><input id="customerName" name="customerName" required className="input" /></div>
            <div><label className="label" htmlFor="contractReference">Contract ref.</label><input id="contractReference" name="contractReference" required className="input" /></div>
            <div><label className="label" htmlFor="poReference">PO ref.</label><input id="poReference" name="poReference" className="input" /></div>
            {planSelect}
            <div><label className="label" htmlFor="startDate">Start</label><input id="startDate" name="startDate" type="date" required className="input" /></div>
            <div><label className="label" htmlFor="endDate">End</label><input id="endDate" name="endDate" type="date" required className="input" /></div>
            <div><label className="label" htmlFor="billingFrequency">Billing</label><select id="billingFrequency" name="billingFrequency" className="input"><option>annual</option><option>semiannual</option><option>quarterly</option><option>monthly</option><option>one_time</option></select></div>
            <div><label className="label" htmlFor="paymentTermsDays">Payment terms (days)</label><input id="paymentTermsDays" name="paymentTermsDays" type="number" min={0} defaultValue={30} className="input" /></div>
            <div><label className="label" htmlFor="contractValue">Value</label><input id="contractValue" name="contractValue" type="number" min={0} className="input" /></div>
            <div><label className="label" htmlFor="currency">Currency</label><input id="currency" name="currency" defaultValue="IDR" pattern="[A-Z]{3}" className="input" /></div>
            <div><label className="label" htmlFor="contactName">Contact</label><input id="contactName" name="contactName" className="input" /></div>
            <div><label className="label" htmlFor="contactEmail">Contact email</label><input id="contactEmail" name="contactEmail" type="email" className="input" /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="activation">Activation</label><select id="activation" name="activation" className="input"><option value="none">record only (draft)</option><option value="pending_activation">pending activation</option><option value="active">activate now</option></select></div>
            <div className="sm:col-span-2"><Reason /></div><button className="btn-secondary">Save contract</button>
          </form>
        </Section>
      </div>

      <Section title="Invoices">
        <table className="mb-4 w-full min-w-[640px] text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">Number</th><th>Status</th><th>Total</th><th>Paid</th><th>Due</th><th /></tr></thead>
          <tbody>{data.invoices.map((i: Invoice) => <tr key={i.id} className="border-t border-slate-100"><td className="py-1">{i.number ?? 'draft'}</td><td>{i.status}</td><td>{money(i.total, i.currency)}</td><td>{money(i.amountPaid, i.currency)}</td><td>{fmtDate(i.dueAt)}</td>
            <td className="space-x-2">{i.status === 'draft' && <button className="underline" onClick={() => { const reason = prompt('Reason for issuing'); if (reason) void run(() => post(`/invoices/${i.id}/issue`, { dueDays: 30, reason }), 'Invoice issued.'); }}>Issue</button>}
              {['issued', 'partially_paid', 'overdue'].includes(i.status) && <button className="underline" onClick={() => setInv(i.id)}>Record payment</button>}
              {['draft', 'issued', 'overdue'].includes(i.status) && i.amountPaid === 0 && <button className="text-red-700 underline" onClick={() => { const reason = prompt('Reason for voiding'); if (reason) void run(() => post(`/invoices/${i.id}/void`, { reason }), 'Invoice voided.'); }}>Void</button>}</td></tr>)}</tbody></table>
        {inv && (
          <form className="mb-6 grid gap-3 rounded-md border border-slate-200 p-4 sm:grid-cols-2" onSubmit={(e) => { const f = form(e); void run(() => post(`/invoices/${inv}/payments`, { reason: f.reason, payment: { amount: Number(f.amount), method: f.method, reference: f.reference, receivedAt: new Date(f.receivedAt!).toISOString(), note: f.note || undefined } }), 'Payment reconciled.').then((ok) => ok && setInv(null)); }}>
            <p className="sm:col-span-2 text-sm font-medium">Manual reconciliation (bank transfer, treasury / SP2D)</p>
            <div><label className="label" htmlFor="amount">Amount</label><input id="amount" name="amount" type="number" min={0.01} step="0.01" required className="input" /></div>
            <div><label className="label" htmlFor="method">Method</label><select id="method" name="method" className="input"><option value="bank_transfer">bank transfer</option><option value="government_treasury">government treasury</option><option value="other">other</option></select></div>
            <div><label className="label" htmlFor="reference">Remittance reference</label><input id="reference" name="reference" required className="input" /></div>
            <div><label className="label" htmlFor="receivedAt">Received on</label><input id="receivedAt" name="receivedAt" type="date" required className="input" /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="note">Note</label><input id="note" name="note" className="input" /></div>
            <div className="sm:col-span-2"><Reason /></div><div className="flex gap-2"><button className="btn-primary">Record</button><button type="button" className="btn-secondary" onClick={() => setInv(null)}>Cancel</button></div>
          </form>
        )}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { const f = form(e); void run(() => post('/invoices', { reason: f.reason, invoice: { currency: f.currency, lines: [{ description: f.description, quantity: Number(f.quantity || 1), unitAmount: Number(f.unitAmount) }],
          taxAmount: Number(f.taxAmount || 0), poReference: f.poReference || undefined, billTo: { name: f.billTo, ...(f.taxId ? { taxId: f.taxId } : {}) }, ...(data.contracts[0] ? { contractId: data.contracts[0].id } : {}) } }), 'Draft invoice created.'); }}>
          <p className="sm:col-span-2 text-sm font-medium">New draft invoice <span className="font-normal text-slate-500">— a payment request, not a Faktur Pajak.</span></p>
          <div><label className="label" htmlFor="billTo">Bill to</label><input id="billTo" name="billTo" required className="input" /></div>
          <div><label className="label" htmlFor="taxId">Buyer tax ID (reference only)</label><input id="taxId" name="taxId" className="input" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="description">Line description</label><input id="description" name="description" required className="input" /></div>
          <div><label className="label" htmlFor="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min={1} defaultValue={1} className="input" /></div>
          <div><label className="label" htmlFor="unitAmount">Unit amount</label><input id="unitAmount" name="unitAmount" type="number" min={0} step="0.01" required className="input" /></div>
          <div><label className="label" htmlFor="taxAmount">Tax amount</label><input id="taxAmount" name="taxAmount" type="number" min={0} step="0.01" defaultValue={0} className="input" /></div>
          <div><label className="label" htmlFor="currency2">Currency</label><input id="currency2" name="currency" defaultValue="IDR" pattern="[A-Z]{3}" className="input" /></div>
          <div><label className="label" htmlFor="poRef2">PO reference</label><input id="poRef2" name="poReference" className="input" /></div>
          <div className="sm:col-span-2"><Reason /></div><button className="btn-secondary">Create draft</button>
        </form>
      </Section>

      <Section title="Subscription history">
        <ul className="space-y-1 text-sm">{data.events.map((e: Json) => <li key={e.id}>{fmtDate(e.created_at)} · <strong>{e.event}</strong> {e.from_status ? `${e.from_status} → ` : ''}{e.to_status ?? ''} · {e.actor_type}{e.reason ? ` · ${e.reason}` : ''}</li>)}</ul>
      </Section>
    </>
  );
}

function Plans() {
  const { data, error, reload } = useLoad<{ plans: Json[]; metrics: string[] }>(P('/plans'));
  const { msg, run } = useAction(reload);
  const [edit, setEdit] = useState<string | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  const current = (p: Json) => p.versions[0];
  return (
    <>
      {msg}
      <Section title="Plans">
        <p className="mb-3 text-sm text-slate-600">Prices are not shipped with the software: a plan without a price is sold through sales. Versions are immutable; existing subscriptions keep their version.</p>
        <table className="w-full min-w-[720px] text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">Code</th><th>Name</th><th>Category</th><th>Public</th><th>Active</th><th>Current version</th><th>Price</th><th>Subscriptions</th><th /></tr></thead>
          <tbody>{data.plans.map((p) => { const v = current(p); return (
            <tr key={p.code} className="border-t border-slate-100"><td className="py-1">{p.code}</td><td>{p.name}</td><td>{p.category}</td><td>{p.isPublic ? 'yes' : 'no'}</td><td>{p.isActive ? 'yes' : 'no'}</td>
              <td>v{v?.version} from {fmtDate(v?.effectiveFrom ?? null)}</td><td>{v?.price ? money(v.price.amount, v.price.currency) + ' / ' + v.price.interval : 'on request'}</td>
              <td>{p.versions.reduce((a: number, x: Json) => a + x.subscriptions, 0)}</td><td><button className="underline" onClick={() => setEdit(p.code)}>New version</button></td></tr>); })}</tbody></table>
      </Section>
      {edit && (() => {
        const v = current(data.plans.find((p) => p.code === edit)!);
        const initial = JSON.stringify({ currency: v.price?.currency ?? null, priceAmount: v.price?.amount ?? null, billingInterval: v.billingInterval, trialDays: v.trialDays, features: v.features, quotas: v.quotas, settings: v.settings }, null, 2);
        return (
          <Section title={`New version of “${edit}”`}>
            <form className="space-y-3" onSubmit={(e) => {
              const f = form(e); let version: unknown;
              try { version = JSON.parse(f.version!); } catch { alert('The version must be valid JSON'); return; }
              void run(() => api(P(`/plans/${edit}/versions`), { method: 'POST', body: { version, reason: f.reason } }), 'Version created.').then((ok) => ok && setEdit(null));
            }}>
              <label className="label" htmlFor="version">Terms (validated by the server: known metrics and features only; a price needs a currency)</label>
              <textarea id="version" name="version" rows={18} defaultValue={initial} className="input font-mono text-xs" />
              <Reason /><div className="flex gap-2"><button className="btn-primary">Create version</button><button type="button" className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button></div>
            </form>
          </Section>
        );
      })()}
      <Section title="New plan">
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { const f = form(e); void run(() => api(P('/plans'), { method: 'POST', body: { code: f.code, name: f.name, category: f.category, isPublic: f.isPublic === 'on', reason: f.reason } }), 'Plan created; add a version to make it assignable.'); }}>
          <div><label className="label" htmlFor="code">Code</label><input id="code" name="code" required pattern="[a-z][a-z0-9_]{1,40}" className="input" /></div>
          <div><label className="label" htmlFor="pname">Name</label><input id="pname" name="name" required className="input" /></div>
          <div><label className="label" htmlFor="category">Category</label><select id="category" name="category" className="input"><option>self_service</option><option>sales_assisted</option><option>public_sector</option><option>trial</option><option>internal</option></select></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPublic" /> Shown to customers</label>
          <div className="sm:col-span-3"><Reason /></div><button className="btn-secondary">Create plan</button>
        </form>
      </Section>
    </>
  );
}

function Invoices() {
  const { data, error } = useLoad<{ invoices: Array<Invoice & { tenantName: string }> }>(P('/invoices'));
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <Section title="All invoices">
      {!data.invoices.length ? <Empty title="No invoices" /> : (
        <table className="w-full min-w-[720px] text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">Organization</th><th>Number</th><th>Source</th><th>Status</th><th>Total</th><th>Balance</th><th>Due</th></tr></thead>
          <tbody>{data.invoices.map((i) => <tr key={i.id} className="border-t border-slate-100"><td className="py-1">{i.tenantName}</td><td>{i.number ?? 'draft'}</td><td>{i.source}</td><td>{i.status}</td><td>{money(i.total, i.currency)}</td><td>{money(i.balance, i.currency)}</td><td>{fmtDate(i.dueAt)}</td></tr>)}</tbody></table>
      )}
    </Section>
  );
}

function Costs() {
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const { data, error, reload } = useLoad<Json>(P(`/costs?from=${range.from}&to=${range.to}`));
  const { msg, run } = useAction(reload);
  const list = (xs: Array<{ amount: number; currency: string }>) => xs.length ? xs.map((x) => money(x.amount, x.currency)).join(' + ') : '—';
  return (
    <>
      {msg}
      <Section title="Costs, billing and margin (internal)">
        <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
          <div><label className="label" htmlFor="from">From</label><input id="from" type="date" className="input" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
          <div><label className="label" htmlFor="to">To</label><input id="to" type="date" className="input" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
        </div>
        {error && <Alert>{error}</Alert>}
        {!data ? <Loading /> : (
          <>
            <table className="w-full min-w-[900px] text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">Organization</th><th>Plan</th><th>AI tokens</th><th>Estimated AI cost</th><th>Actual cost</th><th>Billed</th><th>Revenue</th><th>Margin</th></tr></thead>
              <tbody>{data.tenants.map((t: Json) => <tr key={t.tenantId} className="border-t border-slate-100"><td className="py-1">{t.name}</td><td>{t.plan ?? '—'}</td>
                <td>{fmtNum(t.ai.tokens)}{t.ai.unpricedCalls ? ` (${t.ai.unpricedCalls} unpriced)` : ''}</td><td title={t.ai.pricingUpdatedAt ? `prices updated ${t.ai.pricingUpdatedAt}` : 'no pricing configured'}>{list(t.ai.estimatedCost)}</td>
                <td>{list(t.actualCost)}</td><td>{list(t.billed)}</td><td>{list(t.revenue)}</td>
                <td>{t.margin.amount !== null ? `${money(t.margin.amount, t.margin.currency)} (${t.margin.basis.replace('_', ' ')})` : t.margin.basis.replace(/_/g, ' ')}</td></tr>)}</tbody></table>
            <ul className="mt-3 list-disc pl-5 text-xs text-slate-500">{data.notes.map((n: string) => <li key={n}>{n}</li>)}<li>Unattributed actual cost: {list(data.unattributedActualCost)}</li></ul>
          </>
        )}
      </Section>
      <Section title="Record an actual provider cost">
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { const f = form(e); void run(() => api(P('/costs/entries'), { method: 'POST', body: { tenantId: f.tenantId || null, provider: f.provider, service: f.service, periodStart: f.periodStart, periodEnd: f.periodEnd,
          amount: Number(f.amount), currency: f.currency, sourceReference: f.sourceReference, reason: f.reason } }), 'Cost recorded.'); }}>
          <div><label className="label" htmlFor="tenantId">Organization ID (empty = platform-wide)</label><input id="tenantId" name="tenantId" className="input" /></div>
          <div><label className="label" htmlFor="provider">Provider</label><input id="provider" name="provider" required className="input" /></div>
          <div><label className="label" htmlFor="service">Service</label><input id="service" name="service" required className="input" /></div>
          <div><label className="label" htmlFor="periodStart">Period start</label><input id="periodStart" name="periodStart" type="date" required className="input" /></div>
          <div><label className="label" htmlFor="periodEnd">Period end</label><input id="periodEnd" name="periodEnd" type="date" required className="input" /></div>
          <div><label className="label" htmlFor="camount">Amount</label><input id="camount" name="amount" type="number" min={0} step="0.0001" required className="input" /></div>
          <div><label className="label" htmlFor="ccurrency">Currency</label><input id="ccurrency" name="currency" defaultValue="USD" pattern="[A-Z]{3}" className="input" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="sourceReference">Source (provider invoice no. / export)</label><input id="sourceReference" name="sourceReference" required minLength={3} className="input" /></div>
          <div className="sm:col-span-3"><Reason /></div><button className="btn-secondary">Record cost</button>
        </form>
      </Section>
    </>
  );
}

function Sales() {
  const { data, error, reload } = useLoad<{ requests: Json[] }>(P('/sales-requests'));
  const { msg, run } = useAction(reload);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <>{msg}
      <Section title="Sales requests">
        {!data.requests.length ? <Empty title="No requests" /> : (
          <ul className="space-y-3">{data.requests.map((r) => (
            <li key={r.id} className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2"><span><strong>{r.tenant_name}</strong> · {r.kind}{r.plan_code ? ` · ${r.plan_code}` : ''} · {r.requested_by_email}{r.contact_phone ? ` · ${r.contact_phone}` : ''}</span><span>{fmtDate(r.created_at)} · {r.status}</span></div>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">{r.message}</p>
              <div className="mt-2 flex gap-2">{(['in_progress', 'closed'] as const).filter((s) => s !== r.status).map((s) => (
                <button key={s} className="btn-secondary" onClick={() => { const note = prompt('Note (optional)') ?? undefined; void run(() => api(P(`/sales-requests/${r.id}`), { method: 'PATCH', body: { status: s, ...(note ? { note } : {}) } }), 'Updated.'); }}>Mark {s.replace('_', ' ')}</button>))}</div>
            </li>))}</ul>
        )}
      </Section>
    </>
  );
}

function Audit() {
  const { data, error } = useLoad<{ events: Json[] }>(P('/audit?limit=200'));
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <Section title="Commercial audit events">
      <table className="w-full min-w-[800px] text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">When</th><th>Organization</th><th>Actor</th><th>Action</th><th>Reason</th></tr></thead>
        <tbody>{data.events.map((e) => <tr key={e.id} className="border-t border-slate-100"><td className="py-1">{fmtDate(e.occurred_at)}</td><td>{e.tenant_name ?? 'platform'}</td><td>{e.actor_email ?? 'system'}</td><td>{e.action.replace('commercial.', '')}</td><td className="max-w-sm truncate" title={e.metadata?.reason}>{e.metadata?.reason ?? ''}</td></tr>)}</tbody></table>
    </Section>
  );
}

export default function PlatformPage() { return <SessionProvider><Console /></SessionProvider>; }
