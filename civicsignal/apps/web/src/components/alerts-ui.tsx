'use client';
import { SEVERITY_LABEL, SEVERITY_STYLE, STATUS_LABEL, type IssueStatus, type Severity } from '@/lib/alerts';

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${s.className}`}><span aria-hidden>{s.icon}</span>{SEVERITY_LABEL[severity]}</span>;
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  const cls = status === 'resolved' || status === 'closed' ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
    : status === 'pending_review' || status === 'detected' ? 'bg-white text-slate-800 border-slate-400' : 'bg-brand-50 text-brand-900 border-brand-100';
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${cls}`}>{STATUS_LABEL[status]}</span>;
}
