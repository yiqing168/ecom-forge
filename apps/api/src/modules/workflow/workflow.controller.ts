import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import { z } from 'zod';

import { TASK_STATUSES } from '@ecom-forge/types';

import { AuthenticationService } from '../auth/authentication.service.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import {
  copyAuthCookies,
  requestHeaders,
  type ApiRequest,
  type ApiResponse,
} from '../auth/auth-http.js';
import { CreditExceptionFilter } from '../credit/credit-exception.filter.js';
import { WorkflowQueryService } from './workflow-query.service.js';
import { WorkflowRetryService } from './workflow-retry.service.js';

const uuidSchema = z.uuid();
const taskQuerySchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    source: z.enum(['chat', 'canvas', 'suite', 'batch']).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

function requestError(): BadRequestException {
  return new BadRequestException({
    error: { code: 'REQUEST_INVALID', message: '请求参数不正确' },
  });
}

@Controller('api/v1')
@UseFilters(CreditExceptionFilter)
export class WorkflowController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(WorkflowQueryService) private readonly queries: WorkflowQueryService,
    @Inject(WorkflowRetryService) private readonly retries: WorkflowRetryService,
  ) {}

  @Post('workflow-runs/:runId/retry')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async retryFailedImage(
    @Param('runId') runIdInput: string,
    @Headers('idempotency-key') idempotencyKeyInput: string | undefined,
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const input = z.object({ task_id: z.uuid() }).strict().parse(body);
    const runId = uuidSchema.parse(runIdInput);
    const idempotencyKey = z.string().trim().min(8).max(200).parse(idempotencyKeyInput);
    const userId = await this.currentUserId(request, response);
    return {
      data: await this.retries.retryFailedImage({
        userId,
        workflowRunId: runId,
        taskId: input.task_id,
        idempotencyKey,
      }),
    };
  }

  @Get('workflow-runs/:runId')
  @Header('Cache-Control', 'no-store')
  async getWorkflow(
    @Param('runId') runIdInput: string,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const parsedId = uuidSchema.safeParse(runIdInput);
    if (!parsedId.success) throw requestError();
    const userId = await this.currentUserId(request, response);
    const result = await this.queries.getWorkflowSnapshot(userId, parsedId.data);
    if (!result) {
      throw new NotFoundException({
        error: { code: 'RESOURCE_NOT_FOUND', message: '未找到该任务' },
      });
    }
    return result;
  }

  @Get('tasks')
  @Header('Cache-Control', 'no-store')
  async getTasks(
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const parsed = taskQuerySchema.safeParse(query);
    if (!parsed.success) throw requestError();
    if (
      parsed.data.from &&
      parsed.data.to &&
      new Date(parsed.data.from).getTime() > new Date(parsed.data.to).getTime()
    ) {
      throw requestError();
    }
    const userId = await this.currentUserId(request, response);
    try {
      return await this.queries.listTasks({
        userId,
        filters: {
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
          ...(parsed.data.from ? { from: new Date(parsed.data.from) } : {}),
          ...(parsed.data.to ? { to: new Date(parsed.data.to) } : {}),
          ...(parsed.data.source ? { source: parsed.data.source } : {}),
        },
        ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        limit: parsed.data.limit,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('cursor')) throw requestError();
      throw error;
    }
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
