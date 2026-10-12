import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { AuthenticationService } from '../auth/authentication.service.js';
import {
  headerValue,
  requestIpBucket,
  type ApiRequest,
  type ApiResponse,
} from '../auth/auth-http.js';
import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { AuthWriteGuard } from '../auth/auth-write.guard.js';
import { AbuseProtectionService } from '../auth/abuse-protection.service.js';
import { AssetService } from './asset.service.js';
import { AssetWriteGuard } from './asset-write.guard.js';
import { requireResourceUser } from './resource-auth.js';
import { ResourceExceptionFilter } from './resource-exception.filter.js';
import {
  accessUrlSchema,
  assetListQuerySchema,
  completeUploadSchema,
  deleteAssetSchema,
  parseIdempotencyKey,
  retryAssetSchema,
  uploadIntentSchema,
  uuid,
} from './resource.schemas.js';

const uploadQuerySchema = z.strictObject({ capability: z.string().min(1).max(4096) });
const contentQuerySchema = z.strictObject({
  capability: z.string().min(1).max(4096).optional(),
  variant: z.enum(['original', 'thumbnail']),
  purpose: z.enum(['preview', 'download']),
});
type RawRequest = ApiRequest & { body?: Buffer };

@Controller('api/v1/assets')
@UseFilters(ResourceExceptionFilter)
export class AssetController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(AbuseProtectionService) private readonly abuseProtection: AbuseProtectionService,
    @Inject(AssetService) private readonly assets: AssetService,
  ) {}

  @Post('upload-url')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async uploadUrl(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response, true);
    await this.abuseProtection.assertMediaRequest(
      userId,
      requestIpBucket(request, this.config.trustedProxyCidrs),
      'upload',
    );
    return {
      ok: true,
      data: await this.assets.createUpload(
        userId,
        uploadIntentSchema.parse(body),
        parseIdempotencyKey(key),
      ),
      error: null,
    };
  }

  @Put('uploads/:uploadId/content')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AssetWriteGuard)
  async uploadContent(
    @Param('uploadId') uploadId: string,
    @Query() query: Record<string, unknown>,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: RawRequest,
  ) {
    const parsed = uploadQuerySchema.parse(query);
    await this.assets.uploadContent({
      uploadId: uuid.parse(uploadId),
      capability: parsed.capability,
      contentType: contentType?.split(';', 1)[0]?.trim() ?? '',
      body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      ipBucket: requestIpBucket(request, this.config.trustedProxyCidrs),
    });
  }

  @Post('complete')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async complete(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response, true);
    return {
      ok: true,
      data: await this.assets.complete(
        userId,
        completeUploadSchema.parse(body),
        parseIdempotencyKey(key),
      ),
      error: null,
    };
  }

  @Post(':id/retry-processing')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async retry(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    retryAssetSchema.parse(body);
    const userId = await requireResourceUser(this.authentication, request, response, true);
    return {
      ok: true,
      data: await this.assets.retry(userId, uuid.parse(id), parseIdempotencyKey(key)),
      error: null,
    };
  }

  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async delete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response, true);
    return {
      ok: true,
      data: await this.assets.delete(
        userId,
        uuid.parse(id),
        deleteAssetSchema.parse(body),
        parseIdempotencyKey(key),
      ),
      error: null,
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response);
    return {
      ok: true,
      data: await this.assets.list(userId, assetListQuerySchema.parse(query)),
      error: null,
    };
  }

  @Post(':id/access-url')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async access(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    parseIdempotencyKey(key);
    const userId = await requireResourceUser(this.authentication, request, response);
    return {
      ok: true,
      data: await this.assets.access(
        userId,
        uuid.parse(id),
        accessUrlSchema.parse(body),
        requestIpBucket(request, this.config.trustedProxyCidrs),
      ),
      error: null,
    };
  }

  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: RawRequest,
    @Res() response: Response,
  ) {
    const parsed = contentQuerySchema.parse(query);
    const userId = parsed.capability
      ? undefined
      : await requireResourceUser(this.authentication, request, response);
    const content = await this.assets.readContent({
      assetId: uuid.parse(id),
      variant: parsed.variant,
      purpose: parsed.purpose,
      capability: parsed.capability,
      userId,
      ipBucket: requestIpBucket(request, this.config.trustedProxyCidrs),
      ifNoneMatch: headerValue(request, 'if-none-match'),
    });
    const cacheControl = 'private, no-cache';
    if (content.notModified) {
      response.setHeader('Cache-Control', cacheControl);
      response.setHeader('Vary', 'Cookie');
      response.setHeader('ETag', content.etag);
      response.status(304).end();
      return;
    }
    response.setHeader('Cache-Control', cacheControl);
    response.setHeader('Vary', 'Cookie');
    response.setHeader('ETag', content.etag);
    response.type(content.mimeType);
    if (parsed.purpose === 'download') {
      response.attachment(content.filename);
    }
    response.send(content.body);
  }
}
