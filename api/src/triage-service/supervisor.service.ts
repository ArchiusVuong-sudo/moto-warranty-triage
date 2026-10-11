import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config.js';

export type ServiceState = 'external' | 'starting' | 'up' | 'down' | 'restarting' | 'missing';

/** Only these reach the Python process (and through it the agent's CLI child). */
export const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'ANTHROPIC_API_KEY'] as const;

export function buildChildEnv(source: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = source[k];
    if (v) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    env[k] = v;
  }
  return env;
}

/** Free loopback port, never inside 4101-4130 (reserved for other demos on this machine). */
export async function pickPort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port && (port < 4101 || port > 4130)) return port;
  }
  throw new Error('no free port');
}

/**
 * Runs the Python triage service as a child in its own process group, so a kill
 * takes the agent's CLI child down with it. Restarts it after a delay when it
 * dies. With AI_SERVICE_URL set it only points at that service.
 */
@Injectable()
export class TriageServiceSupervisor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('TriageService');
  private child?: ChildProcess;
  private port = 0;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private _state: ServiceState = 'starting';
  private restartAt: number | null = null;
  private exitHook = () => this.killGroup('SIGKILL');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get state(): ServiceState {
    return this._state;
  }

  get restartInMs(): number | null {
    return this.restartAt ? Math.max(0, this.restartAt - Date.now()) : null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  url(): string {
    return this.config.aiServiceUrl ?? `http://127.0.0.1:${this.port}`;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.aiServiceUrl) {
      this._state = 'external';
      return;
    }
    process.once('exit', this.exitHook);
    this.port = await pickPort();
    this.start();
  }

  private pythonPath(): string {
    return join(this.config.repoRoot, 'ai-service', '.venv', 'bin', 'python');
  }

  private start(): void {
    const python = this.pythonPath();
    if (!existsSync(python)) {
      this._state = 'missing';
      this.log.error(`Python env not found at ${python}. Run: npm run setup`);
      return;
    }
    this._state = 'starting';
    this.restartAt = null;
    const env = buildChildEnv(process.env, {
      ...this.config.triageEnv,
      TRIAGE_PORT: String(this.port),
      TRIAGE_PARENT_PID: String(process.pid),
      TRIAGE_DB_PATH: this.config.aiServiceDbPath,
      PYTHONUNBUFFERED: '1',
    });
    const child = spawn(python, ['-m', 'triage_service'], {
      cwd: join(this.config.repoRoot, 'ai-service'),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => this.log.log(d.toString().trimEnd()));
    child.stderr?.on('data', (d: Buffer) => this.log.log(d.toString().trimEnd()));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      this._state = 'down';
      if (this.stopping) return;
      this.log.warn(`exited (${signal ?? code}); restarting in ${this.config.aiRestartDelayMs} ms`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    this._state = 'restarting';
    this.restartAt = Date.now() + this.config.aiRestartDelayMs;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start(), this.config.aiRestartDelayMs);
    this.restartTimer.unref();
  }

  /** Called by the dispatcher's health probe. */
  markUp(): void {
    if (this._state === 'starting') this._state = 'up';
  }

  /** Fault drill: SIGKILL the whole process group (Python and the agent's CLI child). */
  kill(): { killed: boolean; restartInMs: number } {
    if (this._state === 'external' || !this.child?.pid) return { killed: false, restartInMs: 0 };
    this.killGroup('SIGKILL');
    return { killed: true, restartInMs: this.config.aiRestartDelayMs };
  }

  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      /* already gone */
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    process.removeListener('exit', this.exitHook);
    const child = this.child;
    if (!child?.pid) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    this.killGroup('SIGTERM');
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000).unref());
    if ((await Promise.race([exited, timeout])) === 'timeout') this.killGroup('SIGKILL');
  }
}
