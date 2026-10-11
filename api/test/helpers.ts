import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DEMO_KEYS, demoKeyValue } from '../src/auth/api-keys.js';
import { createApp } from '../src/bootstrap.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { DbService } from '../src/db/db.service.js';
import { loadScenarios } from '../src/db/seed.js';
import { OutboxRelay } from '../src/events/relay.service.js';

export type KeyId = 'key_dealer_1' | 'key_dealer_2' | 'key_engineer' | 'key_console';

export interface TestApp {
  app: INestApplication;
  config: AppConfig;
  http: ReturnType<typeof request>;
  key: (id: KeyId) => string;
  auth: (id: KeyId) => { Authorization: string };
  db: DbService;
  relay: OutboxRelay;
  close: () => Promise<void>;
}

type Overrides = Omit<Partial<AppConfig>, 'dispatcher' | 'breaker'> & { dispatcher?: Partial<AppConfig['dispatcher']>; breaker?: Partial<AppConfig['breaker']> };

/** Boots the real Nest app on an in-memory PGlite with a small seed. The dispatcher's timer is off; tests drive it by hand. */
export async function makeApp(overrides: Overrides = {}): Promise<TestApp> {
  const base = loadConfig({});
  const config: AppConfig = {
    ...base,
    dbPath: 'memory://',
    seedClaims: 1500,
    relayPollMs: 10_000,
    aiServiceUrl: 'http://127.0.0.1:9',
    ...overrides,
    dispatcher: { ...base.dispatcher, enabled: false, backoffBaseMs: 0, ...overrides.dispatcher },
    breaker: { ...base.breaker, ...overrides.breaker },
  };
  const app = await createApp(config, { logger: false });
  await app.init();
  const key = (id: KeyId) => demoKeyValue(config.demoKeySeed, id);
  return {
    app,
    config,
    http: request(app.getHttpServer()),
    key,
    auth: (id) => ({ Authorization: `Bearer ${key(id)}` }),
    db: app.get(DbService),
    relay: app.get(OutboxRelay),
    close: () => app.close(),
  };
}

export const SCENARIOS = loadScenarios(loadConfig({}).repoRoot);

export function claimBody(scenarioId = 'cell-imbalance') {
  const s = SCENARIOS.find((x) => x.id === scenarioId)!;
  return { vin: s.vehicle.vin, complaint: s.complaint, odometer_km: s.vehicle.odometer_km, ride_log: s.ride_log };
}

export async function fileClaim(t: TestApp, scenarioId = 'cell-imbalance', idem = `test-${Math.random().toString(36).slice(2)}`, keyId: KeyId = 'key_dealer_1') {
  const res = await t.http.post('/v2/claims').set(t.auth(keyId)).set('Idempotency-Key', idem).send(claimBody(scenarioId));
  return res;
}

export { DEMO_KEYS };
