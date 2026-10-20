import { z } from 'zod';

export const SOCIAL_PERMITTED_FIELDS = ['title', 'url', 'published_at', 'excerpt', 'author', 'categories', 'metrics'] as const;

const fields = z.array(z.enum(SOCIAL_PERMITTED_FIELDS)).max(10)
  .refine((f) => f.includes('title') && f.includes('url'), 'permittedFields must include title and url (attribution requires them)');

export const CreateSocialConnectorSchema = z.object({
  provider: z.string().regex(/^[a-z_]{1,40}$/),
  name: z.string().trim().min(2).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
  authorizationStatus: z.enum(['unverified', 'authorized', 'restricted', 'revoked']).default('unverified'),
  authorizationBasis: z.string().trim().max(2000).nullable().optional(),
  permittedFields: fields.optional(),
  refreshIntervalSeconds: z.number().int().min(300).max(86_400).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();

export const UpdateSocialConnectorSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  authorizationStatus: z.enum(['unverified', 'authorized', 'restricted', 'revoked']).optional(),
  authorizationBasis: z.string().trim().max(2000).nullable().optional(),
  permittedFields: fields.optional(),
  refreshIntervalSeconds: z.number().int().min(300).max(86_400).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();

export const ApprovalSchema = z.object({
  approved: z.boolean(),
  reference: z.string().trim().min(3).max(500).optional(),
  note: z.string().trim().max(1000).optional(),
}).strict().refine((a) => !a.approved || !!a.reference, 'An approval needs a reference (e.g. the acceptance confirmation or audit ticket)');

export const BudgetSchema = z.object({
  connectorId: z.string().uuid().nullable().default(null),
  metric: z.enum(['quota_units', 'requests', 'records_retrieved', 'estimated_cost']),
  period: z.enum(['day', 'month']),
  warnAt: z.number().positive().nullable().default(null),
  softLimit: z.number().positive().nullable().default(null),
  hardLimit: z.number().positive().nullable().default(null),
}).strict()
  .refine((b) => b.warnAt !== null || b.softLimit !== null || b.hardLimit !== null, 'Set at least one of warnAt, softLimit, hardLimit')
  .refine((b) => b.softLimit === null || b.hardLimit === null || b.softLimit <= b.hardLimit, 'softLimit must not exceed hardLimit')
  .refine((b) => b.warnAt === null || b.softLimit === null || b.warnAt <= b.softLimit, 'warnAt must not exceed softLimit');

export type CreateSocialConnector = z.infer<typeof CreateSocialConnectorSchema>;
export type UpdateSocialConnector = z.infer<typeof UpdateSocialConnectorSchema>;
