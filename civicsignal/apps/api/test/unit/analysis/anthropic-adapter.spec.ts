/**
 * The Anthropic adapter against a MOCKED HTTP layer (injected fetch). No request leaves the process and nothing here
 * is evidence that live analysis works; it checks request shape, response parsing and error classification.
 */
import { AnthropicProvider } from '../../../src/analysis/providers/anthropic.provider';
import { ProviderError } from '../../../src/analysis/providers/provider';
import { analyzeBaseline } from '../../../src/analysis/baseline';

const input = { title: 'Banjir rendam Bekasi', excerpt: null, body: null, publisher: 'example', language: 'id', customTopics: [] };
const good = analyzeBaseline(input);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely
type Loose = any;

function provider(handler: (req: { url: string; body: Loose; headers: Headers }) => Response | Promise<Response>, refusalFallback = true) {
  const calls: Array<{ url: string; body: Loose; headers: Headers }> = [];
  // Like real fetch, the mock rejects when the SDK aborts the request on timeout.
  const fetch = (async (url: string, init: RequestInit) => {
    const req = { url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers as ConstructorParameters<typeof Headers>[0]) };
    calls.push(req);
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      Promise.resolve().then(() => handler(req)).then(resolve, reject);
    });
  }) as unknown as typeof globalThis.fetch;
  return { p: new AnthropicProvider({ apiKey: 'test-key-not-real', model: 'model-under-test', effort: 'low', timeoutMs: 2000, baseURL: 'http://mock.invalid', refusalFallback, fetch }), calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const message = (text: string, stop_reason = 'end_turn') => json(200, {
  id: 'msg_mock', type: 'message', role: 'assistant', model: 'model-under-test', stop_reason, stop_sequence: null,
  content: [{ type: 'text', text }], usage: { input_tokens: 1234, output_tokens: 321, cache_read_input_tokens: 1000 },
});
const err = (status: number, type: string, headers: Record<string, string> = {}) => json(status, { type: 'error', error: { type, message: 'mock' } }, headers);
const kind = async (pr: Promise<unknown>) => { try { await pr; return 'resolved'; } catch (e) { return (e as ProviderError).kind; } };

describe('AnthropicProvider (mocked HTTP)', () => {
  it('sends a structured-output request with a cacheable system prompt and the refusal fallback, and parses the result', async () => {
    const { p, calls } = provider(() => message(JSON.stringify(good)));
    const r = await p.analyzeArticle(input);
    expect(r.output.sentiment.label).toBe(good.sentiment.label);
    expect(r.usage).toEqual({ inputTokens: 1234, outputTokens: 321, cacheReadTokens: 1000, cacheWriteTokens: 0 });
    expect(r.promptVersion).toBe('article-analysis@1');
    const req = calls[0]!;
    expect(req.url).toMatch(/^http:\/\/mock\.invalid\/v1\/messages/);
    expect(req.headers.get('x-api-key')).toBe('test-key-not-real');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.body).toMatchObject({ model: 'model-under-test', fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(req.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.body.messages[0].content).toContain('<source_document');
  });
  it('omits the fallback parameter and beta header when disabled', async () => {
    const { p, calls } = provider(() => message(JSON.stringify(good)), false);
    await p.analyzeArticle(input);
    expect(calls[0]!.body.fallbacks).toBeUndefined();
    expect(calls[0]!.headers.get('anthropic-beta')).toBeNull();
  });
  it('classifies refusal, truncation, malformed JSON and schema-invalid output', async () => {
    expect(await kind(provider(() => message('', 'refusal')).p.analyzeArticle(input))).toBe('refusal');
    // Truncation repeats with the same input, so it is a distinct, non-retryable kind (QA-AI-04).
    expect(await kind(provider(() => message('{"entities":[', 'max_tokens')).p.analyzeArticle(input))).toBe('truncated');
    expect(await kind(provider(() => message('{not json')).p.analyzeArticle(input))).toBe('invalid_output');
    // Rejected answers were still billed: the error carries the provider-reported usage so it can be recorded (QA-AI-04).
    const err = await provider(() => message('{"entities":[', 'max_tokens')).p.analyzeArticle(input).catch((e) => e);
    expect(err.opts.usage).toEqual({ inputTokens: 1234, outputTokens: 321, cacheReadTokens: 1000, cacheWriteTokens: 0 });
    expect(await kind(provider(() => message('{"entities": "nope"}')).p.analyzeArticle(input))).toBe('invalid_output');
  });
  it('maps HTTP errors to retryable / terminal kinds and keeps retry-after', async () => {
    const { p } = provider(() => err(429, 'rate_limit_error', { 'retry-after': '7' }));
    const e = await p.analyzeArticle(input).catch((x) => x as ProviderError);
    expect(e).toMatchObject({ kind: 'rate_limited', retryable: true, opts: { retryAfterMs: 7000 } });
    expect(await kind(provider(() => err(529, 'overloaded_error')).p.analyzeArticle(input))).toBe('server');
    expect(await kind(provider(() => err(500, 'api_error')).p.analyzeArticle(input))).toBe('server');
    expect(await kind(provider(() => err(401, 'authentication_error')).p.analyzeArticle(input))).toBe('auth');
    expect(await kind(provider(() => err(400, 'invalid_request_error')).p.analyzeArticle(input))).toBe('invalid_request');
    expect(await kind(provider(() => { throw new TypeError('fetch failed'); }).p.analyzeArticle(input))).toBe('network');
  });
  it('times out a hung request as a retryable timeout', async () => {
    const { p } = provider(() => new Promise<Response>(() => undefined));
    const e = await p.analyzeArticle(input).catch((x) => x as ProviderError);
    expect(e).toMatchObject({ kind: 'timeout', retryable: true });
  }, 10_000);
});
