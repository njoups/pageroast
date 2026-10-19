import { contentHash, decideDuplicate, normalizeTitle, titleSimilarity } from '../../../src/ingestion/dedup';
import { computeHealth } from '../../../src/ingestion/health';
import { backoffDelay } from '../../../src/ingestion/queue';
import { ConnectorError } from '../../../src/ingestion/connectors/connector';
import { CredentialCipher } from '../../../src/ingestion/secrets';

describe('deduplication', () => {
  const opts = { similarityThreshold: 0.9, minTokens: 5 };
  const rec = (title: string, domain = 'news.example', excerpt: string | null = null) => ({ publisherDomain: domain, normalizedTitle: normalizeTitle(title), contentHash: contentHash(title, excerpt) });
  const cand = (id: string, title: string, domain = 'news.example', excerpt: string | null = null) => ({ id, ...rec(title, domain, excerpt) });

  it('flags identical content from the same publisher', () => {
    expect(decideDuplicate(rec('Banjir di Kota', 'news.example', 'x'), [cand('a', 'Banjir di Kota', 'news.example', 'x')], opts)).toEqual({ status: 'duplicate', duplicateOf: 'a', reason: 'content_hash' });
  });
  it('flags same publisher + same headline even with a different excerpt', () => {
    expect(decideDuplicate(rec('Banjir di Kota!', 'news.example', 'new'), [cand('a', 'banjir di kota', 'news.example', 'old')], opts).reason).toBe('publisher_headline');
  });
  it('never merges different publishers, even with identical wire copy', () => {
    expect(decideDuplicate(rec('Banjir di Kota', 'b.example', 'x'), [cand('a', 'Banjir di Kota', 'a.example', 'x')], opts).status).toBe('original');
  });
  it('marks near-identical long headlines from one publisher as near duplicates', () => {
    // 10 of 11 distinct words shared (Jaccard 0.91 ≥ 0.9)
    const d = decideDuplicate(rec('Presiden resmikan bendungan baru Karian di Lebak Banten pada Senin pagi'),
      [cand('a', 'Presiden resmikan bendungan baru Karian di Lebak Banten pada Senin')], opts);
    expect(d).toMatchObject({ status: 'near_duplicate', duplicateOf: 'a', reason: 'title_similarity:0.91' });
    // 7 of 9 (0.78) is a related story, not a duplicate
    expect(decideDuplicate(rec('Presiden resmikan bendungan baru di Jawa Tengah hari ini'), [cand('a', 'Presiden resmikan bendungan baru di Jawa Tengah')], opts).status).toBe('original');
  });
  it('does not merge unrelated stories sharing keywords', () => {
    expect(decideDuplicate(rec('Banjir rendam Jakarta Utara pagi ini'), [cand('a', 'Banjir bandang landa Garut, warga mengungsi')], opts).status).toBe('original');
    // Short generic headlines are only merged when exactly equal, never by similarity
    expect(decideDuplicate(rec('Live update'), [cand('a', 'Live update!')], opts).status).toBe('duplicate');
    expect(decideDuplicate(rec('Live update sore'), [cand('a', 'Live update pagi')], { ...opts, similarityThreshold: 0.1 }).status).toBe('original');
    expect(titleSimilarity('a b c', 'd e f')).toBe(0);
  });
  it('similarity detection can be switched off', () => {
    expect(decideDuplicate(rec('Presiden resmikan bendungan baru Karian di Lebak Banten pada Senin pagi'), [cand('a', 'Presiden resmikan bendungan baru Karian di Lebak Banten pada Senin')], { ...opts, similarityThreshold: 0 }).status).toBe('original');
  });
});

describe('source health transitions', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const base = { enabled: true, lastAttemptAt: now, lastSuccessAt: now, consecutiveFailures: 0, lastErrorKind: null, refreshIntervalSeconds: 3600, now };
  it.each([
    ['configured but never run', { lastAttemptAt: null, lastSuccessAt: null }, 'unknown'],
    ['disabled', { enabled: false }, 'disabled'],
    ['fresh success', {}, 'healthy'],
    ['one transient failure', { consecutiveFailures: 1, lastErrorKind: 'timeout' }, 'degraded'],
    ['three failures', { consecutiveFailures: 3, lastErrorKind: 'timeout' }, 'failing'],
    ['credential failure', { consecutiveFailures: 1, lastErrorKind: 'auth' }, 'failing'],
    ['stale (no success for > 3 intervals)', { lastSuccessAt: new Date(now.getTime() - 4 * 3600 * 1000) }, 'degraded'],
    ['attempted, never succeeded', { lastSuccessAt: null }, 'degraded'],
  ])('%s', (_name, over, expected) => expect(computeHealth({ ...base, ...over })).toBe(expected));
});

describe('retry backoff', () => {
  it('grows exponentially with ±30% jitter and a 30-minute cap', () => {
    expect(backoffDelay(1, 1000, undefined, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, 1000, undefined, () => 0.5)).toBe(4000);
    expect(backoffDelay(3, 1000, undefined, () => 0)).toBe(2800);
    expect(backoffDelay(3, 1000, undefined, () => 1)).toBe(5200);
    expect(backoffDelay(30, 1000, undefined, () => 0.5)).toBe(30 * 60 * 1000);
  });
  it('honours provider Retry-After', () => {
    expect(backoffDelay(1, 1000, new ConnectorError('rate_limited', 'x', { retryAfterMs: 120_000 }), () => 0)).toBe(120_000);
  });
});

describe('credential encryption', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const cipher = CredentialCipher.fromBase64(key)!;
  it('round-trips and never stores plaintext', () => {
    const blob = cipher.encrypt('sk-live-1234567890', 'connector-a');
    expect(blob).not.toContain('1234567890');
    expect(cipher.decrypt(blob, 'connector-a')).toBe('sk-live-1234567890');
  });
  it('rejects ciphertext moved to another connector or tampered with', () => {
    const blob = cipher.encrypt('secret-value', 'connector-a');
    expect(() => cipher.decrypt(blob, 'connector-b')).toThrow();
    const parts = blob.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => cipher.decrypt(parts.join('.'), 'connector-a')).toThrow();
  });
  it('rejects keys of the wrong size and works without a key configured', () => {
    expect(() => CredentialCipher.fromBase64(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(CredentialCipher.fromBase64(undefined)).toBeNull();
  });
});
