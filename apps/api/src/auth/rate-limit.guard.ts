import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error';
import { ENV, Env } from '../config/env';
import { RATE_LIMIT } from './auth.decorators';

/**
 * Fixed-window in-memory limiter, applied only to routes decorated with @RateLimit.
 * LIMITATION: per-process memory; with several API instances use a shared store (Redis) instead.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<{ limit?: number; windowSec?: number } | undefined>(
      RATE_LIMIT,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!opts || !this.env.RATE_LIMIT_ENABLED) return true;
    const req = ctx.switchToHttp().getRequest();
    const limit = opts.limit ?? this.env.RATE_LIMIT_AUTH_PER_MINUTE;
    const windowMs = (opts.windowSec ?? 60) * 1000;
    const key = `${req.method}:${req.route?.path ?? req.path}:${req.ip}`;
    const now = Date.now();
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    if (entry.count > limit) throw new AppError(429, 'rate_limited', 'Too many requests, try again later');
    return true;
  }
}
