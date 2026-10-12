import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';

import { mapCreditError } from './credit.errors.js';

interface HttpResponse {
  status(code: number): void;
  json(body: unknown): void;
}

@Catch()
export class CreditExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (error instanceof HttpException) {
      response.status(error.getStatus());
      response.json(error.getResponse());
      return;
    }
    if (error instanceof ZodError) {
      response.status(400);
      response.json({
        error: { code: 'REQUEST_INVALID', message: '请求参数不正确，请检查后重试' },
      });
      return;
    }
    const mapped = mapCreditError(error);
    response.status(mapped.status);
    response.json({ error: mapped.body });
  }
}
