import { isIP } from 'node:net';
import { isBlockedAddress } from './ip-policy';

export class UnsafeUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeUrlError'; }
}

const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|dclid|yclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|ref_src|cmpid)$/i;

/**
 * Static checks for a URL we are about to fetch. DNS-level checks happen at connect time in SafeHttpClient.
 * Only http/https, default or standard ports, no embedded credentials, no IP literal in a blocked range, no
 * single-label or *.localhost / *.internal hostnames.
 */
export function assertFetchableUrl(raw: string, opts: { allowPrivateHosts?: boolean; allowAnyPort?: boolean } = {}): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError('Not a valid absolute URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UnsafeUrlError('Only http and https URLs are allowed');
  if (u.username || u.password) throw new UnsafeUrlError('URLs must not contain credentials');
  if (raw.length > 2048) throw new UnsafeUrlError('URL is too long');
  if (opts.allowPrivateHosts) return u;
  if (u.port && !opts.allowAnyPort && !['80', '443'].includes(u.port)) throw new UnsafeUrlError('Only ports 80 and 443 are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError('Destination address is not allowed');
  } else if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)\.?$/.test(host)) {
    throw new UnsafeUrlError('Destination host is not allowed');
  }
  return u;
}

/**
 * Canonical form used for deduplication: lowercase scheme/host, default port dropped, fragment dropped, tracking
 * parameters removed, remaining parameters sorted, trailing slash removed (except the root path).
 * Hosts are NOT rewritten (www/amp variants can be different documents).
 */
export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

export function publisherDomain(canonicalUrl: string): string {
  return new URL(canonicalUrl).hostname.replace(/^www\./, '');
}

/** Removes query strings so URLs that may carry API keys never reach logs or stored error messages. */
export function redactUrl(raw: string): string {
  try { const u = new URL(raw); return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`; } catch { return '[invalid url]'; }
}
