import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentTranscriptReadError } from '../agent/agent-transcript.repository.js';
import { errorDetailLine, safeValidationIssues, stableErrorCode } from './provider-telemetry.js';

describe('provider telemetry redaction', () => {
  it('keeps only stable internal error messages as error codes', () => {
    expect(stableErrorCode(new Error('IMAGE_RUNTIME_BINDING_INVALID'))).toBe(
      'IMAGE_RUNTIME_BINDING_INVALID',
    );
    expect(stableErrorCode(new Error('upstream included secret data'))).toBe('Error');
    expect(stableErrorCode('unknown failure')).toBe('UNKNOWN_ERROR');
    const error = new Error('https://storage.example/image?signature=private');
    error.name = 'request secret=private';
    error.stack = 'private prompt and credentials';
    expect(stableErrorCode(error)).toBe('Error');
  });

  it('reports schema paths and field names without values', () => {
    const result = z.strictObject({ output_count: z.int() }).safeParse({
      output_count: 1,
      output_count_source: 'user_explicit',
    });
    if (result.success) throw new Error('Expected strict schema rejection');

    expect(safeValidationIssues(result.error)).toEqual([
      { code: 'unrecognized_keys', path: '', fields: ['output_count_source'] },
    ]);
  });
  it('surfaces the controlled transcript read reason so a read failure is attributable', () => {
    const line = errorDetailLine(new AgentTranscriptReadError('source_invalid'));

    expect(line).toContain('AGENT_TRANSCRIPT_READ_FAILED');
    expect(line).toContain('reason=source_invalid');
  });

  it('never lets an uncontrolled reason value reach the log line', () => {
    const error = new Error('AGENT_TRANSCRIPT_READ_FAILED') as Error & { reason?: unknown };
    error.reason = 'https://relay.example/token?signature=private';
    const line = errorDetailLine(error);

    expect(line).not.toContain('signature');
    expect(line).not.toContain('reason=');
  });

  it('redacts user-controlled record keys in schema paths, including nested causes', () => {
    const result = z.record(z.string(), z.number()).safeParse({
      'https://storage.example/image?signature=private': 'invalid',
    });
    if (result.success) throw new Error('Expected schema rejection');
    for (const error of [
      result.error,
      new Error('AGENT_VALIDATION_FAILED', { cause: result.error }),
    ]) {
      const line = errorDetailLine(error);
      expect(line).toContain('?: invalid_type');
      expect(line).not.toContain('signature');
      expect(line).not.toContain('storage.example');
    }
  });
});
