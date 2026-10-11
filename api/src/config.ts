import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from this file to the folder that holds contracts/ (works from src/ and dist/). */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'contracts')) && existsSync(join(dir, 'ai-service'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('repo root not found (no contracts/ folder above ' + start + ')');
}

export interface AppConfig {
  port: number;
  host: string;
  repoRoot: string;
  /** 'memory://' for an in-memory database, otherwise a folder for PGlite. */
  dbPath: string;
  seedClaims: number;
  cursorSecret: string;
  keyPepper: string;
  demoKeySeed: string;
  demoEndpoints: boolean;
  /** External triage service; when unset the API starts the Python service itself. */
  aiServiceUrl?: string;
  aiRestartDelayMs: number;
  aiServiceDbPath: string;
  dispatcher: {
    enabled: boolean;
    workers: number;
    pollMs: number;
    leaseMs: number;
    heartbeatMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffCapMs: number;
    attemptTimeoutMs: number;
  };
  breaker: { failureThreshold: number; openMs: number };
  relayPollMs: number;
  /** Passed through to the Python service. */
  triageEnv: Record<string, string>;
}

const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = findRepoRoot();
  const passThrough = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => v !== undefined && (k.startsWith('TRIAGE_') || k === 'DEMO_REPLAY')),
  ) as Record<string, string>;
  return {
    port: int(env.PORT, 4114),
    host: env.HOST ?? '127.0.0.1',
    repoRoot,
    dbPath: env.DB_PATH ?? join(repoRoot, '.data', 'pg'),
    seedClaims: int(env.SEED_CLAIMS, 20000),
    cursorSecret: env.CURSOR_SECRET ?? 'local-demo-cursor-secret',
    keyPepper: env.KEY_PEPPER ?? 'local-demo-key-pepper',
    demoKeySeed: env.DEMO_KEY_SEED ?? 'local-demo',
    demoEndpoints: env.DEMO_ENDPOINTS !== '0',
    aiServiceUrl: env.AI_SERVICE_URL || undefined,
    aiRestartDelayMs: int(env.AI_RESTART_DELAY_MS, 6000),
    aiServiceDbPath: env.TRIAGE_DB_PATH ?? join(repoRoot, '.data', 'triage-service.sqlite'),
    dispatcher: {
      enabled: env.DISPATCHER !== '0',
      workers: int(env.DISPATCH_WORKERS, 2),
      pollMs: int(env.DISPATCH_POLL_MS, 250),
      leaseMs: int(env.JOB_LEASE_MS, 30000),
      heartbeatMs: int(env.JOB_HEARTBEAT_MS, 10000),
      maxAttempts: int(env.JOB_MAX_ATTEMPTS, 6),
      backoffBaseMs: int(env.BACKOFF_BASE_MS, 1000),
      backoffCapMs: int(env.BACKOFF_CAP_MS, 15000),
      attemptTimeoutMs: int(env.ATTEMPT_TIMEOUT_MS, 240000),
    },
    breaker: { failureThreshold: int(env.BREAKER_THRESHOLD, 2), openMs: int(env.BREAKER_OPEN_MS, 2000) },
    relayPollMs: int(env.RELAY_POLL_MS, 100),
    triageEnv: passThrough,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
