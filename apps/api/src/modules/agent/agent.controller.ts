import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { AuthenticationService } from '../auth/authentication.service.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import {
  copyAuthCookies,
  requestHeaders,
  requestIpBucket,
  type ApiRequest,
  type ApiResponse,
} from '../auth/auth-http.js';
import { AuthWriteGuard } from '../auth/auth-write.guard.js';
import { AgentConfirmationService } from './agent-confirmation.service.js';
import { agentError } from './agent.errors.js';
import { AgentExceptionFilter } from './agent-exception.filter.js';
import {
  confirmTurnSchema,
  createTurnSchema,
  interruptTurnSchema,
  archiveSessionSchema,
  parseIdempotencyKey,
  renameSessionSchema,
  sessionDetailQuerySchema,
  sessionListQuerySchema,
} from './agent.schemas.js';
import { AgentSessionService } from './agent-session.service.js';
import { AgentTurnService } from './agent-turn.service.js';
import { SkillCatalogService } from './skill-catalog.service.js';

const uuidSchema = z.uuid();
const skillQuerySchema = z.strictObject({ domain: z.enum(['creative', 'commerce']).optional() });

@Controller('api/v1')
@UseFilters(AgentExceptionFilter)
export class AgentController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SkillCatalogService) private readonly catalog: SkillCatalogService,
    @Inject(AgentTurnService) private readonly turns: AgentTurnService,
    @Inject(AgentConfirmationService) private readonly confirmations: AgentConfirmationService,
    @Inject(AgentSessionService) private readonly sessions: AgentSessionService,
  ) {}

  @Get('skills')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  async getSkills(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const input = skillQuerySchema.parse(query);
    const data = await this.catalog.list(input.domain);
    response.append('ETag', `"${data.response_version}"`);
    return { ok: true, data, error: null };
  }

  @Post('agent/turns')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async createTurn(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    this.assertWriteRouteEnabled();
    const userId = await this.currentUserId(request, response);
    const data = await this.turns.create(
      userId,
      createTurnSchema.parse(body),
      parseIdempotencyKey(idempotencyKey),
      { ipBucket: requestIpBucket(request, this.config.trustedProxyCidrs) },
    );
    return { ok: true, data, error: null };
  }

  @Get('agent/sessions')
  @Header('Cache-Control', 'no-store')
  async listSessions(
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await this.currentUserId(request, response);
    return {
      ok: true,
      data: await this.sessions.list(userId, sessionListQuerySchema.parse(query)),
      error: null,
    };
  }

  @Get('agent/sessions/:sessionId')
  @Header('Cache-Control', 'no-store')
  async getSession(
    @Param('sessionId') sessionIdInput: string,
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await this.currentUserId(request, response);
    return {
      ok: true,
      data: await this.sessions.get(
        userId,
        uuidSchema.parse(sessionIdInput),
        sessionDetailQuerySchema.parse(query),
      ),
      error: null,
    };
  }

  @Patch('agent/sessions/:sessionId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async renameSession(
    @Param('sessionId') sessionIdInput: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await this.currentUserId(request, response);
    return {
      ok: true,
      data: await this.sessions.rename(
        userId,
        uuidSchema.parse(sessionIdInput),
        renameSessionSchema.parse(body),
        parseIdempotencyKey(idempotencyKey),
      ),
      error: null,
    };
  }

  @Post('agent/sessions/:sessionId/archive')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async archiveSession(
    @Param('sessionId') sessionIdInput: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await this.currentUserId(request, response);
    return {
      ok: true,
      data: await this.sessions.archive(
        userId,
        uuidSchema.parse(sessionIdInput),
        archiveSessionSchema.parse(body),
        parseIdempotencyKey(idempotencyKey),
      ),
      error: null,
    };
  }

  @Post('agent/turns/:turnId/confirm')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async confirmTurn(
    @Param('turnId') turnIdInput: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    this.assertWriteRouteEnabled();
    const turnId = uuidSchema.parse(turnIdInput);
    const userId = await this.currentUserId(request, response);
    const data = await this.confirmations.confirm(
      userId,
      turnId,
      confirmTurnSchema.parse(body),
      parseIdempotencyKey(idempotencyKey),
      { ipBucket: requestIpBucket(request, this.config.trustedProxyCidrs) },
    );
    return { ok: true, data, error: null };
  }

  @Post('agent/turns/:turnId/interrupt')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async interruptTurn(
    @Param('turnId') turnIdInput: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    this.assertWriteRouteEnabled();
    const turnId = uuidSchema.parse(turnIdInput);
    const userId = await this.currentUserId(request, response);
    const data = await this.turns.interrupt(
      userId,
      turnId,
      interruptTurnSchema.parse(body),
      parseIdempotencyKey(idempotencyKey),
    );
    return { ok: true, data, error: null };
  }

  @Get('agent/turns/:turnId')
  @Header('Cache-Control', 'no-store')
  async getTurn(
    @Param('turnId') turnIdInput: string,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const turnId = uuidSchema.parse(turnIdInput);
    const userId = await this.currentUserId(request, response);
    return { ok: true, data: await this.turns.get(userId, turnId), error: null };
  }

  private async currentUserId(request: ApiRequest, response: ApiResponse): Promise<string> {
    const session = await this.authentication.currentSession(requestHeaders(request));
    if (!session) {
      throw new UnauthorizedException({
        ok: false,
        data: null,
        error: { code: 'AUTH_SESSION_REQUIRED', message: '请先登录' },
      });
    }
    copyAuthCookies(session.headers, response);
    if (session.access?.restrictionReason === 'account_restricted') {
      throw new AccountFrozenError();
    }
    if (!session.access.canCreate) {
      throw new ForbiddenException({
        ok: false,
        data: null,
        error: {
          code:
            session.access.restrictionReason === 'email_verification_required'
              ? 'AUTH_VERIFICATION_REQUIRED'
              : 'FORBIDDEN',
          message:
            session.access.restrictionReason === 'email_verification_required'
              ? '邮箱尚未验证，请先完成验证'
              : '当前账号暂时无法使用创作助手',
        },
      });
    }
    return session.user.id;
  }

  private assertWriteRouteEnabled(): void {
    if (!this.config.agent.routeEnabled) agentError('AGENT_MODEL_UNAVAILABLE');
  }
}
