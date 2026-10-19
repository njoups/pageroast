import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpFetchError, SafeHttpClient } from '../../ingestion/safe-http';
import { assertFetchableUrl } from '../../ingestion/url';
import { DeliveryError } from './errors';

export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

/**
 * Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. During a secret rotation a second v1
 * value signed with the previous secret is added, so receivers can switch keys without missing deliveries.
 */
export function signWebhook(body: string, secrets: string[], t: number): string {
  return [`t=${t}`, ...secrets.map((s) => `v1=${createHmac('sha256', s).update(`${t}.${body}`).digest('hex')}`)].join(',');
}

/** Reference verifier (also used in tests and documented for receivers). Rejects stale timestamps (replay). */
export function verifyWebhookSignature(header: string, body: string, secret: string, nowSec: number, toleranceSec = 300): boolean {
  const pairs = header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const; });
  const t = Number(pairs.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  return pairs.filter(([k]) => k === 'v1').some(([, v]) => { const b = Buffer.from(v); return b.length === expected.length && timingSafeEqual(b, expected); });
}

/** HTTPS only (HTTP allowed only by the test-only config flag); same SSRF policy as connectors, re-checked at send time. */
export function assertWebhookUrl(url: string, opts: { allowHttp: boolean; allowPrivateHosts: boolean }): URL {
  const u = assertFetchableUrl(url, { allowPrivateHosts: opts.allowPrivateHosts, allowAnyPort: opts.allowPrivateHosts });
  if (u.protocol !== 'https:' && !opts.allowHttp) throw new Error('Webhook URLs must use https');
  if (u.username || u.password) throw new Error('Webhook URLs must not contain credentials');
  return u;
}

export interface WebhookResult { status: number; durationMs: number; body: string }

export class WebhookSender {
  constructor(private readonly http: SafeHttpClient) {}

  async send(url: string, body: string, secrets: string[], headers: Record<string, string>, nowSec: number): Promise<WebhookResult> {
    const started = Date.now();
    let res;
    try {
      res = await this.http.post(url, body, { ...headers, 'x-civicsignal-signature': signWebhook(body, secrets, nowSec), 'user-agent': 'CivicSignal-Webhooks/1' });
    } catch (e) {
      const kind = e instanceof HttpFetchError ? e.kind : 'network';
      throw new DeliveryError(kind !== 'unsafe', `${kind}: ${(e as Error).message}`.slice(0, 300));
    }
    const durationMs = Date.now() - started;
    const text = res.body.toString('utf8').slice(0, 2000);
    if (res.status >= 300 && res.status < 400) throw new DeliveryError(false, `Receiver redirected (HTTP ${res.status}); redirects are not followed`, res.status);
    if (res.status < 200 || res.status >= 300) throw new DeliveryError(res.status === 408 || res.status === 429 || res.status >= 500, `Receiver answered HTTP ${res.status}`, res.status);
    return { status: res.status, durationMs, body: text };
  }
}
