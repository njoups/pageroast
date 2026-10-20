/**
 * Redaction for logs and error messages: credentials embedded in URLs (scheme://user:pass@host), bearer tokens,
 * and values under credential-like keys never reach log output.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_PARAM = /([?&](?:api[_-]?key|key|token|access_token|secret|password|sig|signature)=)[^&\s#]+/gi;
const SENSITIVE_KEY = /password|passwd|secret|api_?key|authorization|cookie|ciphertext|credential|token$|smtp_?url|database_?url|redis_?url/i;

export function redactString(s: string): string {
  return s.replace(URL_CREDENTIALS, '$1[redacted]@').replace(BEARER, '$1 [redacted]').replace(SECRET_PARAM, '$1[redacted]');
}

export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redactString(v);
  if (depth > 5 || v === null || typeof v !== 'object') return v;
  if (v instanceof Error) return redactString(v.message);
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE_KEY.test(k.replace(/-/g, '_')) ? '[redacted]' : redact(x, depth + 1)]));
}
