import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { AdminTaskControlService } from './admin-task-control.service.js';

const uuid = z.uuid();

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

@Controller('api/v1/admin/tasks')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminTaskControlController {
  constructor(private readonly tasks: AdminTaskControlService) {}

  @Post(':id/recover-local-dispatch')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('tasks.control')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  recoverLocalDispatch(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = z
      .strictObject({
        queue_dispatch_intent_id: z.uuid(),
        expected_intent_revision: z.number().int().positive(),
        reason: z.string().min(1).max(500),
      })
      .parse(body);
    return this.tasks.recoverLocalDispatch(session(request), request, uuid.parse(id), {
      queueDispatchIntentId: input.queue_dispatch_intent_id,
      expectedIntentRevision: input.expected_intent_revision,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
