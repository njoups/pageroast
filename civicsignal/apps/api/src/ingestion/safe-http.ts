import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isBlockedAddress } from './ip-policy';
import { assertFetchableUrl, redactUrl, UnsafeUrlError } from './url';

export interface SafeHttpOptions {
  userAgent: string;
  allowPrivateHosts: boolean;       // tests only; refused in production by config
  timeoutMs: number;                // whole request including body
  maxBytes: number;                 // after decompression
  maxRedirects: number;
  /** Test seams (never set from configuration): DNS resolver, address policy, and permitting non-standard ports. */
  resolver?: typeof dnsLookup;
  addressPolicy?: (address: string) => boolean;
  allowAnyPort?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

export class HttpFetchError extends Error {
  constructor(readonly kind: 'network' | 'timeout' | 'too_large' | 'unsafe' | 'redirect', message: string) { super(message); this.name = 'HttpFetchError'; }
}

/**
 * HTTP client for connectors. SSRF defence is enforced in the socket's DNS lookup, so the address that is checked is
 * exactly the address connected to (no time-of-check/time-of-use gap, no DNS-rebinding window), and it is re-applied on
 * every redirect hop. Never sends cookies; never follows more than `maxRedirects` redirects.
 */
export class SafeHttpClient {
  constructor(private readonly opts: SafeHttpOptions) {}

  private guardedLookup: LookupFunction = (hostname, options, callback) => {
    (this.opts.resolver ?? dnsLookup)(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return (callback as (e: Error) => void)(err);
      const list = addresses as unknown as LookupAddress[];
      const blocked = this.opts.addressPolicy ?? isBlockedAddress;
      if (!this.opts.allowPrivateHosts && (list.length === 0 || list.some((a) => blocked(a.address)))) {
        return (callback as (e: Error) => void)(new UnsafeUrlError(`Destination ${hostname} resolves to a disallowed address`));
      }
      if ((options as { all?: boolean }).all) return (callback as (e: null, a: LookupAddress[]) => void)(null, list);
      const first = list[0]!;
      (callback as (e: null, a: string, f: number) => void)(null, first.address, first.family);
    });
  };

  async get(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<SafeResponse> {
    const deadline = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let current = url;
    for (let hop = 0; hop <= this.opts.maxRedirects; hop++) {
      let target: URL;
      try { target = assertFetchableUrl(current, { allowPrivateHosts: this.opts.allowPrivateHosts, allowAnyPort: this.opts.allowAnyPort }); }
      catch (e) { throw new HttpFetchError('unsafe', (e as Error).message); }
      const res = await this.once(target, headers, combined);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        current = new URL(res.headers.location, target).toString();
        continue;
      }
      return { ...res, finalUrl: target.toString() };
    }
    throw new HttpFetchError('redirect', `Too many redirects (max ${this.opts.maxRedirects})`);
  }

  private once(target: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Omit<SafeResponse, 'finalUrl'>> {
    return new Promise((resolve, reject) => {
      const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'GET',
        lookup: this.guardedLookup,
        agent: false, // one connection per request: no pooled sockets outlive a collection run
        signal,
        headers: { 'user-agent': this.opts.userAgent, 'accept-encoding': 'gzip, deflate, br', accept: '*/*', ...headers },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { res.resume(); return resolve({ status, headers: res.headers, body: Buffer.alloc(0) }); }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > this.opts.maxBytes) { res.destroy(); return reject(new HttpFetchError('too_large', `Response exceeds ${this.opts.maxBytes} bytes`)); }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(createGunzip()) : enc === 'deflate' ? res.pipe(createInflate()) : enc === 'br' ? res.pipe(createBrotliDecompress()) : res;
        const chunks: Buffer[] = []; let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > this.opts.maxBytes) { res.destroy(); stream.destroy(); reject(new HttpFetchError('too_large', `Response exceeds ${this.opts.maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on('error', (e) => reject(new HttpFetchError('network', `Body read failed: ${e.message}`)));
      });
      req.on('error', (e: Error & { code?: string }) => {
        if (e instanceof UnsafeUrlError) return reject(new HttpFetchError('unsafe', e.message));
        if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return reject(new HttpFetchError('timeout', `Request to ${redactUrl(target.toString())} timed out`));
        reject(new HttpFetchError('network', `${e.code ?? 'error'} contacting ${redactUrl(target.toString())}`));
      });
      req.end();
    });
  }
}
