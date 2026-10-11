import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { buildAppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import type { AppConfig } from './config.js';

/** Shared by main.ts and the tests, so both run the same pipes, filters and versioning. */
export async function createApp(config: AppConfig, opts: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(buildAppModule(config), { logger: opts.logger, bodyParser: false });
  app.useBodyParser('json', { limit: '4mb' });
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  app.set('etag', false);
  app.disable('x-powered-by');

  const doc = new DocumentBuilder()
    .setTitle('Warranty claims API')
    .setDescription('v2 is current. v1 is deprecated (offset pages) and sunsets on ' + new Date(Date.UTC(2027, 2, 31)).toDateString() + '. Synthetic demo data.')
    .setVersion('2.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));
  return app;
}
