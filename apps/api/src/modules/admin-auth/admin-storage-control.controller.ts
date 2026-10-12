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
import { AdminStorageControlService } from './admin-storage-control.service.js';

const secret = z.union([
  z.string().min(8).max(16_384),
  z.record(z.string().min(1).max(64), z.string().min(1).max(16_384)),
]);
const channel = z.strictObject({
  purpose: z.literal('private_assets'),
  adapter_key: z.string().min(1).max(128),
  endpoint_profile_key: z.string().min(1).max(128),
  region: z.string().min(1).max(64).nullable().optional(),
  bucket: z.string().min(3).max(63),
  root_prefix: z.string().max(256),
  display_name: z.string().min(1).max(120).optional(),
  reason: z.string().min(1).max(500),
});
const channelList = z.strictObject({
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  adapter_key: z.string().min(1).max(128).optional(),
  bucket: z.string().min(1).max(63).optional(),
  status: z.enum(['draft', 'active', 'disabled']).optional(),
});

function session(request: AdminRequest) {
  if (!request.adminSession) adminAuthError('ADMIN_SESSION_REQUIRED');
  return request.adminSession;
}

function key(request: AdminRequest): string {
  const value = request.headers['idempotency-key'];
  const result = Array.isArray(value) ? value[0] : value;
  if (!result) adminAuthError('ADMIN_IDEMPOTENCY_KEY_INVALID', 400);
  return result;
}

@Controller('api/v1/admin')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminStorageControlController {
  constructor(
    @Inject(AdminStorageControlService) private readonly service: AdminStorageControlService,
  ) {}

  @Get('storage-adapters')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('storage.read')
  @Header('Cache-Control', 'no-store')
  adapters() {
    return this.service.adapters();
  }

  @Get('storage-channels')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('storage.read')
  @Header('Cache-Control', 'no-store')
  listChannels(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = channelList.parse(query);
    return this.service.listChannels(session(request), {
      cursor: input.cursor,
      limit: input.limit,
      adapterKey: input.adapter_key,
      bucket: input.bucket,
      status: input.status,
    });
  }

  @Get('storage-channels/:id')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('storage.read')
  @Header('Cache-Control', 'no-store')
  getChannel(@Param('id') channelId: string) {
    return this.service.getChannel(z.uuid().parse(channelId));
  }

  @Post('storage-channels')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('storage_keys.rotate')
  @Header('Cache-Control', 'no-store')
  createChannel(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = channel.parse(body);
    return this.service.createChannel(
      session(request),
      request,
      {
        channel: {
          purpose: input.purpose,
          adapter_key: input.adapter_key,
          endpoint_profile_key: input.endpoint_profile_key,
          ...(input.region !== undefined ? { region: input.region } : {}),
          bucket: input.bucket,
          root_prefix: input.root_prefix,
        },
        ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
        reason: input.reason,
      },
      key(request),
    );
  }

  @Post('storage-channels/:id/credentials')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('storage_keys.rotate')
  @Header('Cache-Control', 'no-store')
  createCredential(
    @Param('id') channelId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = z.strictObject({ secret, reason: z.string().min(1).max(500) }).parse(body);
    return this.service.createCredential(session(request), request, channelId, {
      secret: input.secret,
      reason: input.reason,
      idempotencyKey: key(request),
    });
  }

  @Post('storage-credentials/:id/validate')
  @HttpCode(202)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('storage_keys.rotate')
  @Header('Cache-Control', 'no-store')
  validateCredential(
    @Param('id') credentialId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = z.strictObject({ reason: z.string().min(1).max(500) }).parse(body);
    return this.service.validateCredential(
      session(request),
      request,
      z.uuid().parse(credentialId),
      {
        reason: input.reason,
        idempotencyKey: key(request),
      },
    );
  }

  @Get('storage-validation-runs/:id')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('storage.read')
  @Header('Cache-Control', 'no-store')
  validationRun(@Param('id') runId: string) {
    return this.service.validationRun(z.uuid().parse(runId));
  }

  @Post('storage-credentials/:id/activate')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('storage_keys.rotate')
  @Header('Cache-Control', 'no-store')
  activateCredential(
    @Param('id') credentialId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = z
      .strictObject({
        expected_credential_revision: z.number().int().positive(),
        expected_channel_revision: z.number().int().positive(),
        validation_run_id: z.uuid(),
        evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
        reason: z.string().min(1).max(500),
      })
      .parse(body);
    return this.service.activateCredential(
      session(request),
      request,
      z.uuid().parse(credentialId),
      {
        expectedCredentialRevision: input.expected_credential_revision,
        expectedChannelRevision: input.expected_channel_revision,
        validationRunId: input.validation_run_id,
        evidenceDigest: input.evidence_digest,
        reason: input.reason,
        idempotencyKey: key(request),
      },
    );
  }

  @Post('storage-credentials/:id/revoke')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('storage_keys.rotate')
  @Header('Cache-Control', 'no-store')
  revokeCredential(
    @Param('id') credentialId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = z
      .strictObject({
        expected_credential_revision: z.number().int().positive(),
        expected_channel_revision: z.number().int().positive(),
        expected_runtime_revision: z.number().int().nonnegative(),
        reason: z.string().min(1).max(500),
      })
      .parse(body);
    return this.service.revokeCredential(session(request), request, z.uuid().parse(credentialId), {
      expectedCredentialRevision: input.expected_credential_revision,
      expectedChannelRevision: input.expected_channel_revision,
      expectedRuntimeRevision: input.expected_runtime_revision,
      reason: input.reason,
      idempotencyKey: key(request),
    });
  }

  @Post('storage-channels/:id/activate')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('storage_keys.rotate')
  @Header('Cache-Control', 'no-store')
  activateChannel(
    @Param('id') channelId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = z
      .strictObject({
        expected_runtime_revision: z.number().int().nonnegative(),
        expected_channel_revision: z.number().int().positive(),
        validation_run_id: z.uuid(),
        evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
        reason: z.string().min(1).max(500),
      })
      .parse(body);
    return this.service.activateChannel(session(request), request, z.uuid().parse(channelId), {
      expectedRuntimeRevision: input.expected_runtime_revision,
      expectedChannelRevision: input.expected_channel_revision,
      validationRunId: input.validation_run_id,
      evidenceDigest: input.evidence_digest,
      reason: input.reason,
      idempotencyKey: key(request),
    });
  }

  @Post('storage-channels/:id/disable')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('storage_keys.rotate')
  @Header('Cache-Control', 'no-store')
  disableChannel(
    @Param('id') channelId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    const input = z
      .strictObject({
        expected_channel_revision: z.number().int().positive(),
        expected_runtime_revision: z.number().int().nonnegative(),
        reason: z.string().min(1).max(500),
      })
      .parse(body);
    return this.service.disableChannel(session(request), request, z.uuid().parse(channelId), {
      expectedChannelRevision: input.expected_channel_revision,
      expectedRuntimeRevision: input.expected_runtime_revision,
      reason: input.reason,
      idempotencyKey: key(request),
    });
  }
}
