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
import { USER_RISK_STATUSES } from '@ecom-forge/types';
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
import { AdminUserControlService } from './admin-user-control.service.js';

const uuid = z.uuid();
const reason = z.string().min(1).max(500);

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

@Controller('api/v1/admin/users')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminUserControlController {
  constructor(private readonly users: AdminUserControlService) {}

  @Post(':id/risk-status')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('risk.manage')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  updateRiskStatus(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = z
      .strictObject({
        expected_revision: z.number().int().positive(),
        target_status: z.enum(USER_RISK_STATUSES),
        reason,
      })
      .parse(body);
    return this.users.updateRiskStatus(session(request), request, uuid.parse(id), {
      expectedRevision: input.expected_revision,
      targetStatus: input.target_status,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':id/sessions/revoke-all')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('sessions.revoke')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  revokeAllSessions(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = z.strictObject({ reason }).parse(body);
    return this.users.revokeAllSessions(session(request), request, uuid.parse(id), {
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
