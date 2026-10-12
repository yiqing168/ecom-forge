import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';

interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
}

function header(request: AuthRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class AuthWriteGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const origin = header(request, 'origin');
    if (!origin || !this.config.auth.trustedOrigins.includes(origin)) {
      return false;
    }

    const contentType = header(request, 'content-type')?.split(';', 1)[0]?.trim();
    if (contentType !== 'application/json') {
      return false;
    }

    const host = header(request, 'host');
    if (!host || /[\r\n,]/.test(host)) {
      return false;
    }

    const trustedHosts = this.config.auth.trustedOrigins.map((origin) => new URL(origin).host);
    const localHost = new URL(`http://localhost:${this.config.apiPort}`).host;
    const localIpHost = new URL(`http://127.0.0.1:${this.config.apiPort}`).host;
    const acceptedHosts =
      this.config.appEnv === 'local' || this.config.appEnv === 'test'
        ? [...trustedHosts, localHost, localIpHost]
        : trustedHosts;
    return acceptedHosts.includes(host);
  }
}
