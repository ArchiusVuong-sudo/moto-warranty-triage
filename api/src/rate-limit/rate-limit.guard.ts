import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { ProblemException } from '../common/problem.js';
import { SKIP_RATE_LIMIT_KEY, type AuthedRequest } from '../auth/principal.js';
import { TokenBucketLimiter } from './token-bucket.js';

/** Runs after ApiKeyGuard. Sets RateLimit-* headers on every answer and refuses with 429 + Retry-After. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: TokenBucketLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const p = req.principal;
    if (!p) return true;
    const r = this.limiter.take(p.keyId, p.rateCapacity, p.rateRefillPerSec);
    res.setHeader('RateLimit-Policy', `${r.limit};w=${Math.ceil(r.limit / p.rateRefillPerSec)};policy="token-bucket"`);
    res.setHeader('RateLimit-Limit', String(r.limit));
    res.setHeader('RateLimit-Remaining', String(r.remaining));
    res.setHeader('RateLimit-Reset', String(r.resetSec));
    if (!r.allowed) {
      throw new ProblemException(
        429,
        'rate-limited',
        'Too many requests',
        `Key ${p.keyId} allows ${r.limit} requests in a burst, refilled at ${p.rateRefillPerSec}/s.`,
        { retry_after_seconds: r.retryAfterSec },
        { 'Retry-After': String(r.retryAfterSec) },
      );
    }
    return true;
  }
}
