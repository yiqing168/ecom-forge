import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { SKILL_PACKAGE_STATUSES } from '@ecom-forge/types';
import { z } from 'zod';

import { AdminExceptionFilter } from './admin-exception.filter.js';
import { adminAuthError } from './admin-errors.js';
import {
  AdminHostGuard,
  AdminOriginGuard,
  AdminPermissionGuard,
  AdminSessionGuard,
  requireAdminPermission,
} from './admin-guards.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminSkillPackageService } from './admin-skill-package.service.js';

const uploadIntentBody = z.strictObject({
  file_name: z.string().trim().min(1).max(255),
  declared_size_bytes: z.number().int().positive(),
  declared_archive_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_type: z.enum(['first_party', 'legacy_owned', 'admin_upload']),
});
const completeBody = z.strictObject({ expected_revision: z.number().int().positive() });
const pageQuery = z.strictObject({
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(SKILL_PACKAGE_STATUSES).optional(),
});
const uploadQuery = z.strictObject({ capability: z.string().min(1).max(4_096) });
type RawAdminRequest = AdminRequest & { body?: Buffer };

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

@Controller('api/v1/admin/skill-packages')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard, AdminSessionGuard, AdminPermissionGuard)
export class AdminSkillPackageController {
  constructor(private readonly skillPackages: AdminSkillPackageService) {}

  @Post('upload-intents')
  @requireAdminPermission('skills.install')
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  createUploadIntent(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = uploadIntentBody.parse(body);
    return this.skillPackages.createUploadIntent(session(request), request, {
      fileName: input.file_name,
      declaredSizeBytes: input.declared_size_bytes,
      declaredArchiveSha256: input.declared_archive_sha256,
      sourceType: input.source_type,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':id/complete')
  @requireAdminPermission('skills.install')
  @Header('Cache-Control', 'no-store')
  complete(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = completeBody.parse(body);
    return this.skillPackages.complete(session(request), {
      packageRecordId: z.uuid().parse(id),
      expectedRevision: input.expected_revision,
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Get()
  @requireAdminPermission('skills.read')
  @Header('Cache-Control', 'no-store')
  list(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = pageQuery.parse(query);
    return this.skillPackages.list(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  @Get(':id')
  @requireAdminPermission('skills.read')
  @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string) {
    return this.skillPackages.detail(z.uuid().parse(id));
  }
}

@Controller('api/v1/admin/skill-packages/uploads')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard)
export class AdminSkillPackageUploadController {
  constructor(private readonly skillPackages: AdminSkillPackageService) {}

  @Put(':id/content')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  upload(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: RawAdminRequest,
  ) {
    const input = uploadQuery.parse(query);
    return this.skillPackages.uploadContent({
      packageRecordId: z.uuid().parse(id),
      capability: input.capability,
      contentType: contentType?.split(';', 1)[0]?.trim() ?? '',
      body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
    });
  }
}
