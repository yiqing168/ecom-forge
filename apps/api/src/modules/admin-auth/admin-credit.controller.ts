import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { AdminExceptionFilter } from './admin-exception.filter.js';
import { adminAuthError } from './admin-errors.js';
import {
  AdminHostGuard,
  AdminOriginGuard,
  AdminPermissionGuard,
  AdminSessionGuard,
  AdminStepUpGuard,
  requireAdminPermission,
} from './admin-guards.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminCreditService } from './admin-credit.service.js';

const reconcileQuery = z.strictObject({
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  user_id: z.uuid().optional(),
});
const correctionBody = z.strictObject({
  user_id: z.uuid(),
  amount: z.string().regex(/^-?(?:0|[1-9]\d{0,15})\.\d{2}$/),
  reason: z.string().trim().min(1).max(1_000),
});

function session(request: AdminRequest): AdminSessionContext {
  if (!request.adminSession) adminAuthError('ADMIN_SESSION_REQUIRED');
  return request.adminSession;
}

function idempotencyKey(request: AdminRequest): string {
  const value = request.headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key) adminAuthError('ADMIN_IDEMPOTENCY_KEY_INVALID', 400);
  return key;
}

@Controller('api/v1/admin/credits')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard, AdminSessionGuard, AdminPermissionGuard)
export class AdminCreditController {
  constructor(@Inject(AdminCreditService) private readonly credits: AdminCreditService) {}

  @Get('reconcile')
  @requireAdminPermission('credits.reconcile')
  @Header('Cache-Control', 'no-store')
  reconcile(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = reconcileQuery.parse(query);
    return this.credits.reconcile(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.user_id ? { userId: input.user_id } : {}),
    });
  }

  @Post('corrections')
  @UseGuards(AdminStepUpGuard)
  @requireAdminPermission('credits.correct')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.CREATED)
  correct(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = correctionBody.parse(body);
    return this.credits.correct(session(request), request, {
      userId: input.user_id,
      amount: input.amount,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
