import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { AuthExceptionFilter } from './auth-exception.filter.js';
import { AuthBadRequestError } from './auth-errors.js';
import { AuthWriteGuard } from './auth-write.guard.js';
import { REGISTRATION_SERVICE, REGISTRATION_VERIFICATION } from './auth.tokens.js';
import { AuthenticationService } from './authentication.service.js';
import { rateLimitIpBucket, TrustedProxyResolver } from '../../shared/http/client-ip.js';
import type { RegistrationService } from './registration/registration.service.js';
import type { RegistrationVerificationService } from './registration/verification.service.js';
import { DeviceIdentity } from './security/device-identity.js';
import { HmacKeyring } from './security/hmac-keyring.js';
import { copyAuthCookies, requestHeaders, type ApiRequest, type ApiResponse } from './auth-http.js';

const registerSchema = z
  .object({
    email: z.string(),
    password: z.string().min(8).max(128),
    display_name: z.string().trim().min(1).max(120),
    invite_code: z.string().trim().min(1).max(256),
    agreement_version: z.string().trim().min(1).max(64),
  })
  .strict();

const loginSchema = z.object({ email: z.string(), password: z.string().min(1).max(128) }).strict();

const verificationRequestSchema = z
  .object({ verification_ticket: z.string().min(20).max(512) })
  .strict();
const verifyEmailSchema = z
  .object({ verification_ticket: z.string().min(20).max(512), code: z.string().regex(/^\d{6}$/) })
  .strict();
const resetRequestSchema = z.object({ email: z.string() }).strict();
const resetConfirmSchema = z
  .object({
    email: z.string(),
    code: z.string().regex(/^\d{6}$/),
    new_password: z.string().min(8).max(128),
  })
  .strict();

function clientIp(request: ApiRequest, resolver: TrustedProxyResolver): string {
  const remote = request.socket.remoteAddress ?? '127.0.0.1';
  return rateLimitIpBucket(resolver.resolve(remote, request.headers));
}

@Controller('api/v1/auth')
@UseFilters(AuthExceptionFilter)
export class AuthController {
  private readonly proxyResolver: TrustedProxyResolver;
  private readonly deviceIdentity: DeviceIdentity;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(REGISTRATION_SERVICE) private readonly registration: RegistrationService,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(REGISTRATION_VERIFICATION)
    private readonly verification: RegistrationVerificationService,
  ) {
    this.proxyResolver = new TrustedProxyResolver(config.trustedProxyCidrs);
    this.deviceIdentity = new DeviceIdentity(
      new HmacKeyring(config.auth.rateLimitHashKeys),
      config.appEnv === 'staging' || config.appEnv === 'beta' || config.appEnv === 'production',
    );
  }

  private requestContext(request: ApiRequest, response: ApiResponse) {
    return {
      ipBucket: clientIp(request, this.proxyResolver),
      deviceBucket: this.deviceIdentity.resolve(request, response),
    };
  }

  @Post('register')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async register(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    if (!idempotencyKey?.trim()) throw new AuthBadRequestError();
    const input = registerSchema.parse(body);
    const result = await this.registration.register({
      email: input.email,
      password: input.password,
      displayName: input.display_name,
      inviteCode: input.invite_code,
      agreementVersion: input.agreement_version,
      idempotencyKey: idempotencyKey.trim(),
      ...this.requestContext(request, response),
    });
    copyAuthCookies(result.headers, response);
    return {
      verification_ticket: result.verificationTicket,
      email: result.maskedEmail,
      expires_in_seconds: result.expiresInSeconds,
      resend_cooldown_seconds: result.resendCooldownSeconds,
    };
  }

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async login(
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const input = loginSchema.parse(body);
    const result = await this.authentication.login(
      input.email,
      input.password,
      this.requestContext(request, response),
    );
    copyAuthCookies(result.headers, response);
    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        display_name: result.user.displayName,
        email_verified: result.user.emailVerified,
      },
      access: {
        can_create: result.access.canCreate,
        can_upload: result.access.canUpload,
        can_charge: result.access.canCharge,
        restriction_reason: result.access.restrictionReason,
      },
    };
  }

  @Post('email-verification/request')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async requestVerification(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    if (!idempotencyKey?.trim()) throw new AuthBadRequestError();
    const input = verificationRequestSchema.parse(body);
    const result = await this.verification.resend(
      input.verification_ticket,
      idempotencyKey.trim(),
      this.requestContext(request, response),
    );
    return {
      verification_ticket: result.verificationTicket,
      expires_in_seconds: result.expiresInSeconds,
      resend_cooldown_seconds: result.resendCooldownSeconds,
    };
  }

  @Post('verify-email')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async verifyEmail(
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const input = verifyEmailSchema.parse(body);
    const result = await this.verification.verify(
      input.verification_ticket,
      input.code,
      this.requestContext(request, response),
    );
    const access = await this.authentication.accessForUser(
      result.user.id,
      result.user.emailVerified,
    );
    copyAuthCookies(result.headers, response);
    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        display_name: result.user.displayName,
        email_verified: result.user.emailVerified,
      },
      access: {
        can_create: access.canCreate,
        can_upload: access.canUpload,
        can_charge: access.canCharge,
        restriction_reason: access.restrictionReason,
      },
    };
  }

  @Post('password-reset/request')
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  @UseGuards(AuthWriteGuard)
  async requestPasswordReset(
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const input = resetRequestSchema.parse(body);
    await this.authentication.requestPasswordReset(
      input.email,
      this.requestContext(request, response),
    );
    return { status: 'accepted' };
  }

  @Post('password-reset/confirm')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async confirmPasswordReset(
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const input = resetConfirmSchema.parse(body);
    await this.authentication.confirmPasswordReset(
      input.email,
      input.code,
      input.new_password,
      this.requestContext(request, response),
    );
    return { status: 'reset' };
  }
}

@Controller('api/v1')
@UseFilters(AuthExceptionFilter)
export class CurrentUserController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
  ) {}

  @Get('me')
  @Header('Cache-Control', 'no-store')
  async me(@Req() request: ApiRequest, @Res({ passthrough: true }) response: ApiResponse) {
    const session = await this.authentication.currentSession(requestHeaders(request));
    if (!session) {
      response.status(401);
      return { error: { code: 'AUTH_SESSION_REQUIRED', message: '请先登录' } };
    }
    copyAuthCookies(session.headers, response);
    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        display_name: session.user.displayName,
        email_verified: session.user.emailVerified,
      },
      access: {
        can_create: session.access.canCreate,
        can_upload: session.access.canUpload,
        can_charge: session.access.canCharge,
        restriction_reason: session.access.restrictionReason,
      },
    };
  }
}
