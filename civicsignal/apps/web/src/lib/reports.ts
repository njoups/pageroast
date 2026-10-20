import type { Role } from './api';

export type TemplateKey = 'daily_briefing' | 'weekly_intelligence' | 'monthly_performance' | 'issue_report' | 'policy_monitoring';
export const TEMPLATE_LABEL: Record<TemplateKey, string> = {
  daily_briefing: 'Daily Media Briefing', weekly_intelligence: 'Weekly Media Intelligence', monthly_performance: 'Monthly Communications Performance',
  issue_report: 'Issue & Crisis Report', policy_monitoring: 'Policy & Public Program Monitoring',
};
export interface Template { key: TemplateKey; defaultFrequency: string; defaultPeriodDays: number; description: string }
export interface Definition {
  id: string; projectId: string; projectName: string | null; template: TemplateKey; name: string; language: 'id' | 'en'; aiCommentary: boolean;
  params: { entityIds: string[]; topic: string | null; sourceId: string | null; language: string | null; issueId: string | null; maxSources: number; includeCsv: boolean; analystNote: string | null };
  createdAt: string; updatedAt: string; lastRun?: { id: string; status: RunStatus; period_start: string; period_end: string; finished_at: string | null } | null; activeSchedules?: number;
}
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface RunListItem {
  id: string; definition_id: string; name: string; template: TemplateKey; trigger: 'manual' | 'schedule'; status: RunStatus; period_start: string; period_end: string; timezone: string;
  error: string | null; ai_method: string | null; queued_at: string; finished_at: string | null; artifacts: Array<{ format: 'pdf' | 'csv'; sizeBytes: number; expiresAt: string; expired: boolean }> | null;
}
export interface Schedule {
  id: string; definitionId: string; definitionName?: string; template?: TemplateKey; frequency: 'daily' | 'weekly' | 'monthly' | 'custom'; timeOfDay: string; dayOfWeek: number | null;
  dayOfMonth: number | null; periodDays: number | null; timezone: string; recipientUserIds: string[]; channels: string[]; isActive: boolean; nextRunAt: string;
  lastRunAt: string | null; consecutiveFailures: number; cancelledAt: string | null;
}
export const RUN_STATUS_LABEL: Record<RunStatus, string> = { queued: 'Queued', running: 'Generating', succeeded: 'Ready', failed: 'Failed', cancelled: 'Cancelled' };
export const RUN_STATUS_TONE: Record<RunStatus, 'slate' | 'blue' | 'green' | 'red' | 'amber'> = { queued: 'slate', running: 'blue', succeeded: 'green', failed: 'red', cancelled: 'amber' };
export const KIND_LABEL: Record<string, string> = {
  metric: 'Calculated metric', source_fact: 'Source fact', ai_interpretation: 'AI interpretation', analyst_recommendation: 'Analyst recommendation', note: 'Note',
};
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** UI hints only; the API enforces permissions. */
export const canReports = {
  generate: (r: Role) => r !== 'report_viewer',
};

export function describeSchedule(s: Pick<Schedule, 'frequency' | 'timeOfDay' | 'dayOfWeek' | 'dayOfMonth' | 'periodDays' | 'timezone'>): string {
  const at = `at ${s.timeOfDay} ${s.timezone}`;
  if (s.frequency === 'daily') return `Daily ${at}, covering the previous day`;
  if (s.frequency === 'weekly') return `Every ${WEEKDAYS[(s.dayOfWeek ?? 1) - 1]} ${at}, covering the previous Monday–Sunday week`;
  if (s.frequency === 'monthly') return `Monthly on day ${s.dayOfMonth ?? 1} ${at}, covering the previous calendar month`;
  return `Every ${s.periodDays} day(s) ${at}, covering the last ${s.periodDays} day(s)`;
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
