import { BadRequestException, HttpStatus } from '@nestjs/common';

import {
  AuthBadRequestError,
  AuthOtpAttemptsExceededError,
  AuthOtpInvalidError,
  InvalidCredentialsError,
  VerificationTicketInvalidError,
} from './auth-errors.js';
import { mapAuthError } from './auth-exception.filter.js';
import { AuthControlPlaneUnavailableError } from './rate-limit/verification-rate-limiter.js';
import {
  AuthMailUnavailableError,
  AuthRateLimitedError,
} from './registration/registration.service.js';
import {
  IdempotencyConflictError,
  RegistrationNotEligibleError,
} from './registration/registration-gate.js';
import { InvalidEmailError } from './security/email.js';

describe('authentication error responses', () => {
  it.each([
    [
      new BadRequestException(),
      HttpStatus.BAD_REQUEST,
      'AUTH_REQUEST_REJECTED',
      '请求未通过安全校验，请刷新页面后重试',
    ],
    [
      new AuthBadRequestError(),
      HttpStatus.BAD_REQUEST,
      'AUTH_REQUEST_INVALID',
      '提交的信息格式不正确，请检查后重试',
    ],
    [
      new InvalidEmailError(),
      HttpStatus.BAD_REQUEST,
      'AUTH_REQUEST_INVALID',
      '提交的信息格式不正确，请检查后重试',
    ],
    [
      new RegistrationNotEligibleError(),
      HttpStatus.FORBIDDEN,
      'REGISTRATION_NOT_ELIGIBLE',
      '当前无法完成注册，请检查邀请码和邮箱是否正确',
    ],
    [
      new IdempotencyConflictError(),
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_CONFLICT',
      '提交内容已发生变化，请刷新页面后重新操作',
    ],
    [
      new AuthRateLimitedError(),
      HttpStatus.TOO_MANY_REQUESTS,
      'AUTH_OTP_RATE_LIMITED',
      '操作过于频繁，请稍后再试',
    ],
    [
      new AuthControlPlaneUnavailableError(),
      HttpStatus.SERVICE_UNAVAILABLE,
      'AUTH_TEMPORARILY_UNAVAILABLE',
      '认证服务暂时不可用，请稍后重试',
    ],
    [
      new AuthMailUnavailableError({ state: 'not_dispatched', errorCode: 'TEST_FAILURE' }),
      HttpStatus.SERVICE_UNAVAILABLE,
      'AUTH_MAIL_UNAVAILABLE',
      '验证码邮件暂未发出，请稍后重试',
    ],
    [
      new InvalidCredentialsError(),
      HttpStatus.UNAUTHORIZED,
      'AUTH_INVALID_CREDENTIALS',
      '邮箱或密码错误，请检查后重试',
    ],
    [
      new VerificationTicketInvalidError(),
      HttpStatus.UNAUTHORIZED,
      'AUTH_VERIFICATION_TICKET_INVALID',
      '验证已失效，请重新获取验证码',
    ],
    [
      new AuthOtpAttemptsExceededError(),
      HttpStatus.TOO_MANY_REQUESTS,
      'AUTH_OTP_ATTEMPTS_EXCEEDED',
      '验证码错误次数过多，请重新获取',
    ],
    [
      new AuthOtpInvalidError(),
      HttpStatus.UNPROCESSABLE_ENTITY,
      'AUTH_OTP_INVALID_OR_EXPIRED',
      '验证码错误或已过期，请检查后重试',
    ],
    [
      new Error('internal details must not escape'),
      HttpStatus.INTERNAL_SERVER_ERROR,
      'AUTH_INTERNAL_ERROR',
      '服务暂时不可用，请稍后重试',
    ],
  ])('maps %s to a stable code and actionable safe message', (error, status, code, message) => {
    expect(mapAuthError(error)).toEqual({ status, body: { code, message } });
  });
});
