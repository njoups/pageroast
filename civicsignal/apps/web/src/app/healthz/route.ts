/**
 * Liveness of the web process only (container health check). Says nothing about the API or the database, so a backend
 * outage does not get healthy web containers restarted.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
