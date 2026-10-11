import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { CurrentPrincipal, RequireScopes, type Principal } from '../auth/principal.js';
import { ProblemException } from '../common/problem.js';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard.js';
import { DecideTriageCommand, FileClaimCommand, type FileClaimResult } from './commands.js';
import { FileClaimDto, ListClaimsQueryDto, ListClaimsV1QueryDto, TriageDecisionDto } from './dto.js';
import { GetClaimQuery, GetTimelineQuery, ListClaimsQuery, ListClaimsV1Query, type ClaimDetail, type ClaimPage } from './queries.js';

export const V1_DEPRECATED_AT = Date.UTC(2026, 8, 1) / 1000;
export const V1_SUNSET = new Date(Date.UTC(2027, 2, 31)).toUTCString();

@ApiTags('v2 claims')
@ApiBearerAuth()
@Controller({ path: 'claims', version: '2' })
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class ClaimsV2Controller {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Get()
  @RequireScopes('claims:read')
  @ApiOperation({ summary: 'List claims, newest first, with a signed keyset cursor' })
  async list(@CurrentPrincipal() p: Principal, @Query() q: ListClaimsQueryDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ClaimPage> {
    const page = await this.queries.execute<ListClaimsQuery, ClaimPage>(new ListClaimsQuery(p, q.limit ?? 50, q.cursor, q.status, q.dealer_id));
    if (page.next_cursor) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined && k !== 'cursor') params.set(k, String(v));
      params.set('cursor', page.next_cursor);
      res.setHeader('Link', `<${req.path}?${params.toString()}>; rel="next"`);
    }
    return page;
  }

  @Post()
  @HttpCode(201)
  @RequireScopes('claims:write')
  @ApiOperation({ summary: 'File a claim with a ride-log export (dealer keys)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Same key and body returns the first answer; a different body returns 422' })
  @ApiResponse({ status: 201, description: 'Filed, or replayed with Idempotent-Replayed: true' })
  async file(
    @CurrentPrincipal() p: Principal,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: FileClaimDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    if (!key || key.length < 8 || key.length > 200) {
      throw new ProblemException(400, 'idempotency-key-required', 'Idempotency-Key required', 'Send an Idempotency-Key header (8-200 characters) so a retry cannot file the claim twice.');
    }
    const out = await this.commands.execute<FileClaimCommand, FileClaimResult>(new FileClaimCommand(p, key, body));
    res.status(out.status);
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.setHeader('Location', `/v2/claims/${String(out.body.id)}`);
    return out.body;
  }

  @Get(':id')
  @RequireScopes('claims:read')
  @ApiOperation({ summary: 'Claim detail with the triage result; ETag is the claim version' })
  async detail(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<ClaimDetail> {
    const d = await this.queries.execute<GetClaimQuery, ClaimDetail>(new GetClaimQuery(p, id));
    res.setHeader('ETag', `"${d.claim.version}"`);
    return d;
  }

  @Get(':id/timeline')
  @RequireScopes('claims:read')
  @ApiOperation({ summary: 'Every step under the claim trace id' })
  timeline(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.queries.execute(new GetTimelineQuery(p, id));
  }

  @Post(':id/triage-decision')
  @HttpCode(200)
  @RequireScopes('triage:decide')
  @ApiOperation({ summary: 'Engineer approves (optionally with edits) or rejects the triage result' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'ETag from GET /v2/claims/{id}; a stale value returns 412' })
  async decide(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: TriageDecisionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.commands.execute<DecideTriageCommand, { version: number; status: string; edits: unknown[] }>(new DecideTriageCommand(p, id, ifMatch, body));
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }
}

@ApiTags('v1 claims (deprecated)')
@ApiBearerAuth()
@Controller({ path: 'claims', version: '1' })
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class ClaimsV1Controller {
  constructor(private readonly queries: QueryBus) {}

  @Get()
  @RequireScopes('claims:read')
  @ApiOperation({ summary: 'Deprecated: offset pages. Use /v2/claims.', deprecated: true })
  async list(@CurrentPrincipal() p: Principal, @Query() q: ListClaimsV1QueryDto, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Deprecation', `@${V1_DEPRECATED_AT}`);
    res.setHeader('Sunset', V1_SUNSET);
    res.setHeader('Link', '</v2/claims>; rel="successor-version", </docs>; rel="deprecation"');
    return this.queries.execute(new ListClaimsV1Query(p, q.page ?? 1, q.per_page ?? 50));
  }
}
