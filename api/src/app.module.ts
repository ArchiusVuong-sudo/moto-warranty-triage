import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiKeyGuard } from './auth/api-key.guard.js';
import { DecideTriageHandler, FileClaimHandler } from './claims/commands.js';
import { ClaimsV1Controller, ClaimsV2Controller } from './claims/claims.controllers.js';
import { GetClaimHandler, GetTimelineHandler, ListClaimsHandler, ListClaimsV1Handler } from './claims/queries.js';
import { APP_CONFIG, loadConfig, type AppConfig } from './config.js';
import { DbService } from './db/db.service.js';
import { ClaimProjector, TriageEnqueuer } from './events/consumers.js';
import { OutboxRelay } from './events/relay.service.js';
import { SpansService } from './events/spans.service.js';
import { TriageContract } from './jobs/contract.js';
import { JobDispatcher } from './jobs/dispatcher.service.js';
import { TriageClient } from './jobs/triage-client.js';
import { DemoController, OpsController } from './ops/ops.controller.js';
import { OpsService } from './ops/ops.service.js';
import { RateLimitGuard } from './rate-limit/rate-limit.guard.js';
import { TokenBucketLimiter } from './rate-limit/token-bucket.js';
import { LiveEvents } from './stream/live-events.js';
import { TriageServiceSupervisor } from './triage-service/supervisor.service.js';

export function buildAppModule(config: AppConfig = loadConfig()) {
  const webDist = join(config.repoRoot, 'web', 'dist');
  const staticModules = existsSync(webDist)
    ? [ServeStaticModule.forRoot({ rootPath: webDist, exclude: /^\/(v1|v2|docs|demo)(\/|$)/ })]
    : [];

  @Module({
    imports: [CqrsModule.forRoot(), ...staticModules],
    controllers: [ClaimsV2Controller, ClaimsV1Controller, OpsController, DemoController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: TriageContract, useFactory: () => new TriageContract(config.repoRoot) },
      { provide: TriageClient, useFactory: (c: TriageContract) => new TriageClient(c), inject: [TriageContract] },
      { provide: TokenBucketLimiter, useValue: new TokenBucketLimiter() },
      DbService,
      LiveEvents,
      SpansService,
      ApiKeyGuard,
      RateLimitGuard,
      ClaimProjector,
      TriageEnqueuer,
      OutboxRelay,
      TriageServiceSupervisor,
      JobDispatcher,
      OpsService,
      FileClaimHandler,
      DecideTriageHandler,
      ListClaimsHandler,
      ListClaimsV1Handler,
      GetClaimHandler,
      GetTimelineHandler,
    ],
  })
  class AppModule {}

  return AppModule;
}
