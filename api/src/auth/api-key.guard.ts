import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ProblemException } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import type { Scope } from './api-keys.js';
import { hashKey } from './api-keys.js';
import { QUERY_TOKEN_KEY, SCOPES_KEY, type AuthedRequest, type Principal } from './principal.js';

interface KeyRow {
  id: string;
  label: string;
  scopes: Scope[];
  dealer_id: number | null;
  rate_capacity: number;
  rate_refill_per_sec: number;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly cache = new Map<string, Principal>();

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const allowQuery = this.reflector.getAllAndOverride<boolean>(QUERY_TOKEN_KEY, [context.getHandler(), context.getClass()]);
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : allowQuery && typeof req.query.access_token === 'string' ? req.query.access_token : undefined;
    const challenge = { 'WWW-Authenticate': 'Bearer realm="claims"' };
    if (!token) throw new ProblemException(401, 'unauthorized', 'API key required', 'Send Authorization: Bearer <api key>.', {}, challenge);
    const principal = await this.lookup(token);
    if (!principal) throw new ProblemException(401, 'unauthorized', 'Unknown API key', 'The API key is not valid.', {}, challenge);
    const needed = this.reflector.getAllAndOverride<Scope[]>(SCOPES_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const missing = needed.filter((s) => !principal.scopes.includes(s));
    if (missing.length) {
      throw new ProblemException(403, 'insufficient-scope', 'Missing scope', `This key lacks: ${missing.join(', ')}.`, { required_scopes: needed });
    }
    req.principal = principal;
    return true;
  }

  private async lookup(token: string): Promise<Principal | undefined> {
    const hash = hashKey(this.config.keyPepper, token);
    const hit = this.cache.get(hash);
    if (hit) return hit;
    const { rows } = await this.db.query<KeyRow>(
      'SELECT id, label, scopes, dealer_id, rate_capacity, rate_refill_per_sec FROM api_keys WHERE key_hash = $1',
      [hash],
    );
    const r = rows[0];
    if (!r) return undefined;
    const p: Principal = {
      keyId: r.id,
      label: r.label,
      role: r.id.startsWith('key_dealer') ? 'dealer' : r.id === 'key_engineer' ? 'engineer' : 'console',
      scopes: r.scopes,
      dealerId: r.dealer_id,
      rateCapacity: r.rate_capacity,
      rateRefillPerSec: r.rate_refill_per_sec,
    };
    this.cache.set(hash, p);
    return p;
  }
}
