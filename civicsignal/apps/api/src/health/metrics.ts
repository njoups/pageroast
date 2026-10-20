import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from '../common/request';
import { logEvent } from '../ingestion/log';

/** Minimal Prometheus text-format registry (no dependency): request counters, latency histogram, process gauges. */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
type Key = string;
const reqCount = new Map<Key, number>();
const latency = new Map<Key, { buckets: number[]; sum: number; count: number }>();
let inFlight = 0;

const label = (v: string) => v.replace(/[\\"\n]/g, '_');
const statusClass = (s: number) => `${Math.floor(s / 100)}xx`;

/**
 * Records method, route template (never the concrete path, so ids and search terms are not exported or logged),
 * status and duration, and writes one structured access-log line per request with its correlation id.
 */
export function requestMetrics(opts: { accessLog: boolean }) {
  return (req: AppRequest, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    inFlight++;
    res.on('finish', () => {
      inFlight--;
      const secs = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : req.path.startsWith('/health') ? req.path : 'unmatched';
      const k = `${req.method}|${route}|${statusClass(res.statusCode)}`;
      reqCount.set(k, (reqCount.get(k) ?? 0) + 1);
      const h = latency.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      BUCKETS.forEach((b, i) => { if (secs <= b) h.buckets[i]!++; });
      h.sum += secs; h.count++; latency.set(k, h);
      if (opts.accessLog && route !== '/health/live') {
        logEvent(res.statusCode >= 500 ? 'error' : 'info', 'http.request', { requestId: req.requestId, method: req.method, route, status: res.statusCode,
          durationMs: Math.round(secs * 1000), userId: req.auth?.userId, tenantId: req.tenant?.orgId });
      }
    });
    next();
  };
}

export function httpMetricsText(): string {
  const out: string[] = [
    '# HELP civicsignal_http_requests_total HTTP requests by method, route template and status class.',
    '# TYPE civicsignal_http_requests_total counter',
  ];
  for (const [k, n] of reqCount) { const [m, r, s] = k.split('|'); out.push(`civicsignal_http_requests_total{method="${m}",route="${label(r!)}",status="${s}"} ${n}`); }
  out.push('# HELP civicsignal_http_request_duration_seconds Request latency.', '# TYPE civicsignal_http_request_duration_seconds histogram');
  for (const [k, h] of latency) {
    const [m, r, s] = k.split('|'); const l = `method="${m}",route="${label(r!)}",status="${s}"`;
    BUCKETS.forEach((b, i) => out.push(`civicsignal_http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
    out.push(`civicsignal_http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`, `civicsignal_http_request_duration_seconds_sum{${l}} ${h.sum.toFixed(6)}`, `civicsignal_http_request_duration_seconds_count{${l}} ${h.count}`);
  }
  const mem = process.memoryUsage(); const cpu = process.cpuUsage();
  out.push(
    '# TYPE civicsignal_http_in_flight gauge', `civicsignal_http_in_flight ${inFlight}`,
    '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`,
    '# TYPE process_heap_used_bytes gauge', `process_heap_used_bytes ${mem.heapUsed}`,
    '# TYPE process_cpu_seconds_total counter', `process_cpu_seconds_total ${((cpu.user + cpu.system) / 1e6).toFixed(3)}`,
    '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round(process.uptime())}`,
  );
  return out.join('\n');
}

/** Constant-time bearer check for the metrics endpoint. */
export function metricsAuthorized(header: string | undefined, token: string | null): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function resetHttpMetrics() { reqCount.clear(); latency.clear(); }
