import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import {
  AdminHostGuard,
  AdminOriginGuard,
  AdminPermissionGuard,
  AdminSessionGuard,
  AdminStepUpGuard,
  requireAdminPermission,
} from './admin-guards.js';
import { AdminExceptionFilter } from './admin-exception.filter.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest } from './admin-http.js';
import { AdminInviteCodeService } from './admin-invite-code.service.js';

const emptyBody = z.strictObject({});

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

@Controller('api/v1/admin/invites')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminInviteCodeController {
  constructor(@Inject(AdminInviteCodeService) private readonly service: AdminInviteCodeService) {}

  @Get()
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('invites.read')
  @Header('Cache-Control', 'no-store')
  list(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = z
      .strictObject({
        status: z.enum(['unused', 'used', 'disabled', 'expired']).optional(),
        cursor: z.string().min(1).max(2_048).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(query);
    return this.service.list(session(request), {
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    });
  }

  @Post()
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('invites.write')
  @Header('Cache-Control', 'no-store')
  generate(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = z
      .strictObject({
        count: z.number().int().positive().max(1_000),
        expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
      })
      .parse(body);
    return this.service.generate(session(request), request, {
      count: input.count,
      expiresAt: input.expires_at ? new Date(input.expires_at) : null,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':id/reveal')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('invites.write')
  @Header('Cache-Control', 'no-store')
  reveal(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    emptyBody.parse(body);
    return this.service.reveal(session(request), request, z.uuid().parse(id));
  }

  @Post('disable-batch')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('invites.write')
  @Header('Cache-Control', 'no-store')
  disableBatch(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = z.strictObject({ invite_ids: z.array(z.uuid()).min(1).max(1_000) }).parse(body);
    return this.service.disableBatch(
      session(request),
      request,
      input.invite_ids,
      idempotencyKey(request),
    );
  }

  @Post(':id/disable')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('invites.write')
  @Header('Cache-Control', 'no-store')
  disable(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    emptyBody.parse(body);
    return this.service.disable(
      session(request),
      request,
      z.uuid().parse(id),
      idempotencyKey(request),
    );
  }
}
