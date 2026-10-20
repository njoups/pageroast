import { hostname } from 'node:os';
import IORedis from 'ioredis';
import { KEY_PREFIX } from './ingestion/queue';

/**
 * Container health check for the worker: healthy when a worker on this host wrote its heartbeat (every 15 s, TTL 60 s).
 *   node dist/worker-health.js   → exit 0 healthy, 1 unhealthy. Prints status words only.
 */
async function main() {
  const url = process.env.REDIS_URL;
  if (!url) { console.log('unhealthy: REDIS_URL not set'); process.exit(1); }
  const r = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
  try {
    await r.connect();
    const keys = await r.keys(`${KEY_PREFIX}:worker:heartbeat:${hostname()}:*`);
    console.log(keys.length ? 'healthy' : 'unhealthy: no heartbeat from this host');
    process.exit(keys.length ? 0 : 1);
  } catch { console.log('unhealthy: redis unreachable'); process.exit(1); } finally { r.disconnect(); }
}
void main();
