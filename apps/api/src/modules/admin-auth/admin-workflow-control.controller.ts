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
import { AdminWorkflowControlService } from './admin-workflow-control.service.js';

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

@Controller('api/v1/admin/workflow-runs')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminWorkflowControlController {
  constructor(private readonly workflows: AdminWorkflowControlService) {}

  @Post(':id/cancel')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('tasks.control')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const workflowRunId = z.uuid().parse(id);
    const input = z
      .strictObject({
        expected_run_revision: z.number().int().positive(),
        reason: z.string().min(1).max(500),
      })
      .parse(body);
    return this.workflows.cancel(session(request), request, workflowRunId, {
      expectedRunRevision: input.expected_run_revision,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
