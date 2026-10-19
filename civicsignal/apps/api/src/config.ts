export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Connection string for the restricted application role (RLS enforced). */
  databaseUrl: string;
  /** Owner/admin connection used only by migrations and operator CLIs. */
  migrationDatabaseUrl: string;
  appOrigins: string[];
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  scryptN: number;
  trustProxy: boolean;
  rateLimitEnabled: boolean;
  /** Redis for BullMQ. Optional for the API (collection endpoints return 503 without it); required by the worker. */
  redisUrl: string | null;
  /** base64 32-byte key for connector credentials; credential endpoints are disabled without it. */
  credentialsKey: string | null;
  ingestion: {
    userAgent: string;
    allowPrivateHosts: boolean;
    httpTimeoutMs: number;
    maxResponseBytes: number;
    maxRedirects: number;
    schedulerIntervalMs: number;
    workerConcurrency: number;
    attempts: number;
    backoffBaseMs: number;
    dedupSimilarity: number;
    hostSpacingMs: Record<string, number>;
    defaultHostSpacingMs: number;
  };
  ai: {
    /** 'anthropic' (LLM), 'baseline' (rule-based, no network) or 'test' (deterministic fixtures; refused in production). */
    provider: 'anthropic' | 'baseline' | 'test';
    anthropicApiKey: string | null;
    anthropicBaseUrl: string;
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    timeoutMs: number;
    refusalFallback: boolean;
    /** What to do when the provider keeps failing or is unconfigured: run the baseline (recorded as such) or fail. */
    fallback: 'baseline' | 'none';
    concurrency: number;
    requestsPerMinute: number;
    attempts: number;
    backoffBaseMs: number;
    clusterThreshold: number;
    clusterWindowHours: number;
  };
}

function parseHostSpacing(v: string | undefined): Record<string, number> {
  const out: Record<string, number> = { 'api.gdeltproject.org': 6000 };
  for (const pair of (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [host, ms] = pair.split('=');
    if (host && Number(ms) >= 0) out[host.toLowerCase()] = Number(ms);
  }
  return out;
}

export const CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  const prod = nodeEnv === 'production';
  const required = (key: string): string => {
    const v = env[key];
    if (!v) throw new Error(`Missing required environment variable ${key}`);
    return v;
  };
  const cfg: AppConfig = {
    nodeEnv,
    port: Number(env.PORT ?? 4000),
    databaseUrl: required('DATABASE_URL'),
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? required('DATABASE_URL'),
    appOrigins: (env.APP_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 12 * 3600),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : prod,
    scryptN: Number(env.SCRYPT_N ?? 2 ** 15),
    trustProxy: env.TRUST_PROXY === 'true',
    rateLimitEnabled: env.RATE_LIMIT_ENABLED !== 'false',
    redisUrl: env.REDIS_URL ?? null,
    credentialsKey: env.CREDENTIALS_KEY ?? null,
    ingestion: {
      userAgent: env.INGESTION_USER_AGENT ?? 'CivicSignalBot/0.2 (+https://civicsignal.example/bot; media monitoring)',
      allowPrivateHosts: env.INGESTION_ALLOW_PRIVATE_HOSTS === 'true',
      httpTimeoutMs: Number(env.INGESTION_HTTP_TIMEOUT_MS ?? 30_000),
      maxResponseBytes: Number(env.INGESTION_MAX_RESPONSE_BYTES ?? 5 * 1024 * 1024),
      maxRedirects: 3,
      schedulerIntervalMs: Number(env.INGESTION_SCHEDULER_INTERVAL_MS ?? 15_000),
      workerConcurrency: Number(env.INGESTION_WORKER_CONCURRENCY ?? 4),
      attempts: Number(env.INGESTION_ATTEMPTS ?? 5),
      backoffBaseMs: Number(env.INGESTION_BACKOFF_BASE_MS ?? 30_000),
      dedupSimilarity: Number(env.DEDUP_TITLE_SIMILARITY ?? 0.9),
      hostSpacingMs: parseHostSpacing(env.INGESTION_HOST_SPACING),
      defaultHostSpacingMs: Number(env.INGESTION_DEFAULT_HOST_SPACING_MS ?? 1000),
    },
    ai: {
      provider: (env.AI_PROVIDER as AppConfig['ai']['provider']) || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'baseline'),
      anthropicApiKey: env.ANTHROPIC_API_KEY || null,
      // Explicit default so an ambient ANTHROPIC_BASE_URL (e.g. a developer tool's proxy) is never inherited.
      anthropicBaseUrl: env.AI_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      model: env.AI_MODEL || 'claude-opus-5-5',
      effort: (env.AI_EFFORT as AppConfig['ai']['effort']) || 'low',
      timeoutMs: Number(env.AI_TIMEOUT_MS ?? 60_000),
      refusalFallback: env.AI_REFUSAL_FALLBACK !== 'off',
      fallback: env.AI_FALLBACK === 'none' ? 'none' : 'baseline',
      concurrency: Number(env.AI_CONCURRENCY ?? 2),
      requestsPerMinute: Number(env.AI_REQUESTS_PER_MINUTE ?? 30),
      attempts: Number(env.AI_ATTEMPTS ?? 4),
      backoffBaseMs: Number(env.AI_BACKOFF_BASE_MS ?? 20_000),
      clusterThreshold: Number(env.CLUSTER_THRESHOLD ?? 0.42),
      clusterWindowHours: Number(env.CLUSTER_WINDOW_HOURS ?? 72),
    },
  };
  if (!['anthropic', 'baseline', 'test'].includes(cfg.ai.provider)) throw new Error('AI_PROVIDER must be anthropic, baseline or test');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(cfg.ai.effort)) throw new Error('AI_EFFORT must be low|medium|high|xhigh|max');
  if (prod) {
    if (!cfg.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
    if (cfg.scryptN < 2 ** 15) throw new Error('SCRYPT_N must be >= 32768 in production');
    if (!env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL must be set explicitly in production');
    if (cfg.migrationDatabaseUrl === cfg.databaseUrl) throw new Error('Application and migration database roles must differ in production');
    if (cfg.ingestion.allowPrivateHosts) throw new Error('INGESTION_ALLOW_PRIVATE_HOSTS is for tests only and is refused in production');
    if (cfg.ai.provider === 'test') throw new Error('AI_PROVIDER=test is for automated tests only and is refused in production');
    if (cfg.ai.provider === 'anthropic' && !cfg.ai.anthropicApiKey) throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  return cfg;
}
