import { loadConfig } from '../../../src/config';

const base = { DATABASE_URL: 'postgres://x@localhost/db', NODE_ENV: 'test' };

describe('AI configuration', () => {
  it('defaults to the rule-based baseline without a key, and empty variables count as unset (as Compose passes them)', () => {
    const c = loadConfig({ ...base, AI_PROVIDER: '', AI_MODEL: '', AI_EFFORT: '', ANTHROPIC_API_KEY: '' });
    expect(c.ai).toMatchObject({ provider: 'baseline', effort: 'low', anthropicApiKey: null, fallback: 'baseline', refusalFallback: true });
    expect(c.ai.model.length).toBeGreaterThan(0);
  });
  it('uses the Anthropic provider when a key is configured, with an explicit endpoint (ambient ANTHROPIC_BASE_URL ignored)', () => {
    const c = loadConfig({ ...base, ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://proxy.invalid', AI_MODEL: 'some-model' });
    expect(c.ai).toMatchObject({ provider: 'anthropic', model: 'some-model', anthropicBaseUrl: 'https://api.anthropic.com' });
  });
  it('refuses the test provider and a keyless Anthropic provider in production', () => {
    const prod = { ...base, NODE_ENV: 'production', MIGRATION_DATABASE_URL: 'postgres://o@localhost/db', APP_ORIGINS: 'https://app.example' };
    expect(() => loadConfig({ ...prod, AI_PROVIDER: 'test' })).toThrow(/test/);
    expect(() => loadConfig({ ...prod, AI_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it('rejects unknown providers and effort levels', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'other' })).toThrow();
    expect(() => loadConfig({ ...base, AI_EFFORT: 'extreme' })).toThrow();
  });
});
