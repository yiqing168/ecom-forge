import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Put,
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
import type { AdminRequest } from './admin-http.js';
import { AdminRegistrationRewardService } from './admin-registration-reward.service.js';

function session(request: AdminRequest) {
  if (!request.adminSession) adminAuthError('ADMIN_SESSION_REQUIRED');
  return request.adminSession;
}

function idempotencyKey(request: AdminRequest): string {
  const value = request.headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key) adminAuthError('ADMIN_IDEMPOTENCY_KEY_INVALID', 400);
  return key;
}

@Controller('api/v1/admin/registration-reward')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard, AdminSessionGuard, AdminPermissionGuard)
export class AdminRegistrationRewardController {
  constructor(
    @Inject(AdminRegistrationRewardService)
    private readonly service: AdminRegistrationRewardService,
  ) {}

  @Get()
  @requireAdminPermission('invites.read')
  @Header('Cache-Control', 'no-store')
  get() {
    return this.service.get();
  }

  @Put()
  @UseGuards(AdminStepUpGuard)
  @requireAdminPermission('invites.write')
  @Header('Cache-Control', 'no-store')
  update(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = z
      .strictObject({
        enabled: z.boolean(),
        credits: z.string().regex(/^[1-9]\d{0,8}\.00$/),
      })
      .parse(body);
    return this.service.update(session(request), request, {
      ...input,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
