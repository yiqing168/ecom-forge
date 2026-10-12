import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';
import { requestFailureDiagnostic } from '../../shared/http/request-failure-diagnostic.js';

import {
  AuthBadRequestError,
  AuthOtpAttemptsExceededError,
  AuthOtpInvalidError,
  InvalidCredentialsError,
  VerificationTicketInvalidError,
} from './auth-errors.js';

import { InvalidEmailError } from './security/email.js';
import { AuthControlPlaneUnavailableError } from './rate-limit/verification-rate-limiter.js';
import {
  AuthMailUnavailableError,
  AuthRateLimitedError,
} from './registration/registration.service.js';
import {
  IdempotencyConflictError,
  RegistrationNotEligibleError,
} from './registration/registration-gate.js';

interface ErrorResponse {
  code: string;
  message: string;
}

interface AuthHttpResponse {
  status(code: number): void;
  json(body: unknown): void;
}

export function mapAuthError(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      body: {
        code: 'AUTH_REQUEST_REJECTED',
        message: '请求未通过安全校验，请刷新页面后重试',
      },
    };
  }
  if (error instanceof ZodError || error instanceof AuthBadRequestError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: { code: 'AUTH_REQUEST_INVALID', message: '提交的信息格式不正确，请检查后重试' },
    };
  }
  if (error instanceof InvalidEmailError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: { code: 'AUTH_REQUEST_INVALID', message: '提交的信息格式不正确，请检查后重试' },
    };
  }
  if (error instanceof RegistrationNotEligibleError) {
    return {
      status: HttpStatus.FORBIDDEN,
      body: {
        code: 'REGISTRATION_NOT_ELIGIBLE',
        message: '当前无法完成注册，请检查邀请码和邮箱是否正确',
      },
    };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      body: { code: 'IDEMPOTENCY_CONFLICT', message: '提交内容已发生变化，请刷新页面后重新操作' },
    };
  }
  if (error instanceof AuthRateLimitedError) {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      body: { code: 'AUTH_OTP_RATE_LIMITED', message: '操作过于频繁，请稍后再试' },
    };
  }
  if (error instanceof AuthControlPlaneUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { code: 'AUTH_TEMPORARILY_UNAVAILABLE', message: '认证服务暂时不可用，请稍后重试' },
    };
  }
  if (error instanceof AuthMailUnavailableError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { code: 'AUTH_MAIL_UNAVAILABLE', message: '验证码邮件暂未发出，请稍后重试' },
    };
  }
  if (error instanceof InvalidCredentialsError) {
    return {
      status: HttpStatus.UNAUTHORIZED,
      body: { code: 'AUTH_INVALID_CREDENTIALS', message: '邮箱或密码错误，请检查后重试' },
    };
  }
  if (error instanceof VerificationTicketInvalidError) {
    return {
      status: HttpStatus.UNAUTHORIZED,
      body: { code: 'AUTH_VERIFICATION_TICKET_INVALID', message: '验证已失效，请重新获取验证码' },
    };
  }
  if (error instanceof AuthOtpAttemptsExceededError) {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      body: { code: 'AUTH_OTP_ATTEMPTS_EXCEEDED', message: '验证码错误次数过多，请重新获取' },
    };
  }
  if (error instanceof AuthOtpInvalidError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      body: { code: 'AUTH_OTP_INVALID_OR_EXPIRED', message: '验证码错误或已过期，请检查后重试' },
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'AUTH_INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' },
  };
}

@Catch()
export class AuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AuthExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<AuthHttpResponse>();
    const result = mapAuthError(error);
    if (Number(result.status) >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      this.logger.error({
        event: 'auth_request_failed',
        error_code: result.body.code,
        ...requestFailureDiagnostic(host, error),
      });
    }
    response.status(result.status);
    response.json({ error: result.body });
  }
}
