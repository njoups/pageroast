export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  /** Deployment environment (docs/DEPLOYMENT.md). staging and production get the strict deployment checks. */
  appEnv: 'local' | 'staging' | 'production';
  port: number;
  /** Connection string for the restricted application role (RLS enforced). */
  databaseUrl: string;
  /** Owner/admin connection used only by migrations and operator CLIs. */
  migrationDatabaseUrl: string;
  /** Connections per process in the application pool (API and worker each hold one pool). */
  databasePoolMax: number;
  appOrigins: string[];
  sessionTtlSeconds: number;
  /** A session unused for this long is rejected (sliding idle timeout, in addition to the absolute TTL). */
  sessionIdleSeconds: number;
  passwordResetTtlMinutes: number;
  /** Serve the OpenAPI UI at /api/docs. Off by default in production. */
  apiDocsEnabled: boolean;
  /** Bearer token for GET /metrics (Prometheus text format). Metrics are disabled when unset. */
  metricsToken: string | null;
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
  /** Base URL of the web app, used for links in notifications. */
  appBaseUrl: string;
  alerts: {
    evaluateIntervalMs: number;        // scheduler cadence (each tenant is evaluated at most once per bucket)
    bucketMinutes: number;             // idempotency bucket for evaluations
    refreshHours: number;              // activity aggregates recomputed for this many recent hours per evaluation
    attempts: number;                  // notification / webhook delivery attempts
    backoffBaseMs: number;
    emailPerMinute: number;            // per tenant
    webhookPerMinute: number;          // per tenant
    notificationsPerDay: number;       // per tenant, all channels; beyond it deliveries are suppressed and logged
    webhookTimeoutMs: number;
    webhookAllowHttp: boolean;         // tests only; refused in production
    collectionStaleHours: number;
  };
  analytics: {
    refreshIntervalMs: number;         // incremental aggregation cadence (worker scheduler)
    cacheTtlSeconds: number;           // analytics_cache entry lifetime (entries are also invalidated by data changes)
    maxPeriodDays: number;             // longest period an analytics query or report may cover
  };
  reports: {
    artifactTtlDays: number;           // generated files are deleted after this (metadata kept)
    runsPerDay: number;                // per tenant, manual + scheduled
    concurrentRuns: number;            // per tenant, queued + running
    csvRowLimit: number;               // rows per CSV export
    attempts: number;                  // generation attempts before a run fails
    staleRunMinutes: number;           // a running job without heartbeat for this long is failed (abandoned)
    queuedTimeoutMinutes: number;      // a run still queued after this long is cancelled
  };
  /**
   * Outbound recipients. `null` = unrestricted. In staging the lists are mandatory or deny-all, so test workflows can
   * never message real customers (docs/DEPLOYMENT.md, "Staging").
   */
  email: { smtpUrl: string | null; from: string | null; allowedDomains?: string[] | null };
  whatsapp: { accessToken: string | null; phoneNumberId: string | null; templateName: string | null; templateLanguage: string; apiBaseUrl: string; allowedNumbers?: string[] | null };
  /** Customer webhook receivers this environment may call (`null` = any host that passes the SSRF policy). */
  webhookAllowedHosts: string[] | null;
  billing: {
    /** Payment provider adapter: 'none' (default; contract/manual billing only) or 'test' (local simulator; refused in production). */
    provider: 'none' | 'test';
    testWebhookSecret: string | null;
    /** Plan code new organizations start on (its trial_days decide the trial length). */
    trialPlan: string;
    /** Prefix of manual invoice numbers, e.g. INV → INV-2026-000001. */
    invoicePrefix: string;
    /** Where sales requests are emailed (optional; requests are always stored). */
    salesEmail: string | null;
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
  const appEnv = (env.APP_ENV || (prod ? 'production' : 'local')) as AppConfig['appEnv'];
  if (!['local', 'staging', 'production'].includes(appEnv)) throw new Error('APP_ENV must be local, staging or production');
  const staging = appEnv === 'staging';
  /** Comma-separated allow-list; unset means unrestricted, except in staging where unset means "nothing allowed". */
  const list = (v: string | undefined, denyByDefault: boolean): string[] | null => {
    const items = (v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    return items.length ? items : denyByDefault ? [] : null;
  };
  const cfg: AppConfig = {
    nodeEnv, appEnv,
    port: Number(env.PORT ?? 4000),
    databaseUrl: required('DATABASE_URL'),
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? required('DATABASE_URL'),
    databasePoolMax: Number(env.DATABASE_POOL_MAX || 10),
    appOrigins: (env.APP_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 12 * 3600),
    sessionIdleSeconds: Number(env.SESSION_IDLE_SECONDS ?? 2 * 3600),
    passwordResetTtlMinutes: Number(env.PASSWORD_RESET_TTL_MINUTES ?? 30),
    apiDocsEnabled: env.API_DOCS_ENABLED ? env.API_DOCS_ENABLED === 'true' : !prod,
    metricsToken: env.METRICS_TOKEN || null,
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
    appBaseUrl: (env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    alerts: {
      evaluateIntervalMs: Number(env.ALERTS_EVALUATE_INTERVAL_MS || 60_000),
      bucketMinutes: Number(env.ALERTS_BUCKET_MINUTES || 5),
      refreshHours: Number(env.ALERTS_REFRESH_HOURS || 48),
      attempts: Number(env.ALERTS_DELIVERY_ATTEMPTS || 5),
      backoffBaseMs: Number(env.ALERTS_BACKOFF_BASE_MS || 30_000),
      emailPerMinute: Number(env.ALERTS_EMAIL_PER_MINUTE || 60),
      webhookPerMinute: Number(env.ALERTS_WEBHOOK_PER_MINUTE || 60),
      notificationsPerDay: Number(env.ALERTS_NOTIFICATIONS_PER_DAY || 2000),
      webhookTimeoutMs: Number(env.ALERTS_WEBHOOK_TIMEOUT_MS || 10_000),
      webhookAllowHttp: env.ALERTS_WEBHOOK_ALLOW_HTTP === 'true',
      collectionStaleHours: Number(env.ALERTS_COLLECTION_STALE_HOURS || 6),
    },
    analytics: {
      refreshIntervalMs: Number(env.ANALYTICS_REFRESH_INTERVAL_MS || 120_000),
      cacheTtlSeconds: Number(env.ANALYTICS_CACHE_TTL_SECONDS || 900),
      maxPeriodDays: Number(env.ANALYTICS_MAX_PERIOD_DAYS || 366),
    },
    reports: {
      artifactTtlDays: Number(env.REPORT_ARTIFACT_TTL_DAYS || 30),
      runsPerDay: Number(env.REPORT_RUNS_PER_DAY || 50),
      concurrentRuns: Number(env.REPORT_CONCURRENT_RUNS || 3),
      csvRowLimit: Number(env.REPORT_CSV_ROW_LIMIT || 5000),
      attempts: Number(env.REPORT_ATTEMPTS || 3),
      staleRunMinutes: Number(env.REPORT_STALE_RUN_MINUTES || 15),
      queuedTimeoutMinutes: Number(env.REPORT_QUEUED_TIMEOUT_MINUTES || 120),
    },
    email: { smtpUrl: env.SMTP_URL || null, from: env.EMAIL_FROM || null, allowedDomains: list(env.NOTIFY_ALLOWED_EMAIL_DOMAINS, staging) },
    whatsapp: {
      accessToken: env.WHATSAPP_ACCESS_TOKEN || null, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || null,
      templateName: env.WHATSAPP_TEMPLATE_NAME || null, templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE || 'id',
      apiBaseUrl: env.WHATSAPP_API_BASE_URL || 'https://graph.facebook.com/v21.0',
      allowedNumbers: list(env.NOTIFY_ALLOWED_PHONE_NUMBERS, staging),
    },
    webhookAllowedHosts: list(env.NOTIFY_ALLOWED_WEBHOOK_HOSTS, staging),
    billing: {
      provider: (env.BILLING_PROVIDER || 'none') as AppConfig['billing']['provider'],
      testWebhookSecret: env.BILLING_TEST_WEBHOOK_SECRET || null,
      trialPlan: env.COMMERCIAL_TRIAL_PLAN || 'trial',
      invoicePrefix: env.INVOICE_NUMBER_PREFIX || 'INV',
      salesEmail: env.BILLING_SALES_EMAIL || null,
    },
  };
  if (!['none', 'test'].includes(cfg.billing.provider)) throw new Error('BILLING_PROVIDER must be none or test (no live payment provider adapter is implemented)');
  if (cfg.billing.provider === 'test' && (!cfg.billing.testWebhookSecret || cfg.billing.testWebhookSecret.length < 24)) throw new Error('BILLING_PROVIDER=test requires BILLING_TEST_WEBHOOK_SECRET (at least 24 characters)');
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(cfg.billing.trialPlan)) throw new Error('COMMERCIAL_TRIAL_PLAN must be a plan code');
  if (!/^[A-Z0-9-]{1,12}$/.test(cfg.billing.invoicePrefix)) throw new Error('INVOICE_NUMBER_PREFIX must be 1-12 characters A-Z, 0-9 or -');
  if (cfg.email.smtpUrl && !/^smtps?:\/\//.test(cfg.email.smtpUrl)) throw new Error('SMTP_URL must start with smtp:// or smtps://');
  if (cfg.email.smtpUrl && !cfg.email.from) throw new Error('EMAIL_FROM is required when SMTP_URL is set');
  if (cfg.email.from && /[\r\n]/.test(cfg.email.from)) throw new Error('EMAIL_FROM must be a single line');
  if (cfg.credentialsKey && Buffer.from(cfg.credentialsKey, 'base64').length !== 32) throw new Error('CREDENTIALS_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)');
  if (cfg.sessionIdleSeconds < 300 || cfg.sessionIdleSeconds > cfg.sessionTtlSeconds) throw new Error('SESSION_IDLE_SECONDS must be between 300 and SESSION_TTL_SECONDS');
  if (cfg.sessionTtlSeconds > 7 * 86_400) throw new Error('SESSION_TTL_SECONDS may not exceed 7 days');
  if (!/^https?:\/\//.test(cfg.appBaseUrl)) throw new Error('APP_BASE_URL must be an http(s) URL');
  if (!['anthropic', 'baseline', 'test'].includes(cfg.ai.provider)) throw new Error('AI_PROVIDER must be anthropic, baseline or test');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(cfg.ai.effort)) throw new Error('AI_EFFORT must be low|medium|high|xhigh|max');
  if (prod) {
    if (!cfg.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
    if (cfg.scryptN < 2 ** 15) throw new Error('SCRYPT_N must be >= 32768 in production');
    // The API and worker run with the restricted application role only; the owner connection belongs to the migration job.
    if (env.MIGRATION_DATABASE_URL && env.MIGRATION_DATABASE_URL === cfg.databaseUrl) throw new Error('Application and migration database roles must differ in production');
    if (!cfg.rateLimitEnabled) throw new Error('RATE_LIMIT_ENABLED=false is refused in production');
    if (cfg.metricsToken && cfg.metricsToken.length < 32) throw new Error('METRICS_TOKEN must be at least 32 characters');
    if (cfg.ingestion.allowPrivateHosts) throw new Error('INGESTION_ALLOW_PRIVATE_HOSTS is for tests only and is refused in production');
    if (cfg.ai.provider === 'test') throw new Error('AI_PROVIDER=test is for automated tests only and is refused in production');
    if (cfg.ai.provider === 'anthropic' && !cfg.ai.anthropicApiKey) throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
    if (cfg.alerts.webhookAllowHttp) throw new Error('ALERTS_WEBHOOK_ALLOW_HTTP is for tests only and is refused in production');
    // The simulator is how staging exercises billing without real money; only real production refuses it.
    if (cfg.billing.provider === 'test' && !staging) throw new Error('BILLING_PROVIDER=test is a local simulator and is refused in production');
    if (env.YOUTUBE_API_BASE_URL) throw new Error('YOUTUBE_API_BASE_URL is for contract tests only and is refused in production');
  }
  if (prod && appEnv !== 'local') {
    // Deployed environments (staging, production): TLS-only origins, shared Redis, no local-only shortcuts.
    if (!cfg.redisUrl) throw new Error(`REDIS_URL is required when APP_ENV=${appEnv} (queues and shared rate limits)`);
    for (const o of cfg.appOrigins) if (!o.startsWith('https://')) throw new Error(`APP_ORIGINS must use https when APP_ENV=${appEnv} (got ${o})`);
    if (!cfg.appBaseUrl.startsWith('https://')) throw new Error(`APP_BASE_URL must use https when APP_ENV=${appEnv}`);
    if (!cfg.trustProxy) throw new Error(`TRUST_PROXY=true is required when APP_ENV=${appEnv} (the API must run behind the TLS edge proxy)`);
    // Required in every deployed environment: connector credentials are encrypted with this key, operators need
    // metrics, and password reset and alerts need email.
    if (!cfg.credentialsKey) throw new Error(`CREDENTIALS_KEY is required when APP_ENV=${appEnv}`);
    if (!cfg.metricsToken) throw new Error(`METRICS_TOKEN is required when APP_ENV=${appEnv} (monitoring scrapes /metrics)`);
    if (!cfg.email.smtpUrl) throw new Error(`SMTP_URL and EMAIL_FROM are required when APP_ENV=${appEnv} (password reset and alerts)`);
    if (staging && !env.NOTIFY_ALLOWED_EMAIL_DOMAINS) throw new Error('NOTIFY_ALLOWED_EMAIL_DOMAINS is required when APP_ENV=staging (test email must never reach real customers)');
    if (appEnv === 'production' && env.API_DOCS_ENABLED === 'true') throw new Error('API_DOCS_ENABLED=true is refused when APP_ENV=production');
  }
  if (cfg.databasePoolMax < 1 || cfg.databasePoolMax > 100) throw new Error('DATABASE_POOL_MAX must be between 1 and 100');
  // A mistyped number (e.g. "30s") becomes NaN and would silently disable a limit or a schedule.
  const bad: string[] = [];
  const walk = (o: object, path: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(path + k);
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${path}${k}.`);
    }
  };
  walk(cfg, '');
  if (bad.length) throw new Error(`Invalid numeric configuration: ${bad.join(', ')} (check the corresponding environment variables)`);
  return cfg;
}
