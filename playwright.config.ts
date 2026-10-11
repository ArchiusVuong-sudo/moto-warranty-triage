import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.PORT ?? 4114);
// Scratch store for the Python service; e2e/teardown.ts deletes it.
process.env.MWT_E2E_DB ??= join(tmpdir(), `mwt-e2e-${process.pid}.sqlite`);

/** End-to-end run of the built app in replay mode: no login, no key, no network. Run `npm run build` first. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  globalTeardown: './e2e/teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    channel: process.env.PW_CHANNEL ?? 'chrome',
    headless: true,
  },
  webServer: {
    command: 'node api/dist/main.js',
    url: `http://127.0.0.1:${port}/demo/config`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: {
      PORT: String(port),
      DEMO_REPLAY: '1',
      DB_PATH: 'memory://',
      SEED_CLAIMS: '3000',
      TRIAGE_SPAN_DELAY_MS: '150',
      TRIAGE_DB_PATH: process.env.MWT_E2E_DB,
    },
  },
});
