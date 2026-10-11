import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './bootstrap.js';
import { findRepoRoot, loadConfig } from './config.js';

// Optional overrides from .env at the repo root (see .env.example); real environment variables win.
const envFile = join(findRepoRoot(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, config.host);
new Logger('Main').log(`claims console on http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}  (API docs at /docs)`);
