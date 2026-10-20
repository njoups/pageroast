import type { lookup, LookupAddress } from 'node:dns';
import { gzipSync } from 'node:zlib';
import { isBlockedAddress } from '../../src/ingestion/ip-policy';
import { SafeHttpClient } from '../../src/ingestion/safe-http';
import { FeedServer } from './feed-server';

describe('SafeHttpClient against a real local server', () => {
  let srv: FeedServer;
  beforeAll(async () => {
    srv = await new FeedServer().start();
    srv.route('/ok', (_q, r) => r.end('hello'))
      .route('/big', (_q, r) => { r.write('x'.repeat(2048)); r.end(); })
      .route('/slow', () => undefined)                                     // never answers
      .route('/loop', (_q, r) => { r.statusCode = 302; r.setHeader('location', '/loop'); r.end(); })
      .route('/to-metadata', (_q, r) => { r.statusCode = 302; r.setHeader('location', 'http://169.254.169.254/latest/meta-data/'); r.end(); })
      .route('/to-internal', (_q, r) => { r.statusCode = 301; r.setHeader('location', `http://internal.test:${srv.port}/ok`); r.end(); })
      .route('/gzip', (_q, r) => { r.setHeader('content-encoding', 'gzip'); r.end(gzipSync('compressed body')); })
      .route('/to-other-origin', (_q, r) => { r.statusCode = 302; r.setHeader('location', `http://localhost:${srv.port}/ok`); r.end(); })
      .route('/same-origin-hop', (_q, r) => { r.statusCode = 302; r.setHeader('location', '/ok'); r.end(); })
      .route('/bad-location', (_q, r) => { r.statusCode = 302; r.setHeader('location', 'http://['); r.end(); });
  });
  afterAll(() => srv.close());

  const base = { userAgent: 'test', allowPrivateHosts: true, timeoutMs: 1500, maxBytes: 1024, maxRedirects: 3 };

  it('fetches, decompresses and identifies itself', async () => {
    const http = new SafeHttpClient(base);
    expect((await http.get(srv.url('/ok'))).body.toString()).toBe('hello');
    expect((await http.get(srv.url('/gzip'))).body.toString()).toBe('compressed body');
    expect(srv.hits.at(-1)!.headers['user-agent']).toBe('test');
  });

  it('QA-IN-02: credential headers never follow a redirect to another origin; same-origin hops keep them', async () => {
    const http = new SafeHttpClient(base);
    await http.get(srv.url('/to-other-origin'), { 'x-goog-api-key': 'SECRET-KEY', accept: 'application/xml', 'if-none-match': 'W/"1"' });
    const hop = srv.hits.at(-1)!;
    expect(hop.headers['x-goog-api-key']).toBeUndefined();
    expect(hop.headers['if-none-match']).toBeUndefined();
    expect(hop.headers.accept).toBe('application/xml');
    await http.get(srv.url('/same-origin-hop'), { 'x-goog-api-key': 'SECRET-KEY' });
    expect(srv.hits.at(-1)!.headers['x-goog-api-key']).toBe('SECRET-KEY');
  });

  it('QA-IN-07: an invalid redirect Location is a non-retryable redirect error, not a network error', async () => {
    await expect(new SafeHttpClient(base).get(srv.url('/bad-location'))).rejects.toMatchObject({ kind: 'redirect' });
  });

  it('enforces size limit, timeout and redirect limit', async () => {
    const http = new SafeHttpClient(base);
    await expect(http.get(srv.url('/big'))).rejects.toMatchObject({ kind: 'too_large' });
    await expect(http.get(srv.url('/slow'))).rejects.toMatchObject({ kind: 'timeout' });
    await expect(http.get(srv.url('/loop'))).rejects.toMatchObject({ kind: 'redirect' });
  });

  describe('SSRF protections (private hosts NOT allowed)', () => {
    const resolver = ((host: string, _o: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => {
      const map: Record<string, string> = { 'public.test': '127.0.0.1', 'internal.test': '10.0.0.5', 'rebind.test': '169.254.169.254' };
      if (map[host]) cb(null, [{ address: map[host]!, family: 4 }]);
      else cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    }) as unknown as typeof lookup;
    // Treat the test server's 127.0.0.1 as "public" so the first hop connects; everything else uses the real policy.
    const policy = (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip);
    const strict = new SafeHttpClient({ ...base, allowPrivateHosts: false, resolver, addressPolicy: policy, allowAnyPort: true });

    it('connects to an allowed resolved address', async () => {
      expect((await strict.get(`http://public.test:${srv.port}/ok`)).body.toString()).toBe('hello');
    });
    it('blocks a hostname resolving to a private or metadata address (checked at connect time)', async () => {
      await expect(strict.get(`http://internal.test:${srv.port}/ok`)).rejects.toMatchObject({ kind: 'unsafe' });
      await expect(strict.get('http://rebind.test/latest/meta-data/')).rejects.toMatchObject({ kind: 'unsafe' });
    });
    it('blocks redirects into private networks and metadata endpoints', async () => {
      await expect(strict.get(`http://public.test:${srv.port}/to-internal`)).rejects.toMatchObject({ kind: 'unsafe' });
      await expect(strict.get(`http://public.test:${srv.port}/to-metadata`)).rejects.toMatchObject({ kind: 'unsafe' });
    });
    it('blocks IP literals and non-http schemes without any DNS lookup', async () => {
      const real = new SafeHttpClient({ ...base, allowPrivateHosts: false });
      for (const u of [srv.url('/ok'), 'http://[::1]/', 'http://169.254.169.254/', 'file:///etc/passwd', 'http://localhost/']) {
        await expect(real.get(u)).rejects.toMatchObject({ kind: 'unsafe' });
      }
    });
  });
});
