import { Catch, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

import {
  ProviderWebhookNotFoundError,
  ProviderWebhookRequestError,
} from './provider-webhook.errors.js';

interface HttpResponse {
  status(code: number): HttpResponse;
  set(name: string, value: string): HttpResponse;
  json(body: unknown): void;
}

@Catch()
export class ProviderWebhookExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    response.set('Cache-Control', 'no-store');
    if (error instanceof ProviderWebhookNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        error: { code: 'PROVIDER_WEBHOOK_NOT_FOUND', message: 'Webhook endpoint not found' },
      });
      return;
    }
    if (error instanceof ProviderWebhookRequestError) {
      const unauthorized = error.kind === 'unauthorized';
      response.status(unauthorized ? HttpStatus.UNAUTHORIZED : HttpStatus.BAD_REQUEST).json({
        error: {
          code: unauthorized ? 'PROVIDER_WEBHOOK_UNAUTHORIZED' : 'PROVIDER_WEBHOOK_INVALID',
          message: 'Webhook request rejected',
        },
      });
      return;
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'PROVIDER_WEBHOOK_UNAVAILABLE', message: 'Webhook service unavailable' },
    });
  }
}
