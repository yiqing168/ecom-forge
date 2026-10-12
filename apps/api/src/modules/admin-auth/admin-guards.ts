import { Inject, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AppConfig, AppEnvironment } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { TrustedProxyResolver } from '../../shared/http/client-ip.js';
import type { AdminRequest } from './admin-http.js';
import { AdminAuthService } from './admin-auth.service.js';

export const ADMIN_PERMISSION = 'admin_permission';
export const ADMIN_STEP_UP = 'admin_step_up';

export function requireAdminPermission(permission: string): MethodDecorator & ClassDecorator {
  return SetMetadata(ADMIN_PERMISSION, permission);
}

export function requireAdminStepUp(): MethodDecorator & ClassDecorator {
  return SetMetadata(ADMIN_STEP_UP, true);
}

function header(request: AdminRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function isAdminOriginAllowed(
  appEnv: AppEnvironment,
  configuredOrigin: string,
  requestOrigin: string | undefined,
): boolean {
  if (!requestOrigin || requestOrigin === configuredOrigin) return Boolean(requestOrigin);
  if (appEnv !== 'local' && appEnv !== 'test') return false;

  try {
    const configured = new URL(configuredOrigin);
    const requested = new URL(requestOrigin);
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    return (
      loopbackHosts.has(configured.hostname) &&
      loopbackHosts.has(requested.hostname) &&
      configured.protocol === requested.protocol &&
      configured.port === requested.port &&
      requested.pathname === '/' &&
      requested.search === '' &&
      requested.hash === ''
    );
  } catch {
    return false;
  }
}

@Injectable()
export class AdminHostGuard implements CanActivate {
  private readonly proxy: TrustedProxyResolver;
  private readonly sourceAllowlist: TrustedProxyResolver;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.proxy = new TrustedProxyResolver(config.admin.trustedProxyCidrs);
    this.sourceAllowlist = new TrustedProxyResolver(config.admin.sourceAllowlistCidrs);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const host = header(request, 'host');
    if (!host || !this.config.admin.allowedHosts.includes(host.toLowerCase())) {
      throw new NotFoundException();
    }
    if (
      this.config.appEnv !== 'local' &&
      this.config.appEnv !== 'test' &&
      this.config.admin.networkGateMode !== 'source_allowlist'
    ) {
      throw new NotFoundException();
    }
    const client = this.proxy.resolve(request.socket.remoteAddress ?? '127.0.0.1', request.headers);
    if (
      this.config.admin.networkGateMode === 'source_allowlist' &&
      !this.sourceAllowlist.isTrustedAddress(client)
    ) {
      throw new NotFoundException();
    }
    return true;
  }
}

@Injectable()
export class AdminOriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
    if (
      !isAdminOriginAllowed(this.config.appEnv, this.config.admin.origin, header(request, 'origin'))
    ) {
      return false;
    }
    const contentType = header(request, 'content-type')?.split(';', 1)[0]?.trim();
    return contentType === 'application/json';
  }
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    request.adminSession = await this.auth.resolveSession(request, request.method !== 'GET');
    return true;
  }
}

@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<string | undefined>(ADMIN_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) return true;
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (!request.adminSession) throw new NotFoundException();
    this.auth.requirePermission(request.adminSession, permission);
    return true;
  }
}

@Injectable()
export class AdminStepUpGuard implements CanActivate {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (!request.adminSession) throw new NotFoundException();
    if (this.auth.localSessionAvailable(request)) return true;
    this.auth.requireStepUp(request.adminSession);
    return true;
  }
}
