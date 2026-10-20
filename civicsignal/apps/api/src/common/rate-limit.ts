import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig, CONFIG } from '../config';
import { REDIS } from '../ingestion/ingestion-core.module';
import { KEY_PREFIX, type Redis } from '../ingestion/queue';
import { AppError } from './errors';
import type { AppRequest } from './request';

export interface RateLimitOptions { limit: number; windowSeconds: number }
export const RATE_LIMIT_KEY = 'rate_limit';
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

/**
 * Fixed-window counters. With Redis configured the counters are shared by every API instance (INCR + PEXPIRE in one
 * MULTI, so concurrent requests cannot slip past the limit); without Redis they fall back to per-process memory, which is
 * only adequate for a single instance (startup logs say which store is active).
 */
@Injectable()
export class CounterStore {
  private readonly mem = new Map<string, { count: number; resetAt: number }>();
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}
  get shared() { return !!this.redis; }

  /** Increments the counter for `key` and returns the new count and remaining window in ms. */
  async hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    if (this.redis) {
      try {
        const k = `${KEY_PREFIX}:rl:${key}`;
        const res = await this.redis.multi().incr(k).pexpire(k, windowMs, 'NX').pttl(k).exec();
        const count = Number(res?.[0]?.[1] ?? 1); const ttl = Number(res?.[2]?.[1] ?? windowMs);
        return { count, ttlMs: ttl > 0 ? ttl : windowMs };
      } catch {
        // Redis unavailable: fall through to the local store rather than failing open entirely.
      }
    }
    const now = Date.now();
    const e = this.mem.get(key);
    if (!e || e.resetAt <= now) {
      this.mem.set(key, { count: 1, resetAt: now + windowMs });
      if (this.mem.size > 10_000) for (const [k, v] of this.mem) if (v.resetAt <= now) this.mem.delete(k);
      return { count: 1, ttlMs: windowMs };
    }
    e.count += 1;
    return { count: e.count, ttlMs: e.resetAt - now };
  }

  async clear(key: string): Promise<void> {
    this.mem.delete(key);
    if (this.redis) await this.redis.del(`${KEY_PREFIX}:rl:${key}`).catch(() => undefined);
  }
}

/** Per-route limiter keyed by client IP (only trustworthy behind an edge proxy that overwrites X-Forwarded-For). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(CONFIG) private readonly config: AppConfig, private readonly store: CounterStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!opts || !this.config.rateLimitEnabled) return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const { count, ttlMs } = await this.store.hit(`ip:${req.ip}:${req.method}:${req.route?.path ?? req.path}`, opts.windowSeconds * 1000);
    if (count > opts.limit) throw new AppError(429, 'rate_limited', 'Too many requests, retry later', { retryAfterSeconds: Math.ceil(ttlMs / 1000) });
    return true;
  }
}

/**
 * Counts attempts per key (e.g. per account), independent of client IP, so rotating or spoofing X-Forwarded-For does not
 * help an attacker guess one account's password. Applies identically to unknown accounts, so it does not reveal which
 * emails exist. A success clears the count. Trade-off: an attacker can temporarily lock a known account (window-bounded);
 * accepted in favour of brute-force resistance.
 */
@Injectable()
export class FailureThrottle {
  static readonly LIMIT = 5;
  static readonly WINDOW_MS = 15 * 60 * 1000;
  constructor(@Inject(CONFIG) private readonly config: AppConfig, private readonly store: CounterStore) {}

  /** Reserves an attempt atomically before the (slow) credential check, so a parallel burst cannot exceed the limit. */
  async begin(key: string): Promise<void> {
    if (!this.config.rateLimitEnabled) return;
    const { count, ttlMs } = await this.store.hit(`fail:${key}`, FailureThrottle.WINDOW_MS);
    if (count > FailureThrottle.LIMIT) {
      throw new AppError(429, 'rate_limited', 'Too many failed attempts for this account, retry later', { retryAfterSeconds: Math.ceil(ttlMs / 1000) });
    }
  }

  reset(key: string): Promise<void> {
    return this.store.clear(`fail:${key}`);
  }
}
