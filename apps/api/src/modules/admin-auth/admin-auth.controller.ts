import {
  Body,
  Controller,
  Get,
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
import { AdminAuthService } from './admin-auth.service.js';
import { AdminCredentialService } from './admin-credential.service.js';
import { adminAuthError } from './admin-errors.js';
import { AdminExceptionFilter } from './admin-exception.filter.js';
import { AdminHostGuard, AdminOriginGuard } from './admin-guards.js';
import type { AdminRequest, AdminResponse } from './admin-http.js';
import { clearAdminCookie, setAdminCookie } from './admin-http.js';

const loginSchema = z
  .object({ identifier: z.string().min(1).max(320), password: z.string().min(1).max(128) })
  .strict();
const totpSchema = z
  .object({
    challenge_id: z.string().uuid(),
    challenge_token: z.string().min(20).max(512),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();
const recoverySchema = z
  .object({
    challenge_id: z.string().uuid(),
    challenge_token: z.string().min(20).max(512),
    recovery_code: z.string().min(16).max(64),
  })
  .strict();
const stepUpSchema = z
  .object({ password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/) })
  .strict();
const enrollmentStartSchema = z
  .object({
    enrollment_token: z.string().min(20).max(512),
    new_password: z.string().min(12).max(128),
  })
  .strict();
const passwordChangeSchema = z.object({ new_password: z.string().min(12).max(128) }).strict();
const emptySchema = z.object({}).strict();

function writeSession(
  response: AdminResponse,
  result: { context: { rawToken: string }; csrfToken: string },
  secure: boolean,
  cookieName: string,
  maxAge: number,
): void {
  setAdminCookie(response, cookieName, result.context.rawToken, secure, maxAge);
}

@Controller('api/v1/admin/auth')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminAuthController {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminCredentialService) private readonly credentials: AdminCredentialService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('local-session')
  @Header('Cache-Control', 'no-store')
  localSessionAvailability(@Req() request: AdminRequest) {
    if (!this.auth.localSessionAvailable(request)) {
      adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    }
    return { local_login_available: true };
  }

  @Post('local-session')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async localSession(
    @Body() body: unknown,
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    emptySchema.parse(body);
    const result = await this.auth.createLocalSession(request);
    writeSession(
      response,
      result,
      this.config.admin.cookieSecure,
      this.config.admin.cookieName,
      this.config.admin.sessionTtlSeconds,
    );
    return {
      principal: result.principal,
      csrf_token: result.csrfToken,
      mfa_level: result.context.mfaLevel,
      step_up_expires_at: result.context.stepUpAt
        ? new Date(
            result.context.stepUpAt.getTime() + this.config.admin.stepUpTtlSeconds * 1_000,
          ).toISOString()
        : null,
      local_login_available: true,
    };
  }

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = loginSchema.parse(body);
    const result = await this.auth.login(input.identifier, input.password, request);
    return {
      challenge_id: result.challengeId,
      challenge_token: result.challengeToken,
      expires_in_seconds: result.expiresInSeconds,
      methods: ['totp', 'recovery'],
    };
  }

  @Post('mfa/totp/verify')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async verifyTotp(
    @Body() body: unknown,
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    const input = totpSchema.parse(body);
    const result = await this.auth.verifyLoginMfa(
      input.challenge_id,
      input.challenge_token,
      input.code,
      request,
    );
    writeSession(
      response,
      result.session,
      this.config.admin.cookieSecure,
      this.config.admin.cookieName,
      this.config.admin.sessionTtlSeconds,
    );
    return {
      principal: result.session.principal,
      csrf_token: result.session.csrfToken,
      mfa_level: 'totp',
    };
  }

  @Post('mfa/recovery/verify')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async verifyRecoveryCode(
    @Body() body: unknown,
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    const input = recoverySchema.parse(body);
    const result = await this.auth.verifyLoginRecoveryCode(
      input.challenge_id,
      input.challenge_token,
      input.recovery_code,
      request,
    );
    writeSession(
      response,
      result.session,
      this.config.admin.cookieSecure,
      this.config.admin.cookieName,
      this.config.admin.sessionTtlSeconds,
    );
    return {
      principal: result.session.principal,
      csrf_token: result.session.csrfToken,
      mfa_level: 'recovery',
      recovery_restricted: true,
    };
  }

  @Get('session')
  @Header('Cache-Control', 'no-store')
  async session(@Req() request: AdminRequest) {
    const result = await this.auth.sessionInfo(request);
    return {
      principal: result.principal,
      permissions: result.context.permissions,
      scopes: result.context.scopes,
      csrf_token: result.csrfToken,
      mfa_level: result.context.mfaLevel,
      recovery_restricted: result.context.recoveryRestricted,
      step_up_expires_at: result.context.stepUpAt
        ? new Date(
            result.context.stepUpAt.getTime() + this.config.admin.stepUpTtlSeconds * 1_000,
          ).toISOString()
        : null,
      session_expires_at: result.context.sessionExpiresAt.toISOString(),
    };
  }

  @Post('step-up')
  @Header('Cache-Control', 'no-store')
  async stepUp(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = stepUpSchema.parse(body);
    const result = await this.auth.stepUp(request, input.password, input.code);
    return {
      csrf_token: result.csrfToken,
      step_up_at: result.context.stepUpAt?.toISOString() ?? null,
    };
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  async logout(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: AdminResponse,
  ): Promise<void> {
    await this.auth.logout(request);
    clearAdminCookie(response, this.config.admin.cookieName, this.config.admin.cookieSecure);
  }

  @Post('sessions/revoke-all')
  @Header('Cache-Control', 'no-store')
  async revokeOtherSessions(@Req() request: AdminRequest) {
    const result = await this.auth.revokeOtherSessions(request);
    return { revoked_count: result.revokedCount };
  }

  @Post('password/change')
  @Header('Cache-Control', 'no-store')
  async changePassword(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = passwordChangeSchema.parse(body);
    await this.credentials.changePassword(request, input.new_password);
    return { status: 'changed' };
  }

  @Post('mfa/totp/rotate/start')
  @Header('Cache-Control', 'no-store')
  async startTotpRotation(@Body() body: unknown, @Req() request: AdminRequest) {
    emptySchema.parse(body);
    const result = await this.credentials.startTotpRotation(request);
    return {
      challenge_id: result.challengeId,
      challenge_token: result.challengeToken,
      totp_secret: result.totpSecret,
      provisioning_uri: result.provisioningUri,
      expires_in_seconds: result.expiresInSeconds,
    };
  }

  @Post('mfa/totp/rotate/confirm')
  @Header('Cache-Control', 'no-store')
  async confirmTotpRotation(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = totpSchema.parse(body);
    await this.credentials.confirmTotpRotation(
      request,
      input.challenge_id,
      input.challenge_token,
      input.code,
    );
    return { status: 'rotated' };
  }

  @Post('mfa/recovery-codes/rotate')
  @Header('Cache-Control', 'no-store')
  async rotateRecoveryCodes(@Body() body: unknown, @Req() request: AdminRequest) {
    emptySchema.parse(body);
    const result = await this.credentials.rotateRecoveryCodes(request);
    return { recovery_codes: result.recoveryCodes, plaintext_available: true };
  }
}

@Controller('api/v1/admin/enrollment')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard)
export class AdminEnrollmentController {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('start')
  @Header('Cache-Control', 'no-store')
  async enrollmentStart(@Body() body: unknown, @Req() request: AdminRequest) {
    const input = enrollmentStartSchema.parse(body);
    const result = await this.auth.startEnrollment(
      request,
      input.enrollment_token,
      input.new_password,
    );
    return {
      challenge_id: result.challengeId,
      challenge_token: result.challengeToken,
      totp_secret: result.totpSecret,
      provisioning_uri: result.provisioningUri,
      expires_in_seconds: result.expiresInSeconds,
    };
  }

  @Post('activate')
  @Header('Cache-Control', 'no-store')
  async enrollmentActivate(
    @Body() body: unknown,
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    const input = totpSchema.parse(body);
    const result = await this.auth.activateEnrollment(
      input.challenge_id,
      input.challenge_token,
      input.code,
      request,
    );
    writeSession(
      response,
      result.session,
      this.config.admin.cookieSecure,
      this.config.admin.cookieName,
      this.config.admin.sessionTtlSeconds,
    );
    return {
      principal: result.session.principal,
      csrf_token: result.session.csrfToken,
      recovery_codes: result.recoveryCodes,
      plaintext_available: true,
    };
  }
}
