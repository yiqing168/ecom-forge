import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
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
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest } from './admin-http.js';
import { AdminModelConfigurationService } from './admin-model-configuration.service.js';

const purpose = z.enum(['brain', 'image', 'video']);
const protocol = z.enum(['openai', 'anthropic', 'google']);
const probeBody = z
  .strictObject({
    purpose,
    protocol_family: protocol,
    base_url: z.string().trim().min(1).max(512),
    api_key: z.string().min(8).max(16_384).optional(),
    configuration_id: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (!value.api_key && !value.configuration_id) {
      context.addIssue({
        code: 'custom',
        path: ['api_key'],
        message: 'API Key is required for a new model configuration',
      });
    }
    if (value.purpose !== 'brain' && value.protocol_family !== 'openai') {
      context.addIssue({
        code: 'custom',
        path: ['protocol_family'],
        message: 'Image and video models use the OpenAI protocol',
      });
    }
  });
const saveBody = z.strictObject({
  probe_token: z.string().min(32).max(256_000),
  selected_model_id: z.string().min(1).max(256),
  reason: z.string().trim().min(1).max(500),
});
const updateBody = saveBody.extend({ expected_revision: z.int().positive() });
const money = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const imageCredits = z.strictObject({ '1k': money, '2k': money, '4k': money });
const videoCredits = z.strictObject({ '720p': money, '1080p': money, '4k': money });
const creditsBody = z.strictObject({
  prices: z.union([imageCredits, videoCredits]),
  expected_revision: z.int().positive(),
  reason: z.string().trim().min(1).max(500),
});
const reasonBody = z.strictObject({
  expected_revision: z.int().positive(),
  reason: z.string().trim().min(1).max(500),
});

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

@Controller('api/v1/admin/model-configurations')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminModelConfigurationController {
  constructor(
    @Inject(AdminModelConfigurationService)
    private readonly service: AdminModelConfigurationService,
  ) {}

  @Get()
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('models.read')
  @Header('Cache-Control', 'no-store')
  list() {
    return this.service.list();
  }

  @Get(':id')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard)
  @requireAdminPermission('models.read')
  @Header('Cache-Control', 'no-store')
  get(@Param('id') id: string) {
    return this.service.get(z.uuid().parse(id));
  }

  @Post('probe-models')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('models.write')
  @Header('Cache-Control', 'no-store')
  probe(@Body() body: unknown, @Req() request: AdminRequest) {
    return this.service.probe(session(request), probeBody.parse(body));
  }

  @Post()
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('models.write')
  @Header('Cache-Control', 'no-store')
  create(@Body() body: unknown, @Req() request: AdminRequest) {
    return this.service.create(
      session(request),
      request,
      saveBody.parse(body),
      idempotencyKey(request),
    );
  }

  @Patch(':id')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('models.write')
  @Header('Cache-Control', 'no-store')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    return this.service.update(
      session(request),
      request,
      z.uuid().parse(id),
      updateBody.parse(body),
      idempotencyKey(request),
    );
  }

  @Put(':id/credits')
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('pricing.write')
  @Header('Cache-Control', 'no-store')
  putCredits(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    return this.service.putCredits(
      session(request),
      request,
      z.uuid().parse(id),
      creditsBody.parse(body),
      idempotencyKey(request),
    );
  }

  @Delete(':id')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard, AdminPermissionGuard, AdminStepUpGuard)
  @requireAdminPermission('models.publish')
  @Header('Cache-Control', 'no-store')
  remove(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    return this.service.remove(
      session(request),
      request,
      z.uuid().parse(id),
      reasonBody.parse(body),
      idempotencyKey(request),
    );
  }
}
