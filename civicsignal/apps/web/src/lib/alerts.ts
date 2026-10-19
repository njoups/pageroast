import type { Role } from './api';

export type Severity = 'informational' | 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'detected' | 'pending_review' | 'acknowledged' | 'investigating' | 'resolved' | 'closed';
export const SEVERITIES: Severity[] = ['informational', 'low', 'medium', 'high', 'critical'];
export const STATUSES: IssueStatus[] = ['detected', 'pending_review', 'acknowledged', 'investigating', 'resolved', 'closed'];

export const SEVERITY_LABEL: Record<Severity, string> = { informational: 'Informational', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
/** Reserved status colours (never reused for series), always paired with an icon and the label. */
export const SEVERITY_STYLE: Record<Severity, { icon: string; className: string; color: string }> = {
  critical: { icon: '▲', className: 'bg-[#d03b3b] text-white', color: '#d03b3b' },
  high: { icon: '◆', className: 'bg-[#ec835a] text-[#3b1404]', color: '#ec835a' },
  medium: { icon: '●', className: 'bg-[#fab219] text-[#3a2800]', color: '#fab219' },
  low: { icon: '○', className: 'bg-slate-200 text-slate-800', color: '#94a3b8' },
  informational: { icon: 'i', className: 'bg-slate-100 text-slate-600', color: '#cbd5e1' },
};
export const STATUS_LABEL: Record<IssueStatus, string> = {
  detected: 'Detected', pending_review: 'Pending review', acknowledged: 'Acknowledged', investigating: 'Investigating', resolved: 'Resolved', closed: 'Closed',
};
export const SIGNAL_LABEL: Record<string, string> = {
  volume_spike: 'Volume spike', negative_shift: 'Negative-tone shift', emerging_topic: 'Emerging topic', keyword: 'Critical keyword',
  story_velocity: 'Fast-developing story', source_concentration: 'Single-publisher concentration',
};
export const SCOPE_LABEL: Record<string, string> = { article: 'Single article', story: 'Related-story cluster', issue: 'Broader issue' };
export const RULE_HELP: Record<string, string> = {
  volume_spike: 'Records in the window compared with the median of comparable earlier windows (robust z-score and ratio).',
  negative_shift: 'Share of negative records among confident tone classifications, compared with earlier windows.',
  emerging_topic: 'Topics that were rare in earlier windows and now appear across several independent publishers.',
  keyword: 'Records matching a critical keyword expression (same syntax as monitoring queries).',
  story_velocity: 'A story cluster gaining coverage from several independent publishers within the window.',
  source_concentration: 'One publisher accounts for most of the window\'s coverage (repeated, not independent, reporting).',
};

export const canAlerts = {
  read: (r: Role) => r !== 'report_viewer',
  act: (r: Role) => r !== 'report_viewer',
  manage: (r: Role) => r === 'owner' || r === 'admin' || r === 'project_manager',
};

export function ago(s: string | null, now = Date.now()): string {
  if (!s) return '—';
  const m = Math.max(0, Math.round((now - new Date(s).getTime()) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export interface IssueListItem {
  id: string; project_id: string; project_name: string; rule_id: string; rule_name: string; rule_version: number; scope: string; signal: string; title: string;
  status: IssueStatus; severity: Severity; severity_points: number; first_detected_at: string; last_detected_at: string; occurrence_count: number;
  acknowledged_at: string | null; assigned_to: string | null; assigned_to_name: string | null; escalation_level: number; evidence_count: number;
  publisher_count: number; independent_publishers: number; related_count: number;
}
