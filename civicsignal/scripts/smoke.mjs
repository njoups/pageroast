#!/usr/bin/env node
// Post-deployment smoke test through the public edge. Read-only: it never creates, changes or deletes data, sends no
// messages and consumes no AI or provider quota. Exits 1 if any check fails.
//
//   BASE_URL=https://staging.example.go.id node scripts/smoke.mjs
//   BASE_URL=... SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/smoke.mjs     # adds signed-in checks
//
// SMOKE_EMAIL/SMOKE_PASSWORD belong to a dedicated smoke-test account in an internal (non-customer) organization,
// stored in the environment's secret manager. The password is never printed. Write-path checks (reports, alerts,
// billing simulator) are in the manual checklist in docs/DEPLOYMENT.md, because they create records.
//
// Optional: SMOKE_EXPECT_HTTPS=false only for a local http:// stack (APP_ENV=local); deployed environments must be https.

const BASE = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) { console.error('Set BASE_URL to the public base URL (https://...)'); process.exit(2); }
const expectHttps = process.env.SMOKE_EXPECT_HTTPS !== 'false';
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);

const results = [];
async function check(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''} [${Math.round(performance.now() - t0)} ms]`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const get = (path, init = {}) => fetch(`${BASE}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), ...init });

await check('web liveness /healthz', async () => {
  const r = await get('/healthz');
  assert(r.status === 200, `HTTP ${r.status}`);
  assert((await r.json()).status === 'ok', 'status is not ok');
});

await check('end-to-end readiness /readyz (web → API → database, Redis, migrations)', async () => {
  const r = await get('/readyz');
  const body = await r.json().catch(() => ({}));
  assert(r.status === 200 && body.status === 'ok', `HTTP ${r.status} ${body.status ?? ''}`);
  assert(Object.keys(body).length === 1, 'readiness must not expose component details publicly');
});

await check('login page and security headers', async () => {
  const r = await get('/login');
  assert(r.status === 200, `HTTP ${r.status}`);
  const h = r.headers;
  assert(/script-src[^;]*'nonce-/.test(h.get('content-security-policy') ?? ''), 'missing nonce-based Content-Security-Policy');
  assert(h.get('x-frame-options') === 'DENY', 'missing X-Frame-Options: DENY');
  assert(h.get('x-content-type-options') === 'nosniff', 'missing X-Content-Type-Options');
  assert(!h.get('x-powered-by'), 'X-Powered-By is exposed');
  if (expectHttps) assert(/max-age=\d{7,}/.test(h.get('strict-transport-security') ?? ''), 'missing HSTS (max-age >= 1 year expected)');
});

await check('deployed environments are served over https', async () => {
  if (!expectHttps) return 'skipped: SMOKE_EXPECT_HTTPS=false';
  assert(BASE.startsWith('https://'), 'BASE_URL is not https');
  const http = BASE.replace(/^https:/, 'http:');
  const r = await fetch(`${http}/login`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
  if (!r) return 'port 80 closed (acceptable)';
  assert([301, 302, 307, 308].includes(r.status) && (r.headers.get('location') ?? '').startsWith('https://'), `plain http answered ${r.status} without redirecting to https`);
});

for (const path of ['/metrics', '/health/ready', '/api/docs', '/api-json']) {
  await check(`internal endpoint not public: ${path}`, async () => {
    const r = await get(path);
    assert(r.status === 404, `HTTP ${r.status} (expected 404 at the edge)`);
  });
}

await check('API answers through the same-origin proxy and requires a session', async () => {
  const r = await get('/api/v1/auth/me');
  assert(r.status === 401, `HTTP ${r.status} (expected 401 without a session)`);
  const body = await r.json();
  assert(body?.error?.code, 'error envelope missing');
});

await check('cross-site mutating requests are refused (CSRF origin check)', async () => {
  const r = await get('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' }, body: '{}' });
  assert(r.status === 403, `HTTP ${r.status} (expected 403 for a foreign Origin)`);
});

if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
  let cookie = ''; let orgId = '';
  const authed = (path) => get(path, { headers: { cookie } });
  await check('sign in with the smoke-test account; session cookie is hardened', async () => {
    const r = await get('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }) });
    assert(r.status === 200, `HTTP ${r.status}`);
    const set = r.headers.getSetCookie?.() ?? [];
    const session = set.find((c) => /cs_session=/.test(c));
    assert(session, 'no session cookie');
    assert(/HttpOnly/i.test(session) && /SameSite=(Lax|Strict)/i.test(session), 'session cookie must be HttpOnly and SameSite');
    if (expectHttps) assert(/;\s*Secure/i.test(session) && session.startsWith('__Host-'), 'session cookie must be __Host- and Secure');
    cookie = session.split(';')[0];
  });
  await check('session identifies the user and their organization', async () => {
    const r = await authed('/api/v1/auth/me');
    assert(r.status === 200, `HTTP ${r.status}`);
    const me = await r.json();
    orgId = me.organizations?.[0]?.id ?? '';
    assert(orgId, 'the smoke account belongs to no organization');
  });
  for (const [name, path] of [
    ['projects', '/projects'],
    ['analytics overview', '/analytics/overview?days=7'],
    ['mention search', '/mentions?limit=5'],
    ['alert rules', '/alert-rules'],
    ['billing and usage', '/billing'],
  ]) {
    await check(`read: ${name}`, async () => {
      if (!orgId) throw new Error('no organization');
      const r = await authed(`/api/v1/organizations/${orgId}${path}`);
      assert(r.status === 200, `HTTP ${r.status}`);
    });
  }
  await check('sign out ends the session', async () => {
    const r = await get('/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin: BASE } });
    assert([200, 204].includes(r.status), `HTTP ${r.status}`);
    const after = await authed('/api/v1/auth/me');
    assert(after.status === 401, `session still valid after logout (HTTP ${after.status})`);
  });
} else {
  console.log('SKIP  signed-in checks (set SMOKE_EMAIL and SMOKE_PASSWORD for the smoke-test account)');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed against ${BASE}`);
process.exit(failed ? 1 : 0);
