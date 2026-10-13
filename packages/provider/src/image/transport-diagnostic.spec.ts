import { describe, expect, it } from 'vitest';

import {
  imageTransportDiagnostic,
  imageTransportDiagnosticSchema,
} from './transport-diagnostic.js';

const input = () => ({
  phase: 'response_headers' as const,
  startedAt: Date.now() - 100,
  requestStartedAt: Date.now() - 200,
  signal: new AbortController().signal,
  deadlineAt: new Date(Date.now() + 60_000),
});

describe('image transport diagnostics', () => {
  it('retains only allowlisted classifications, not secret messages or arbitrary properties', () => {
    const error = new TypeError('secret-key https://private.invalid?signature=secret', {
      cause: Object.assign(new Error('prompt content'), {
        code: 'ECONNRESET',
        address: 'private-host',
      }),
    });
    const result = imageTransportDiagnostic(error, input());
    expect(result).toMatchObject({
      phase: 'response_headers',
      error_name: 'TypeError',
      network_code: 'ECONNRESET',
      aborted: false,
      deadline_exceeded: false,
    });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|prompt/);
    expect(
      imageTransportDiagnostic({ name: 'secret-name', code: 'secret-code' }, input()),
    ).not.toHaveProperty('error_name');
    expect(imageTransportDiagnosticSchema.safeParse({ ...result, message: 'secret' }).success).toBe(
      false,
    );
  });

  it('bounds cyclic and deep causes and differentiates abort from expired deadline', () => {
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(imageTransportDiagnostic(cycle, input()).network_code).toBeUndefined();
    const deep = { cause: { cause: { cause: { cause: { code: 'ECONNRESET' } } } } };
    expect(imageTransportDiagnostic(deep, input()).network_code).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(
      imageTransportDiagnostic(undefined, { ...input(), signal: controller.signal }),
    ).toMatchObject({ aborted: true, deadline_exceeded: false });
    expect(
      imageTransportDiagnostic(undefined, { ...input(), deadlineAt: new Date(0) }),
    ).toMatchObject({ aborted: false, deadline_exceeded: true });
  });
});
