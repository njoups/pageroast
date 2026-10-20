import { scrubMetadata } from '../../src/audit/audit.service';
import { redact, redactString } from '../../src/common/redact';
import { loadConfig } from '../../src/config';
import { metricsAuthorized } from '../../src/health/metrics';
import { MAX_MARKUP_CHARS, plainText } from '../../src/ingestion/feed-parser';
import { isBlockedAddress } from '../../src/ingestion/ip-policy';

const prodBase = {
  NODE_ENV: 'production', DATABASE_URL: 'postgres://app:x@db/cs', COOKIE_SECURE: 'true', REDIS_URL: 'redis://:p@redis:6379/0',
  APP_ENV: 'production', APP_ORIGINS: 'https://app.example.go.id', APP_BASE_URL: 'https://app.example.go.id', TRUST_PROXY: 'true',
};

describe('production configuration', () => {
  it('accepts a complete deployed configuration without the owner database credentials', () => {
    const c = loadConfig(prodBase);
    expect(c).toMatchObject({ appEnv: 'production', apiDocsEnabled: false, rateLimitEnabled: true, cookieSecure: true });
  });
  it.each([
    [{ COOKIE_SECURE: 'false' }, /COOKIE_SECURE/],
    [{ RATE_LIMIT_ENABLED: 'false' }, /RATE_LIMIT_ENABLED/],
    [{ REDIS_URL: '' }, /REDIS_URL/],
    [{ APP_ORIGINS: 'http://app.example.go.id' }, /APP_ORIGINS must use https/],
    [{ APP_BASE_URL: 'http://app.example.go.id' }, /APP_BASE_URL must use https/],
    [{ TRUST_PROXY: 'false' }, /TRUST_PROXY/],
    [{ MIGRATION_DATABASE_URL: 'postgres://app:x@db/cs' }, /must differ/],
    [{ AI_PROVIDER: 'test' }, /refused in production/],
    [{ INGESTION_ALLOW_PRIVATE_HOSTS: 'true' }, /refused in production/],
    [{ ALERTS_WEBHOOK_ALLOW_HTTP: 'true' }, /refused in production/],
    [{ CREDENTIALS_KEY: 'dG9vIHNob3J0' }, /CREDENTIALS_KEY/],
    [{ METRICS_TOKEN: 'short' }, /METRICS_TOKEN/],
    [{ SESSION_IDLE_SECONDS: '60' }, /SESSION_IDLE_SECONDS/],
    [{ APP_ENV: 'prod' }, /APP_ENV/],
    [{ YOUTUBE_API_BASE_URL: 'http://127.0.0.1:9/youtube/v3' }, /YOUTUBE_API_BASE_URL/],
  ])('refuses %j', (patch, err) => {
    expect(() => loadConfig({ ...prodBase, ...patch })).toThrow(err);
  });
  it('local Compose runs (APP_ENV=local) keep http://localhost but still refuse test-only switches', () => {
    expect(() => loadConfig({ ...prodBase, APP_ENV: 'local', APP_ORIGINS: 'http://localhost:3000', APP_BASE_URL: 'http://localhost:3000', TRUST_PROXY: 'false', REDIS_URL: '' })).not.toThrow();
    expect(() => loadConfig({ ...prodBase, APP_ENV: 'local', AI_PROVIDER: 'test' })).toThrow(/refused in production/);
  });
});

describe('log and audit redaction', () => {
  it('removes credentials from URLs, bearer tokens and secret query parameters', () => {
    expect(redactString('connect postgres://civicsignal_app:s3cret@db:5432/cs failed')).toBe('connect postgres://[redacted]@db:5432/cs failed');
    expect(redactString('smtp://user:pw@mail.example:587')).toBe('smtp://[redacted]@mail.example:587');
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]');
    expect(redactString('https://api.example/x?api_key=abc123&q=banjir')).toBe('https://api.example/x?api_key=[redacted]&q=banjir');
  });
  it('redacts credential-like keys at any depth but keeps counters', () => {
    expect(redact({ smtpUrl: 'smtp://a:b@c', nested: { accessToken: 't', tokensIn: 5 }, list: [{ password: 'p' }] }))
      .toEqual({ smtpUrl: '[redacted]', nested: { accessToken: '[redacted]', tokensIn: 5 }, list: [{ password: '[redacted]' }] });
    expect(scrubMetadata({ webhookSecret: 's', fields: ['name'], monthlyTokenLimit: 5 })).toEqual({ webhookSecret: '[redacted]', fields: ['name'], monthlyTokenLimit: 5 });
  });
});

describe('SSRF address policy (additions)', () => {
  it.each(['::127.0.0.1', '::a00:1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '64:ff9b:1::a00:1', 'fec0::1', '::', '::1', '169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe'])(
    'blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows public %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('resource limits', () => {
  it('bounds markup stripping on hostile feed text (linear time)', () => {
    const hostile = '<script'.repeat(400_000);                     // 2.8 M chars of unclosed tags
    const t0 = Date.now(); plainText(hostile); const ms = Date.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(MAX_MARKUP_CHARS).toBeLessThanOrEqual(200_000);
  });
  it('compares the metrics token in constant time and refuses when unset', () => {
    expect(metricsAuthorized('Bearer abc', 'abc')).toBe(true);
    expect(metricsAuthorized('Bearer abd', 'abc')).toBe(false);
    expect(metricsAuthorized('Bearer abc', null)).toBe(false);
    expect(metricsAuthorized(undefined, 'abc')).toBe(false);
  });
});
