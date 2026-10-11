import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { KeyDefinition, Scope } from './api-keys.js';

export interface Principal {
  keyId: string;
  label: string;
  role: KeyDefinition['role'];
  scopes: Scope[];
  dealerId: number | null;
  rateCapacity: number;
  rateRefillPerSec: number;
}

export type AuthedRequest = Request & { principal?: Principal };

export const SCOPES_KEY = 'scopes';
/** Every route names the scopes it needs; a key without one of them gets 403. */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(SCOPES_KEY, scopes);
export const QUERY_TOKEN_KEY = 'allowQueryToken';
/** EventSource cannot send headers, so the SSE route also accepts ?access_token=. */
export const AllowQueryToken = () => SetMetadata(QUERY_TOKEN_KEY, true);
export const SKIP_RATE_LIMIT_KEY = 'skipRateLimit';
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const p = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
  if (!p) throw new Error('route has no ApiKeyGuard');
  return p;
});
