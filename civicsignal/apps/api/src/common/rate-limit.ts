import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig, CONFIG } from '../config';
import { AppError } from './errors';
import type { AppRequest } from './request';

export interface RateLimitOptions { limit: number; windowSeconds: number }
export const RATE_LIMIT_KEY = 'rate_limit';
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

/**
 * Fixed-window, in-process limiter keyed by client IP + route.
 * LIMITATION: per-instance memory. Multi-instance deployments need the Redis-backed store (M2+).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly reflector: Reflector, @Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const opts = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!opts || !this.config.rateLimitEnabled) return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const key = `${req.ip}:${req.method}:${req.route?.path ?? req.path}`;
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + opts.windowSeconds * 1000 });
      this.sweep(now);
      return true;
    }
    entry.count += 1;
    if (entry.count > opts.limit) {
      throw new AppError(429, 'rate_limited', 'Too many requests, retry later', { retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) });
    }
    return true;
  }

  private sweep(now: number): void {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/**
 * Counts attempts per key (successes clear the count) (e.g. per account) independent of client IP, so rotating or spoofing
 * X-Forwarded-For does not help an attacker guess one account's password. Applies identically to
 * unknown accounts, so it does not reveal which emails exist.
 * LIMITATION: per-instance memory, like RateLimitGuard. Trade-off: an attacker can temporarily lock a
 * known account (window-bounded); this is accepted in favour of brute-force resistance.
 */
@Injectable()
export class FailureThrottle {
  static readonly LIMIT = 5;
  static readonly WINDOW_MS = 15 * 60 * 1000;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  /**
   * Reserves an attempt *synchronously* (check + increment with no await in between), so a parallel burst cannot
   * slip past the limit while slow password hashing is in flight. Call `reset` after a success.
   */
  begin(key: string): void {
    if (!this.config.rateLimitEnabled) return;
    const now = Date.now();
    const e = this.failures.get(key);
    if (!e || e.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + FailureThrottle.WINDOW_MS });
      if (this.failures.size > 10_000) for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
      return;
    }
    if (e.count >= FailureThrottle.LIMIT) {
      throw new AppError(429, 'rate_limited', 'Too many failed attempts for this account, retry later', { retryAfterSeconds: Math.ceil((e.resetAt - now) / 1000) });
    }
    e.count += 1;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
