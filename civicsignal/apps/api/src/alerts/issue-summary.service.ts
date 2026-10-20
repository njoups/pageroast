import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../database/database.service';
import { logEvent } from '../ingestion/log';
import { ANALYSIS_PROVIDER } from '../analysis/providers';
import type { AnalysisProvider } from '../analysis/providers/provider';
import { sanitizeMultiSummary } from '../analysis/schemas';
import { llmUnavailable, quotaState, recordAiUsage } from '../analysis/usage';
import { CLOCK, type Clock } from './clock';

const SYS = '00000000-0000-0000-0000-000000000000';

/**
 * Issue summary. With a generative provider: claims must cite the supplied records (sanitizeMultiSummary drops the
 * rest). Otherwise, or when the provider is unavailable: an extractive summary built only from stored headlines and
 * counts. Either way it is labelled with its method and never replaces the rule evaluation.
 */
@Injectable()
export class IssueSummaryService {
  constructor(private readonly db: Database, @Inject(ANALYSIS_PROVIDER) private readonly provider: AnalysisProvider, @Inject(CLOCK) private readonly clock: Clock) {}

  async generate(tenantId: string, issueId: string): Promise<{ method: string }> {
    const records = await this.db.withTenant(tenantId, SYS, async (c) => (await c.query<{ id: string; title: string; excerpt: string | null; publisher: string; published_at: Date | null; is_syndicated: boolean; language: string | null }>(
      `SELECT m.id, m.title, m.excerpt, coalesce(m.publisher, m.publisher_domain) AS publisher, m.published_at, e.is_syndicated, m.detected_language AS language
       FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id WHERE e.issue_id = $1
       ORDER BY e.is_syndicated, coalesce(m.published_at, m.discovered_at) DESC LIMIT 15`, [issueId])).rows);
    if (records.length === 0) return { method: 'none' };
    const total = await this.db.withTenant(tenantId, SYS, async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM alert_evidence WHERE issue_id = $1', [issueId])).rows[0]!.n);
    const now = this.clock.now();
    let summary: Record<string, unknown> | null = null;
    const quota = this.provider.method !== 'baseline' ? await this.db.withTenant(tenantId, SYS, (c) => quotaState(c)) : null;
    if (quota && !llmUnavailable(quota)) {
      try {
        const refs = new Map(records.map((r, i) => [`R${i + 1}`, r.id]));
        const res = await this.provider.summarize({ scope: 'issue', language: records[0]!.language === 'en' ? 'en' : 'id',
          records: records.map((r, i) => ({ ref: `R${i + 1}`, publisher: r.publisher, published: r.published_at?.toISOString() ?? null, title: r.title, excerpt: r.excerpt, syndicated: r.is_syndicated })) });
        if (res) {
          const s = sanitizeMultiSummary(res.output, refs, new Map(records.map((r) => [r.id, `${r.title}\n${r.excerpt ?? ''}`])));
          summary = { method: 'llm', provider: this.provider.name, model: res.model, promptVersion: res.promptVersion, status: s.status, headline: s.headline,
            claims: s.claims, conflicts: s.conflicts, uncertainty: s.uncertainty, generatedAt: now.toISOString() };
          await this.db.withTenant(tenantId, SYS, (c) => recordAiUsage(c, tenantId, this.provider.name, res.model, 'issue-summary', res.usage, {}));
        }
      } catch (e) {
        logEvent('warn', 'alerts.summary_provider_failed', { tenantId, issueId, message: (e as Error).message.slice(0, 200) });
      }
    }
    if (!summary) {
      const independent = new Set(records.filter((r) => !r.is_syndicated).map((r) => r.publisher)).size;
      summary = { method: 'extractive', provider: null, model: null, status: 'ready', headline: null, generatedAt: now.toISOString(),
        claims: [
          { kind: 'data', text: `${total} supporting record(s); the ${records.length} most recent come from ${independent} independent publisher(s).`, supportingMentionIds: records.map((r) => r.id) },
          ...records.filter((r) => !r.is_syndicated).slice(0, 5).map((r) => ({ kind: 'source_fact', text: `${r.publisher}: “${r.title}”`, supportingMentionIds: [r.id] })),
        ],
        conflicts: [], uncertainty: ['Extractive summary: headlines as published, not verified.'] };
    }
    await this.db.withTenant(tenantId, SYS, async (c) => {
      await c.query('UPDATE detected_issues SET ai_summary = $2 WHERE id = $1', [issueId, JSON.stringify(summary)]);
      await c.query(`INSERT INTO alert_events (tenant_id, issue_id, event, details, at) VALUES ($1,$2,'summary_generated',$3,$4)`,
        [tenantId, issueId, JSON.stringify({ method: summary!.method }), now]);
    });
    return { method: String(summary.method) };
  }
}
