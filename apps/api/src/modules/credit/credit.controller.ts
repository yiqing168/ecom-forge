import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';

import { AuthenticationService } from '../auth/authentication.service.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import {
  copyAuthCookies,
  requestHeaders,
  type ApiRequest,
  type ApiResponse,
} from '../auth/auth-http.js';
import { CreditExceptionFilter } from './credit-exception.filter.js';
import { CreditService } from './credit.service.js';

const quoteRequestSchema = z
  .object({
    source: z.enum(['chat', 'canvas', 'suite']),
    source_id: z.uuid().optional(),
    target_ids: z.array(z.uuid()).max(100),
    skill_id: z.string().trim().min(1).max(120).optional(),
    canvas_compile_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === 'canvas' && (!value.source_id || !value.canvas_compile_fingerprint)) {
      context.addIssue({
        code: 'custom',
        path: ['source_id'],
        message: 'Canvas source requires a compile fingerprint',
      });
    }
    if (value.source === 'suite' && !value.source_id) {
      context.addIssue({
        code: 'custom',
        path: ['source_id'],
        message: 'Suite source requires a draft id',
      });
    }
  });

const submitSchema = z
  .object({
    confirmation_snapshot: z
      .object({
        estimated_total_credits: z.string().regex(/^\d+(?:\.\d+)?$/),
        currency: z.literal('credits'),
        confirmed_at_client: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    cost_confirmation: z.enum(['required', 'not_required']),
  })
  .strict();

const ledgerQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

@Controller('api/v1')
@UseFilters(CreditExceptionFilter)
export class CreditController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(CreditService) private readonly credits: CreditService,
  ) {}

  @Post('run-quotes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async createQuote(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await this.currentUserId(request, response);
    const key = z.string().trim().min(1).max(256).parse(idempotencyKey);
    const input = quoteRequestSchema.parse(body);
    return this.credits.createQuote(
      userId,
      {
        source: input.source,
        ...(input.source_id ? { sourceId: input.source_id } : {}),
        targetIds: input.target_ids,
        ...(input.skill_id ? { skillId: input.skill_id } : {}),
        ...(input.canvas_compile_fingerprint
          ? { canvasCompileFingerprint: input.canvas_compile_fingerprint }
          : {}),
      },
      key,
    );
  }

  @Post('run-quotes/:quoteId/submit')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async submitQuote(
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await this.currentUserId(request, response);
    const key = z.string().trim().min(1).max(256).parse(idempotencyKey);
    z.uuid().parse(quoteId);
    const input = submitSchema.parse(body);
    return this.credits.submitQuote(
      userId,
      quoteId,
      input.confirmation_snapshot.estimated_total_credits,
      input.cost_confirmation,
      key,
    );
  }

  @Get('credits/account')
  @Header('Cache-Control', 'no-store')
  async getAccount(@Req() request: ApiRequest, @Res({ passthrough: true }) response: ApiResponse) {
    return this.credits.account(await this.currentUserId(request, response));
  }

  @Get('credits/ledger')
  @Header('Cache-Control', 'no-store')
  async getLedger(
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const parsed = ledgerQuerySchema.parse(query);
    return this.credits.ledger(
      await this.currentUserId(request, response),
      parsed.cursor,
      parsed.limit,
    );
  }

  private async currentUserId(request: ApiRequest, response: ApiResponse): Promise<string> {
    const session = await this.authentication.currentSession(requestHeaders(request));
    if (!session) {
      throw new UnauthorizedException({
        error: { code: 'AUTH_SESSION_REQUIRED', message: '请先登录' },
      });
    }
    copyAuthCookies(session.headers, response);
    if (session.access?.restrictionReason === 'account_restricted') {
      throw new AccountFrozenError();
    }
    return session.user.id;
  }
}
