/** Shared vocabulary for issue severity and lifecycle. */
export const SEVERITIES = ['informational', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);
export const atLeast = (s: Severity, min: Severity): boolean => severityRank(s) >= severityRank(min);

export const STATUSES = ['detected', 'pending_review', 'acknowledged', 'investigating', 'resolved', 'closed'] as const;
export type IssueStatus = (typeof STATUSES)[number];
export const OPEN_STATUSES: IssueStatus[] = ['detected', 'pending_review', 'acknowledged', 'investigating'];

/** Allowed manual transitions. Detection itself moves detected → pending_review and resolved → pending_review (reopen). */
export const TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  detected: ['pending_review', 'acknowledged', 'investigating', 'resolved'],
  pending_review: ['acknowledged', 'investigating', 'resolved'],
  acknowledged: ['investigating', 'resolved'],
  investigating: ['resolved'],
  resolved: ['closed', 'pending_review'],
  closed: ['pending_review'],
};
export const canTransition = (from: IssueStatus, to: IssueStatus): boolean => TRANSITIONS[from].includes(to);
