/**
 * End-to-end readiness through the public edge: web → API → database, Redis and migrations. Used by the deploy workflow
 * and smoke tests. Returns only ok/unavailable; the component detail stays on the internal /health/ready endpoint.
 */
export const dynamic = 'force-dynamic';

const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

export async function GET() {
  let ok = false;
  try {
    const res = await fetch(`${api}/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    ok = res.ok;
  } catch { ok = false; }
  return Response.json({ status: ok ? 'ok' : 'unavailable' }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
