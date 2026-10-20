import type { CustomTopic } from '../taxonomy';
import type { ArticleAnalysis, MultiSummary } from '../schemas';

export type ProviderErrorKind = 'timeout' | 'network' | 'rate_limited' | 'server' | 'invalid_output'          // retryable
  | 'auth' | 'invalid_request' | 'refusal' | 'unconfigured' | 'truncated';                                       // not retryable

const RETRYABLE = new Set<ProviderErrorKind>(['timeout', 'network', 'rate_limited', 'server', 'invalid_output']);

export class ProviderError extends Error {
  /** `usage`/`model`: set when the provider answered (and billed) before the answer was rejected, so the spend is recorded. */
  constructor(readonly kind: ProviderErrorKind, message: string, readonly opts: { retryAfterMs?: number; status?: number; usage?: Usage; model?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable(): boolean { return RETRYABLE.has(this.kind); }
}

/** Provider-reported tokens. inputTokens excludes cache reads and cache writes (Anthropic convention); they are reported separately. */
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number }
export interface ProviderResult<T> { output: T; usage: Usage; model: string; promptVersion: string }

export interface ArticleInput {
  title: string; excerpt: string | null; body: string | null; publisher: string | null; language: string; customTopics: CustomTopic[];
  /** Kind of record; absent = news article. Social records are analysed as posts/comments, not as journalism. */
  record?: RecordKind;
}
export interface RecordKind { category: 'news' | 'social'; platform: string | null; contentType: string | null }
export interface MultiInput {
  scope: 'cluster' | 'project' | 'period' | 'issue'; language: string;
  records: Array<{ ref: string; publisher: string; published: string | null; title: string; excerpt: string | null; syndicated: boolean }>;
}

/**
 * Provider-independent contract. `method` is persisted with every result:
 *  - 'llm'      a language model (live provider)
 *  - 'baseline' the deterministic rule-based analyzer
 *  - 'test'     deterministic fixtures for automated tests only (refused in production)
 */
export interface AnalysisProvider {
  readonly name: string;
  readonly model: string;
  readonly method: 'llm' | 'baseline' | 'test';
  analyzeArticle(input: ArticleInput): Promise<ProviderResult<ArticleAnalysis>>;
  /** Multi-record summaries; providers without generative ability return null (extractive fallback is used). */
  summarize(input: MultiInput): Promise<ProviderResult<MultiSummary> | null>;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
