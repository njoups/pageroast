import type { Role } from './api';

export type SubStatus = 'trialing' | 'pending_activation' | 'active' | 'pending_renewal' | 'past_due' | 'suspended' | 'canceled' | 'expired';
export interface UsageRow {
  metric: string; label: string; unit: string; kind: 'counter' | 'gauge'; description: string; used: number; limit: number | null; remaining: number | null;
  percentUsed: number | null; enforcement: 'hard' | 'soft' | 'none'; source: 'plan' | 'override' | 'not_in_plan'; overLimit: boolean; atLimit: boolean;
}
export interface PlanInfo {
  code: string; name: string; category: string; description: string | null; versionId: string; version: number;
  price: { amount: number; currency: string; interval: string } | null; priceStatus: 'listed' | 'contact_sales'; billingInterval: string; trialDays: number;
  features: Record<string, boolean>; quotas: Record<string, { limit: number | null; enforcement: string }>; settings: Record<string, unknown>;
}
export interface Invoice {
  id: string; number: string | null; status: string; source: string; currency: string; subtotal: number; taxAmount: number; total: number; amountPaid: number; balance: number;
  periodStart: string | null; periodEnd: string | null; issuedAt: string | null; dueAt: string | null; paidAt: string | null; poReference: string | null; notice: string;
  lines?: Array<{ description: string; quantity: number; unitAmount: number; amount: number }>;
  payments?: Array<{ id: string; amount: number; currency: string; method: string; reference: string; receivedAt: string; source: string }>;
}
export interface BillingOverview {
  subscription: null | {
    status: SubStatus; access: 'full' | 'limited' | 'read_only'; billingMode: 'self_service' | 'contract' | 'manual'; trialEndsAt: string | null;
    currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; canceledAt: string | null; pastDueSince: string | null;
    suspendedReason: string | null; scheduledChange: { plan: { code: string; name: string }; at: string } | null; paymentMethodOnFile: boolean; provider: string | null;
  };
  plan: PlanInfo | null;
  usagePeriod: { start: string; end: string; timezone: string };
  usage: UsageRow[];
  notices: Array<{ id: string; metric: string; threshold: number; used: number; limit: number; message: string; createdAt: string; acknowledgedAt: string | null }>;
  invoices: { open: number; balance: { amount: number; currency: string } | null };
  contract: null | { contract_reference: string; po_reference: string | null; start_date: string; end_date: string; billing_frequency: string; payment_terms_days: number; renewal_date: string | null; status: string; contact_name: string | null; contact_email: string | null };
  payments: { name: string; configured: boolean; live: boolean; onlinePayments: 'available' | 'test_mode' | 'not_configured' };
  actions: { checkout: boolean; cancelAtPeriodEnd: boolean; resume: boolean; portal: boolean; contactSales: boolean };
  notice: string;
}
export interface OnboardingState {
  path: 'self_service' | 'sales_assisted'; complete: boolean; completedAt: string | null; nextStep: string | null;
  steps: Array<{ key: string; status: 'done' | 'skipped' | 'todo'; derived: boolean; skippable: boolean; at: string | null }>;
}

export const STATUS_LABEL: Record<SubStatus | 'none', { label: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'slate' }> = {
  trialing: { label: 'Trial', tone: 'blue' }, pending_activation: { label: 'Pending activation', tone: 'amber' }, active: { label: 'Active', tone: 'green' },
  pending_renewal: { label: 'Renewal due', tone: 'amber' }, past_due: { label: 'Payment overdue', tone: 'red' }, suspended: { label: 'Suspended', tone: 'red' },
  canceled: { label: 'Canceled', tone: 'slate' }, expired: { label: 'Expired', tone: 'slate' }, none: { label: 'No active subscription', tone: 'slate' },
};

/** Explains what the organization can do in its current state (mirrors the API's access levels). */
export function accessText(o: BillingOverview): string {
  const s = o.subscription;
  if (!s) return 'There is no active subscription. Your data stays readable and exportable; new collection, analysis and reports are paused until a plan is assigned.';
  if (s.access === 'read_only') return `The subscription is ${STATUS_LABEL[s.status].label.toLowerCase()}. Data stays readable and exportable; new work is paused. Nothing has been deleted.`;
  if (s.access === 'limited') return 'Your contract is being activated. You can set up projects, sources and members; collection, analysis and reports start once it is active.';
  if (s.status === 'past_due') return 'A payment is overdue. Everything keeps working during the grace period; settle the invoice to avoid suspension.';
  return 'All included features are available.';
}

export function money(amount: number, currency: string): string {
  try { return new Intl.NumberFormat(currency === 'IDR' ? 'id-ID' : 'en-GB', { style: 'currency', currency, maximumFractionDigits: currency === 'IDR' ? 0 : 2 }).format(amount); }
  catch { return `${amount} ${currency}`; }
}

export function priceText(p: PlanInfo): string {
  if (!p.price) return 'Price on request';
  const per = p.price.interval === 'month' ? '/ month' : p.price.interval === 'year' ? '/ year' : '';
  return `${money(p.price.amount, p.price.currency)} ${per}`.trim();
}

export function limitText(u: Pick<UsageRow, 'limit' | 'unit' | 'enforcement'>): string {
  if (u.limit === null || u.enforcement === 'none') return 'Unlimited';
  return `${fmtNum(u.limit)} ${u.unit}${u.enforcement === 'soft' ? ' (soft limit)' : ''}`;
}

export const fmtNum = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(n);

/** Bar level for a usage row; null when there is no limit (no fake percentage). */
export function usageLevel(u: UsageRow): null | { pct: number; tone: 'ok' | 'warn' | 'high' | 'over' } {
  if (u.limit === null || u.enforcement === 'none' || u.percentUsed === null) return null;
  const pct = Math.min(100, Math.max(0, u.percentUsed));
  return { pct, tone: u.percentUsed >= 100 ? 'over' : u.percentUsed >= 85 ? 'high' : u.percentUsed >= 70 ? 'warn' : 'ok' };
}

export const STEP_LABEL: Record<string, { title: string; hint: string; href?: (orgId: string) => string }> = {
  organization: { title: 'Create the organization', hint: 'Done when the organization exists.' },
  invite: { title: 'Invite your team', hint: 'Invite colleagues and assign roles.', href: (o) => `/o/${o}/team` },
  plan: { title: 'Choose a plan or request a proposal', hint: 'Self-service plans, or a quote for contract and government procurement.', href: (o) => `/o/${o}/billing` },
  project: { title: 'Create the first monitoring project', hint: 'A project groups queries, sources, alerts and reports.', href: (o) => `/o/${o}/projects` },
  keywords: { title: 'Configure keywords and topics', hint: 'Add monitoring queries to a project.', href: (o) => `/o/${o}/monitoring` },
  sources: { title: 'Connect authorized sources', hint: 'Enable at least one authorized news feed or connector.', href: (o) => `/o/${o}/sources` },
  alerts: { title: 'Configure alerts', hint: 'Create an alert rule for a project.', href: (o) => `/o/${o}/alerts` },
  report_template: { title: 'Choose a report template', hint: 'Create a report definition.', href: (o) => `/o/${o}/reports` },
  usage_review: { title: 'Review usage allowances', hint: 'Check your plan limits and current usage.', href: (o) => `/o/${o}/billing` },
};

/** UI hints only. The API enforces every permission server-side. */
export const canBilling = {
  read: (r: Role) => r === 'owner' || r === 'admin',
  manage: (r: Role) => r === 'owner',
  onboardingEdit: (r: Role) => r === 'owner' || r === 'admin',
};
