import { z } from 'zod';
import { isValidTimeZone } from '../analytics/tz';

export const TEMPLATE_KEYS = ['daily_briefing', 'weekly_intelligence', 'monthly_performance', 'issue_report', 'policy_monitoring'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

const uuid = z.string().uuid();

/** Report definition parameters (stored in report_definitions.params). Unknown keys are rejected. */
export const ReportParamsSchema = z.object({
  entityIds: z.array(uuid).max(10).default([]),          // share-of-voice group / policy programmes
  topic: z.string().regex(/^(custom:)?[a-z_0-9]{2,40}$/).nullable().default(null),
  sourceId: uuid.nullable().default(null),
  language: z.string().regex(/^[a-z]{2,3}$/).nullable().default(null),
  issueId: uuid.nullable().default(null),                // issue_report: focus one issue (else active issues in the period)
  maxSources: z.number().int().min(3).max(25).default(10),
  includeCsv: z.boolean().default(true),
  analystNote: z.string().trim().max(2000).nullable().default(null),
}).strict();
export type ReportParams = z.infer<typeof ReportParamsSchema>;

export const DefinitionSchema = z.object({
  projectId: uuid,
  template: z.enum(TEMPLATE_KEYS),
  name: z.string().trim().min(2).max(120),
  language: z.enum(['id', 'en']).default('id'),
  aiCommentary: z.boolean().default(false),
  params: ReportParamsSchema.prefault({}),
}).strict();

export const ScheduleSchema = z.object({
  definitionId: uuid,
  frequency: z.enum(['daily', 'weekly', 'monthly', 'custom']),
  timeOfDay: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).default('07:00'),
  dayOfWeek: z.number().int().min(1).max(7).nullable().default(null),
  dayOfMonth: z.number().int().min(1).max(28).nullable().default(null),
  periodDays: z.number().int().min(1).max(92).nullable().default(null),
  timezone: z.string().max(64).nullable().default(null),          // null → tenant timezone
  recipientUserIds: z.array(uuid).max(50).default([]),
  channels: z.array(z.enum(['in_app', 'email'])).min(1).max(2).default(['in_app']),
  isActive: z.boolean().default(true),
}).strict().superRefine((s, ctx) => {
  if (s.frequency === 'weekly' && s.dayOfWeek == null) ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: 'Weekly schedules need dayOfWeek (1 = Monday)' });
  if (s.frequency === 'monthly' && s.dayOfMonth == null) ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'Monthly schedules need dayOfMonth (1–28)' });
  if (s.frequency === 'custom' && s.periodDays == null) ctx.addIssue({ code: 'custom', path: ['periodDays'], message: 'Custom schedules need periodDays' });
  if (s.timezone && !isValidTimeZone(s.timezone)) ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Unknown time zone' });
});
export const SchedulePatchSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'custom']).optional(),
  timeOfDay: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  dayOfWeek: z.number().int().min(1).max(7).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  periodDays: z.number().int().min(1).max(92).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  recipientUserIds: z.array(uuid).max(50).optional(),
  channels: z.array(z.enum(['in_app', 'email'])).min(1).max(2).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const GenerateSchema = z.object({
  periodStart: z.string().datetime({ offset: true }).optional(),
  periodEnd: z.string().datetime({ offset: true }).optional(),
}).strict();

export function zodIssues(e: z.ZodError) { return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })); }
