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
  };
  if (prod) {
    if (!cfg.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
    if (cfg.scryptN < 2 ** 15) throw new Error('SCRYPT_N must be >= 32768 in production');
    if (!env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL must be set explicitly in production');
    if (cfg.migrationDatabaseUrl === cfg.databaseUrl) throw new Error('Application and migration database roles must differ in production');
  }
  return cfg;
}
