import { Controller, Get, HttpCode, Inject, MessageEvent, NotFoundException, Param, Post, Query, Sse, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable, from, interval, map, merge, startWith, switchMap } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { DEMO_KEYS, demoKeyValue } from '../auth/api-keys.js';
import { AllowQueryToken, RequireScopes, SkipRateLimit } from '../auth/principal.js';
import { loadScenarios, type ScenarioDoc } from '../db/seed.js';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard.js';
import { LiveEvents } from '../stream/live-events.js';
import { OpsService } from './ops.service.js';

@ApiTags('v2 ops')
@ApiBearerAuth()
@Controller({ version: '2' })
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly live: LiveEvents,
  ) {}

  @Get('health')
  @RequireScopes('claims:read')
  @ApiOperation({ summary: 'API, triage service, circuit breaker, queue and dead-letter counts' })
  health() {
    return this.ops.health();
  }

  @Sse('stream')
  @RequireScopes('claims:read')
  @AllowQueryToken()
  @SkipRateLimit()
  @ApiOperation({ summary: 'Server-sent events: claim read-model updates, timeline spans, health every second' })
  stream(): Observable<MessageEvent> {
    const health = interval(1000).pipe(
      startWith(0),
      switchMap(() => from(this.ops.health())),
      map((data) => ({ type: 'health', data }) as MessageEvent),
    );
    const events = this.live.stream().pipe(map((e) => ({ type: e.type, data: e.data }) as MessageEvent));
    return merge(health, events);
  }

  @Get('ops/dead-letters')
  @RequireScopes('ops')
  deadLetters() {
    return this.ops.deadLetters();
  }

  @Get('ops/query-plan')
  @RequireScopes('ops')
  @ApiOperation({ summary: 'EXPLAIN ANALYZE of the keyset page query next to the OFFSET query at the same depth' })
  queryPlan(@Query('depth') depth?: string) {
    const d = Math.min(50000, Math.max(1, Number.parseInt(depth ?? '15000', 10) || 15000));
    return this.ops.queryPlan(d);
  }

  @Post('ops/drills/kill-triage-service')
  @HttpCode(200)
  @RequireScopes('ops')
  kill() {
    return this.ops.killTriageService();
  }

  @Post('ops/drills/lose-next-reply')
  @HttpCode(200)
  @RequireScopes('ops')
  loseNextReply() {
    return this.ops.loseNextReply();
  }

  @Post('ops/drills/redeliver-claim-filed')
  @HttpCode(200)
  @RequireScopes('ops')
  redeliver(@Query('claim_id') claimId?: string) {
    return this.ops.redeliverClaimFiled(claimId && /^[0-9a-f-]{36}$/i.test(claimId) ? claimId : undefined);
  }
}

/** Demo-only: hands the console its synthetic keys and scenarios. Off with DEMO_ENDPOINTS=0. */
@ApiExcludeController()
@Controller({ path: 'demo', version: VERSION_NEUTRAL })
export class DemoController {
  private readonly scenarios: ScenarioDoc[];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.scenarios = loadScenarios(config.repoRoot);
  }

  private guard(): void {
    if (!this.config.demoEndpoints) throw new NotFoundException();
  }

  @Get('config')
  config_() {
    this.guard();
    return {
      synthetic_data: true,
      keys: DEMO_KEYS.map((k) => ({ id: k.id, label: k.label, role: k.role, scopes: k.scopes, dealer_id: k.dealerId, value: demoKeyValue(this.config.demoKeySeed, k.id) })),
      scenarios: this.scenarios.map((s) => ({ id: s.id, title: s.title, complaint: s.complaint, vehicle: s.vehicle, rows: s.ride_log.rows.length })),
    };
  }

  @Get('scenarios/:id')
  scenario(@Param('id') id: string) {
    this.guard();
    const s = this.scenarios.find((x) => x.id === id);
    if (!s) throw new NotFoundException();
    return { id: s.id, title: s.title, complaint: s.complaint, vehicle: s.vehicle, ride_log: s.ride_log };
  }
}
