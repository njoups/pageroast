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
