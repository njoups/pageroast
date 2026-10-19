import { analyzeBaseline } from '../baseline';
import type { ArticleAnalysis, MultiSummary } from '../schemas';
import type { AnalysisProvider, ArticleInput, MultiInput, ProviderResult } from './provider';
import { ProviderError } from './provider';

type Script<I, O> = (input: I, call: number) => O | Error | Promise<O | Error>;

/**
 * Deterministic provider for automated tests. Its results are stored with method 'test' and model 'test-fixture' so they
 * can never be mistaken for live AI analysis; config refuses this provider in production.
 * Default behaviour mirrors the baseline analyzer with fixed token counts; tests replace scripts to simulate malformed
 * output, timeouts, refusals, injection attempts, etc.
 */
export class TestProvider implements AnalysisProvider {
  readonly name = 'test';
  readonly model = 'test-fixture';
  readonly method = 'test' as const;
  calls = { article: 0, summarize: 0 };
  articleScript: Script<ArticleInput, unknown> = (i) => analyzeBaseline(i);
  summaryScript: Script<MultiInput, unknown> = (i) => ({
    status: 'ok', headline: i.records[0]?.title ?? null,
    claims: i.records.slice(0, 3).map((r) => ({ text: `${r.publisher} reported: ${r.title}`, kind: 'source_fact', supportingRefs: [r.ref] })),
    conflicts: [], uncertainty: ['Test fixture output.'],
  } satisfies MultiSummary);

  reset() { this.calls = { article: 0, summarize: 0 }; this.articleScript = (i) => analyzeBaseline(i); }

  async analyzeArticle(input: ArticleInput): Promise<ProviderResult<ArticleAnalysis>> {
    const out = await this.articleScript(input, ++this.calls.article);
    if (out instanceof Error) throw out;
    // Simulates the structured-output parse step: unvalidated objects are rejected like a real malformed response.
    const { ArticleAnalysisSchema } = await import('../schemas');
    const parsed = ArticleAnalysisSchema.safeParse(out);
    if (!parsed.success) throw new ProviderError('invalid_output', `Test provider output failed schema validation: ${parsed.error.issues[0]?.message}`);
    return { output: parsed.data, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 }, model: this.model, promptVersion: 'article-analysis@1' };
  }

  async summarize(input: MultiInput): Promise<ProviderResult<MultiSummary> | null> {
    const out = await this.summaryScript(input, ++this.calls.summarize);
    if (out instanceof Error) throw out;
    const { MultiSummarySchema } = await import('../schemas');
    const parsed = MultiSummarySchema.safeParse(out);
    if (!parsed.success) throw new ProviderError('invalid_output', 'Test provider summary failed schema validation');
    return { output: parsed.data, usage: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 0 }, model: this.model, promptVersion: 'multi-summary@1' };
  }
}
