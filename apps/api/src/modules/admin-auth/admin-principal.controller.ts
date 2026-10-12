import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
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
import type { AdminRequest } from './admin-http.js';
import { AdminPrincipalService } from './admin-principal.service.js';
import { adminAuthError } from './admin-errors.js';

const uuid = z.string().uuid();
const createSchema = z
  .object({
    identifier: z.string().min(1).max(320),
    display_name: z.string().min(1).max(80),
    role_key: z.string().min(1).max(64),
    reason: z.string().min(1).max(500),
  })
  .strict();
const revisionSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    reason: z.string().min(1).max(500),
  })
  .strict();
const rolesSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    roles: z
      .array(
        z
          .object({
            role_key: z.string().min(1).max(64),
            scope_type: z.string().min(1).max(64).optional(),
            scope_key: z.string().min(1).max(128).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    reason: z.string().min(1).max(500),
  })
  .strict();
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);

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

@Controller('api/v1/admin/admin-principals')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminPrincipalController {
  constructor(private readonly principals: AdminPrincipalService) {}

  @Get()
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('admin_accounts.read')
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: AdminRequest) {
    const query = limitSchema.parse(request.query.limit);
    return this.principals.list(query);
  }

  @Post()
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('admin_accounts.manage')
  @Header('Cache-Control', 'no-store')
  async create(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = createSchema.parse(body);
    return this.principals.create(session(request), request, {
      identifier: input.identifier,
      displayName: input.display_name,
      roleKey: input.role_key,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Get(':id')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('admin_accounts.read')
  @Header('Cache-Control', 'no-store')
  async detail(@Param('id') id: string) {
    return this.principals.detail(uuid.parse(id));
  }

  @Get(':id/sessions')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('admin_accounts.read')
  @Header('Cache-Control', 'no-store')
  async sessions(@Param('id') id: string) {
    return this.principals.sessions(uuid.parse(id));
  }

  @Put(':id/role-bindings')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('admin_accounts.manage')
  @Header('Cache-Control', 'no-store')
  async replaceRoles(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = rolesSchema.parse(body);
    return this.principals.replaceRoles(session(request), request, uuid.parse(id), {
      expectedRevision: input.expected_revision,
      roles: input.roles.map((role) => ({
        roleKey: role.role_key,
        ...(role.scope_type ? { scopeType: role.scope_type } : {}),
        ...(role.scope_key ? { scopeKey: role.scope_key } : {}),
      })),
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':id/enrollment-token')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('admin_accounts.manage')
  @Header('Cache-Control', 'no-store')
  async reissueEnrollment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = revisionSchema.parse(body);
    return this.principals.reissueEnrollment(session(request), request, uuid.parse(id), {
      expectedRevision: input.expected_revision,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':id/reset-enrollment')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('admin_accounts.manage')
  @Header('Cache-Control', 'no-store')
  async resetEnrollment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = revisionSchema.parse(body);
    return this.principals.resetEnrollment(session(request), request, uuid.parse(id), {
      expectedRevision: input.expected_revision,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':id/disable')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('admin_accounts.manage')
  @Header('Cache-Control', 'no-store')
  async disable(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = revisionSchema.parse(body);
    return this.principals.disable(session(request), request, uuid.parse(id), {
      expectedRevision: input.expected_revision,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}

@Controller('api/v1/admin/admin-sessions')
@UseFilters(AdminExceptionFilter)
@UseGuards(
  AdminHostGuard,
  AdminOriginGuard,
  AdminSessionGuard,
  AdminPermissionGuard,
  AdminStepUpGuard,
)
@requireAdminPermission('admin_accounts.manage')
export class AdminSessionManagementController {
  constructor(private readonly principals: AdminPrincipalService) {}

  @Post(':id/revoke')
  @Header('Cache-Control', 'no-store')
  async revoke(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = revisionSchema.pick({ reason: true }).parse(body);
    if (!request.adminSession) adminAuthError('ADMIN_SESSION_REQUIRED');
    return this.principals.revokeSession(request.adminSession, request, uuid.parse(id), {
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
