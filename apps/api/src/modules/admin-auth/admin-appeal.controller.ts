import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { APPEAL_STATUSES } from '@ecom-forge/types';
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
import { AdminAppealService } from './admin-appeal.service.js';

const uuid = z.uuid();
const pageQuery = z.strictObject({
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(APPEAL_STATUSES).optional(),
});
const decisionBody = z.strictObject({
  expected_revision: z.number().int().positive(),
  decision: z.enum(['refund', 'reject']),
  refund_amount: z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/),
  reason: z.string().min(1).max(1_000),
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

@Controller('api/v1/admin/appeals')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard, AdminSessionGuard, AdminPermissionGuard)
export class AdminAppealController {
  constructor(private readonly appeals: AdminAppealService) {}

  @Get()
  @requireAdminPermission('appeals.read')
  @Header('Cache-Control', 'no-store')
  list(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = pageQuery.parse(query);
    return this.appeals.list(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  @Get(':id')
  @requireAdminPermission('appeals.read')
  @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string) {
    return this.appeals.detail(uuid.parse(id));
  }

  @Post(':id/decide')
  @UseGuards(AdminStepUpGuard)
  @requireAdminPermission('appeals.decide')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  decide(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = decisionBody.parse(body);
    return this.appeals.decide(session(request), request, uuid.parse(id), {
      expectedRevision: input.expected_revision,
      decision: input.decision,
      refundAmount: input.refund_amount,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
