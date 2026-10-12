import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
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
import { ArtifactService } from './artifact.service.js';
import { requireResourceUser } from './resource-auth.js';
import { ResourceExceptionFilter } from './resource-exception.filter.js';
import {
  accessUrlSchema,
  artifactListQuerySchema,
  parseIdempotencyKey,
  saveArtifactSchema,
  uuid,
} from './resource.schemas.js';

const contentQuerySchema = z.strictObject({
  capability: z.string().min(1).max(4096).optional(),
  variant: z.enum(['original', 'thumbnail']),
  purpose: z.enum(['preview', 'download']),
});

@Controller('api/v1/artifacts')
@UseFilters(ResourceExceptionFilter)
export class ArtifactController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
  ) {}

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
      data: await this.artifacts.list(userId, artifactListQuerySchema.parse(query)),
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
      data: await this.artifacts.access(
        userId,
        uuid.parse(id),
        accessUrlSchema.parse(body),
        requestIpBucket(request, this.config.trustedProxyCidrs),
      ),
      error: null,
    };
  }

  @Post(':id/save-to-assets')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async save(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response, true);
    return {
      ok: true,
      data: await this.artifacts.saveToAssets(
        userId,
        uuid.parse(id),
        Object.fromEntries(
          Object.entries(saveArtifactSchema.parse(body)).filter(([, value]) => value !== undefined),
        ),
        parseIdempotencyKey(key),
      ),
      error: null,
    };
  }

  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res() response: Response,
  ) {
    const parsed = contentQuerySchema.parse(query);
    const userId = parsed.capability
      ? undefined
      : await requireResourceUser(this.authentication, request, response);
    const content = await this.artifacts.readContent({
      artifactId: uuid.parse(id),
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
    response.type(content.mimeType).send(content.body);
  }
}
