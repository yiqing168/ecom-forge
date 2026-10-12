import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';

interface RequestShape {
  headers: Record<string, string | string[] | undefined>;
}

function header(request: RequestShape, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class AssetWriteGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.storage.driver !== 'local') return false;
    const request = context.switchToHttp().getRequest<RequestShape>();
    const origin = header(request, 'origin');
    if (!origin || !this.config.auth.trustedOrigins.includes(origin)) return false;
    const contentType = header(request, 'content-type')?.split(';', 1)[0]?.trim();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType ?? '')) return false;
    const contentLength = Number(header(request, 'content-length'));
    if (
      !Number.isInteger(contentLength) ||
      contentLength <= 0 ||
      contentLength > this.config.storage.maxImageBytes
    ) {
      return false;
    }
    const host = header(request, 'host');
    if (!host || /[\r\n,]/.test(host)) return false;
    const trustedHosts = this.config.auth.trustedOrigins.map((value) => new URL(value).host);
    return [
      ...trustedHosts,
      `localhost:${this.config.apiPort}`,
      `127.0.0.1:${this.config.apiPort}`,
    ].includes(host);
  }
}
