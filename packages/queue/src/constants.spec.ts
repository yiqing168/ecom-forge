import { describe, expect, it } from 'vitest';

import {
  queueNameForJobType,
  queueRecoverySentinelKey,
  builtinSkillCatalogKey,
  QUEUE_RECOVERY_SCHEMA_VERSION,
  SUPPORTED_QUEUE_SCHEMA_VERSIONS,
} from './constants.js';

describe('queue constants', () => {
  it('routes each active job type to its frozen queue', () => {
    expect(queueNameForJobType('workflow.advance')).toBe('workflow');
    expect(queueNameForJobType('task.execute')).toBe('task');
    expect(queueNameForJobType('moderation.execute')).toBe('moderation');
    expect(queueNameForJobType('export.process')).toBe('asset');
    expect(queueNameForJobType('provider.callback.process')).toBe('provider-callback');
    expect(queueNameForJobType('provider.poll')).toBe('provider-callback');
    expect(queueNameForJobType('agent.quote.submit')).toBe('agent');
    expect(queueNameForJobType('agent.quote.expire')).toBe('agent');
    expect(queueNameForJobType('skill-package.validate')).toBe('evaluation');
  });

  it('keeps legacy jobs readable while recovery includes post-moderation v4', () => {
    expect(SUPPORTED_QUEUE_SCHEMA_VERSIONS).toEqual([1, 2, 3, 4]);
    expect(QUEUE_RECOVERY_SCHEMA_VERSION).toBe(4);
  });

  it('builds a versioned recovery sentinel key', () => {
    expect(queueRecoverySentinelKey('s05-test-run')).toBe(
      `s05-test-run:queue-recovery:v${QUEUE_RECOVERY_SCHEMA_VERSION}:ready`,
    );
  });

  it('rejects a Redis prefix that could escape the owned key namespace', () => {
    expect(() => queueRecoverySentinelKey('shared:prefix')).toThrow(/REDIS_PREFIX/);
  });

  it('builds the runtime builtin Skill catalog key', () => {
    expect(builtinSkillCatalogKey('s05-test-run')).toBe(
      's05-test-run:runtime:builtin-skill-catalog:v1',
    );
  });

  it('routes S14 evaluation jobs to the evaluation queue', () => {
    expect(queueNameForJobType('provider-credential.validate')).toBe('evaluation');
    expect(queueNameForJobType('storage-credential.validate')).toBe('evaluation');
    expect(queueNameForJobType('model-poc.run')).toBe('evaluation');
  });
});
