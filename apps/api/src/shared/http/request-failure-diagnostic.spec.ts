import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExceptionFilter } from '../../modules/agent/agent-exception.filter.js';
import { AdminExceptionFilter } from '../../modules/admin-auth/admin-exception.filter.js';
import { ResourceExceptionFilter } from '../../modules/resource/resource-exception.filter.js';
import { AuthExceptionFilter } from '../../modules/auth/auth-exception.filter.js';
import { requestFailureDiagnostic } from './request-failure-diagnostic.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const response = { status: vi.fn(), json: vi.fn() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        headers: { 'x-request-id': 'request-29', authorization: 'never-log-auth' },
        method: 'POST',
        route: { path: '/api/v1/agent/turns/:id' },
        url: '/api/v1/agent/turns/private?signature=never-log-url',
        body: { prompt: 'never-log-prompt' },
      }),
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('safe exception diagnostics', () => {
  it.each([
    AgentExceptionFilter,
    AdminExceptionFilter,
    ResourceExceptionFilter,
    AuthExceptionFilter,
  ])('logs request identity and call sites for %s without error payloads', (Filter) => {
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const error = new Error('never-log-error https://private.invalid/?signature=secret');
    error.stack = `${error.message}\n    at write (D:\\private\\src\\agent-turn.service.ts:31:12)\n    at next (D:\\private\\node_modules\\adapter.js:20:3)`;
    const { host, response } = fixture();
    new Filter().catch(error, host);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toMatchObject({
      request_id: 'request-29',
      method: 'POST',
      route: '/api/v1/agent/turns/:id',
      locations: [
        { file: 'agent-turn.service.ts', line: 31, column: 12 },
        { file: 'adapter.js', line: 20, column: 3 },
      ],
    });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/never-log|signature|private|secret/u);
    expect(response.status).toHaveBeenCalled();
  });
  it.each([
    AgentExceptionFilter,
    AdminExceptionFilter,
    ResourceExceptionFilter,
    AuthExceptionFilter,
  ])('logs HttpException 5xx but leaves 4xx quiet for %s', (Filter) => {
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = fixture();
    new Filter().catch(new HttpException('never-log-http', 400), host);
    expect(spy).not.toHaveBeenCalled();
    new Filter().catch(new HttpException('never-log-http', 503), host);
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('never-log-http');
  });
  it('rejects unsafe request metadata and never assumes uppercase messages are safe codes', () => {
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-request-id': 'invalid\nvalue' },
          method: 'never-log-method',
          route: { path: '/?signature=never-log-route' },
        }),
      }),
    } as unknown as ArgumentsHost;
    const diagnostic = requestFailureDiagnostic(host, new Error('PRIVATE_UPPERCASE_TOKEN'));
    expect(diagnostic).toMatchObject({
      method: 'UNKNOWN',
      route: '<unknown>',
    });
    expect(diagnostic.request_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify(diagnostic)).not.toContain('never-log');
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_UPPERCASE_TOKEN');
  });
});
