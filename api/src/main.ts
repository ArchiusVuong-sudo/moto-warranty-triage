import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, config.host);
new Logger('Main').log(`claims console on http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}  (API docs at /docs)`);
