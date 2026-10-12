import { Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AdminExceptionFilter } from './admin-exception.filter.js';

afterEach(() => vi.restoreAllMocks());
describe('admin validation diagnostics', () => {
  it('logs safe validation paths and request identity without request values', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const parsed = z
      .strictObject({ protocol_family: z.enum(['openai', 'anthropic']) })
      .safeParse({ protocol_family: 'google', api_key: 'never-log-this-secret' });
    if (parsed.success) throw new Error('Expected invalid request');
    const response = { status: vi.fn(), json: vi.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({
          headers: { 'x-request-id': 'google-validation-test' },
          method: 'POST',
          route: { path: '/api/v1/admin/model-configurations/probe-models' },
        }),
      }),
    } as unknown as ArgumentsHost;
    new AdminExceptionFilter().catch(parsed.error, host);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(warn).toHaveBeenCalledOnce();
    const diagnostic = JSON.parse(warn.mock.calls[0]![0] as string) as unknown;
    const safeDiagnostic = z
      .strictObject({
        event: z.literal('admin_request_invalid'),
        request_id: z.literal('google-validation-test'),
        method: z.literal('POST'),
        route: z.literal('/api/v1/admin/model-configurations/probe-models'),
        issues: z.array(z.strictObject({ code: z.string(), path: z.array(z.string()) })),
      })
      .parse(diagnostic);
    expect(safeDiagnostic.issues).toContainEqual({
      code: 'invalid_value',
      path: ['protocol_family'],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('never-log-this-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('google"');
  });
});
