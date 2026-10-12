import { describe, expect, it } from 'vitest';

import {
  WORKER_RUNTIME_DEFAULTS,
  assertSupportedAgentExecutionFormat,
} from './runtime-defaults.js';

describe('worker execution-format readiness metadata', () => {
  it('advertises version enums only, with no payload content', () => {
    expect(WORKER_RUNTIME_DEFAULTS.supportedAgentExecutionFormats).toEqual(['transcript_v1']);
    expect(WORKER_RUNTIME_DEFAULTS.supportedTranscriptSchemaVersions).toEqual([1]);
    for (const format of WORKER_RUNTIME_DEFAULTS.supportedAgentExecutionFormats) {
      expect(typeof format).toBe('string');
    }
    for (const version of WORKER_RUNTIME_DEFAULTS.supportedTranscriptSchemaVersions) {
      expect(typeof version).toBe('number');
    }
  });

  it('accepts the formats this worker can actually execute', () => {
    expect(assertSupportedAgentExecutionFormat('transcript_v1')).toBe('transcript_v1');
  });

  it('fails closed on an unknown frozen execution format instead of guessing legacy', () => {
    for (const unknown of ['legacy_v1', 'future_v2', 'transcript_v2', '', 'TRANSCRIPT_V1']) {
      expect(() => assertSupportedAgentExecutionFormat(unknown)).toThrow('TURN_STATE_INVALID');
    }
  });
});
