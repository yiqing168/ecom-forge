import { randomUUID } from 'node:crypto';

import {
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseFilters,
  type RawBodyRequest,
} from '@nestjs/common';
import { z } from 'zod';

import { ProviderWebhookExceptionFilter } from './provider-webhook.filter.js';
import { ProviderWebhookService } from './provider-webhook.service.js';

interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  body?: unknown;
}

const requestIdSchema = z.uuid();

@Controller('api/v1/webhooks/providers')
@UseFilters(ProviderWebhookExceptionFilter)
export class ProviderWebhookController {
  constructor(private readonly webhooks: ProviderWebhookService) {}

  @Post(':provider')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  receive(@Param('provider') provider: string, @Req() request: RawBodyRequest<WebhookRequest>) {
    const requestId = request.headers['x-request-id'];
    const parsedRequestId =
      typeof requestId === 'string' ? requestIdSchema.safeParse(requestId) : undefined;
    const traceId = parsedRequestId?.success ? parsedRequestId.data : randomUUID();
    const rawBody = request.rawBody ?? (Buffer.isBuffer(request.body) ? request.body : undefined);
    return this.webhooks.accept(provider, rawBody, request.headers, traceId);
  }
}
