import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';

/** Error messages can contain provider bodies, SQL values or user text. Log locations instead. */
export function requestFailureDiagnostic(host: ArgumentsHost, error: unknown) {
  const request = host.switchToHttp().getRequest?.<{
    headers?: Record<string, unknown>;
    method?: string;
    route?: { path?: unknown };
  }>();
  const rawId = request?.headers?.['x-request-id'];
  const route = request?.route?.path;
  const stack = error instanceof Error ? (error.stack ?? '').split(/\r?\n/u).slice(1, 25) : [];
  const locations = stack
    .flatMap((line) => {
      if (!/^\s+at /u.test(line)) return [];
      const match = /(?:[/\\])([a-zA-Z0-9_.-]+\.(?:ts|js|mjs|cjs)):(\d+):(\d+)\)?$/u.exec(line);
      return match ? [{ file: match[1]!, line: Number(match[2]), column: Number(match[3]) }] : [];
    })
    .slice(0, 8);
  const knownNames = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'HttpException',
  ]);
  return {
    request_id:
      typeof rawId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(rawId) ? rawId : randomUUID(),
    method:
      typeof request?.method === 'string' && /^[A-Z]{3,8}$/u.test(request.method)
        ? request.method
        : 'UNKNOWN',
    route:
      typeof route === 'string' && /^\/[A-Za-z0-9_/:.-]{0,240}$/u.test(route) ? route : '<unknown>',
    error_type:
      error instanceof Error
        ? knownNames.has(error.name)
          ? error.name
          : 'CustomError'
        : typeof error,
    locations,
  };
}
