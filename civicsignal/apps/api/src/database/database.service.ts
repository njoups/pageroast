import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';

/**
 * Request context pushed into Postgres as transaction-local settings.
 * RLS policies read these via app_current_tenant() / app_current_user() / app_is_system().
 */
export interface DbContext {
  tenantId?: string;
  userId?: string;
  /** Pre-authentication / cross-tenant flows only (login, registration, invitation redemption). */
  system?: boolean;
}

@Injectable()
export class Database implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  async run<T>(ctx: DbContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // is_local = true: values vanish at COMMIT/ROLLBACK so they cannot leak across pooled connections.
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.user_id', $2, true),
                set_config('app.system', $3, true)`,
        [ctx.tenantId ?? '', ctx.userId ?? '', ctx.system ? 'on' : ''],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  withTenant<T>(tenantId: string, userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.run({ tenantId, userId }, fn);
  }
  withUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.run({ userId }, fn);
  }
  withSystem<T>(fn: (c: PoolClient) => Promise<T>, extra: Omit<DbContext, 'system'> = {}): Promise<T> {
    return this.run({ ...extra, system: true }, fn);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
