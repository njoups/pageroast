import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';
import { seesAllProjects } from '../authz/permissions';
import type { AuthContext, TenantContext } from '../common/request';
import { SENTIMENT_LABELS } from './schemas';

export class AnalyticsFilter {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @Matches(/^(custom:)?[a-z_0-9]{2,40}$/) topic?: string;
  @IsOptional() @IsIn(SENTIMENT_LABELS as unknown as string[]) sentiment?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn(['published', 'discovered']) dateField?: 'published' | 'discovered';
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) includeUncertain?: boolean;
}

export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

/**
 * Visibility + filter conditions over `mentions m`, shared by every analysis/analytics endpoint so they apply the same
 * project-level access rules as mention search: owners/admins see all; other roles only mentions matched to projects
 * they are assigned to. All values are bound parameters.
 */
export function mentionConditions(p: Params, auth: AuthContext, t: TenantContext, f: AnalyticsFilter = {}): string[] {
  const w: string[] = [`m.duplicate_status = 'original'`];
  if (!seesAllProjects(t.role)) {
    w.push(`EXISTS (SELECT 1 FROM mention_matches mm JOIN project_members pm ON pm.project_id = mm.project_id AND pm.user_id = ${p.add(auth.userId)}
      WHERE mm.mention_id = m.id ${f.projectId ? `AND mm.project_id = ${p.add(f.projectId)}` : ''})`);
  } else if (f.projectId) {
    w.push(`EXISTS (SELECT 1 FROM mention_matches mm WHERE mm.mention_id = m.id AND mm.project_id = ${p.add(f.projectId)})`);
  }
  if (f.sourceId) w.push(`m.source_id = ${p.add(f.sourceId)}`);
  const col = f.dateField === 'published' ? 'm.published_at' : 'coalesce(m.published_at, m.discovered_at)';
  if (f.from) w.push(`${col} >= ${p.add(f.from)}::timestamptz`);
  if (f.to) w.push(`${col} <= ${p.add(f.to)}::timestamptz`);
  if (f.topic) w.push(`EXISTS (SELECT 1 FROM mention_topics mt WHERE mt.mention_id = m.id AND mt.analysis_id = m.analysis_id AND mt.topic_key = ${p.add(f.topic)})`);
  if (f.entityId) w.push(`EXISTS (SELECT 1 FROM mention_entities me WHERE me.mention_id = m.id AND me.analysis_id = m.analysis_id AND me.entity_id = ${p.add(f.entityId)})`);
  if (f.sentiment) w.push(`EXISTS (SELECT 1 FROM sentiment_results sr WHERE sr.mention_id = m.id AND sr.analysis_id = m.analysis_id AND sr.target_type = 'article' AND sr.label = ${p.add(f.sentiment)})`);
  return w;
}
