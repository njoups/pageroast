import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { articleUserMessage, multiUserMessage, PROMPTS } from '../prompts';
import { ArticleAnalysisSchema, MultiSummarySchema, type ArticleAnalysis, type MultiSummary } from '../schemas';
import type { AnalysisProvider, ArticleInput, MultiInput, ProviderResult } from './provider';
import { ProviderError } from './provider';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  baseURL: string;
  /** Server-side refusal fallback (`fallbacks: "default"`, beta server-side-fallback-2026-07-01). */
  refusalFallback: boolean;
  fetch?: typeof fetch;   // injectable for tests (mocked HTTP; never a live call)
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Claude via the official SDK. Structured output (JSON schema generated from the Zod contract) validated locally with Zod. SDK retries are disabled so the
 * BullMQ job owns retry policy and accounting. All configuration (key, endpoint, model) comes from CivicSignal's own
 * config; ambient ANTHROPIC_* environment variables are never picked up implicitly.
 */
export class AnthropicProvider implements AnalysisProvider {
  readonly name = 'anthropic';
  readonly method = 'llm' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.client = new Anthropic({
      apiKey: opts.apiKey, authToken: null, baseURL: opts.baseURL, maxRetries: 0, timeout: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  private async call<T>(system: string, user: string, schema: Parameters<typeof zodOutputFormat>[0], maxTokens: number): Promise<{ parsed: T; usage: ProviderResult<T>['usage']; model: string }> {
    const format = zodOutputFormat(schema);
    const params = {
      model: this.opts.model,
      max_tokens: maxTokens,
      // The system prompt is identical across records, so it is marked cacheable.
      system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content: user }],
      output_config: { effort: this.opts.effort, format: { type: format.type, schema: format.schema } },
      ...(this.opts.refusalFallback ? { fallbacks: 'default' } : {}),
    };
    let res: Anthropic.Message;
    try {
      // messages.create rather than messages.parse: parse() throws on a refusal's empty body before stop_reason can be
      // inspected, which would turn a terminal refusal into a retryable error. Validation is done here instead.
      res = await this.client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming,
        this.opts.refusalFallback ? { headers: { 'anthropic-beta': FALLBACK_BETA } } : undefined);
    } catch (e) {
      throw mapError(e);
    }
    // The provider has answered: these tokens are billed whether or not the answer is usable, so every rejection below
    // carries the usage for the caller to record.
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0 };
    const spent = { usage, model: res.model };
    if (res.stop_reason === 'refusal') throw new ProviderError('refusal', 'The model declined to analyse this record', spent);
    // Truncation repeats on retry with the same input, so it is not retried (each attempt would spend max_tokens again).
    if (res.stop_reason === 'max_tokens') throw new ProviderError('truncated', 'Model output was truncated at max_tokens', spent);
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new ProviderError('invalid_output', 'AI provider returned malformed JSON', spent); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('invalid_output', 'Model output did not match the required schema', spent);
    return { parsed: parsed.data as T, usage, model: res.model };
  }

  async analyzeArticle(input: ArticleInput): Promise<ProviderResult<ArticleAnalysis>> {
    const r = await this.call<ArticleAnalysis>(PROMPTS.article.system, articleUserMessage(input), ArticleAnalysisSchema, 8000);
    return { output: r.parsed, usage: r.usage, model: r.model, promptVersion: PROMPTS.article.id };
  }

  async summarize(input: MultiInput): Promise<ProviderResult<MultiSummary>> {
    const r = await this.call<MultiSummary>(PROMPTS.multi.system, multiUserMessage(input.records, input.scope, input.language), MultiSummarySchema, 8000);
    return { output: r.parsed, usage: r.usage, model: r.model, promptVersion: PROMPTS.multi.id };
  }
}

/** Most-specific first, using the SDK's typed error classes (no message string matching). */
export function mapError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'AI provider request timed out');
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('network', 'Could not reach the AI provider');
  if (e instanceof Anthropic.RateLimitError) {
    const ra = Number(e.headers?.get('retry-after'));
    return new ProviderError('rate_limited', 'AI provider rate limit reached', { status: 429, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined });
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', 'AI provider rejected the credentials', { status: e.status });
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError('invalid_request', `AI provider rejected the request (HTTP ${e.status})`, { status: e.status });
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : 0;
    return new ProviderError(status >= 500 || status === 0 ? 'server' : 'invalid_request', `AI provider error (HTTP ${status})`, { status });
  }
  if (e instanceof SyntaxError || (e as { name?: string })?.name === 'ZodError') return new ProviderError('invalid_output', 'AI provider returned malformed structured output');
  if (e instanceof Anthropic.AnthropicError) return new ProviderError('invalid_output', 'AI provider response could not be processed');
  return new ProviderError('network', (e as Error)?.message ?? 'Unknown AI provider error');
}
