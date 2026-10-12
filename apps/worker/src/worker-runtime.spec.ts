import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleWorkerLogger } from './worker-runtime.js';

describe('ConsoleWorkerLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps readiness events parseable as JSON while redacting sensitive keys', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = new ConsoleWorkerLogger();

    logger.info({
      event: 'worker_ready',
      worker_id: 'worker-1',
      prompt: 'full private prompt',
      apiKey: 'sk-live',
      nested: { authorization: 'Bearer secret', attempts: 3 },
      diagnostic: { detail: 'untrusted text', code: 'AGENT_MODEL_UNAVAILABLE' },
      resources: ['a', 'b'],
    });
    logger.error({ url: 'https://signed.example/x?token=1', queue: 'agent' });

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({
      event: 'worker_ready',
      worker_id: 'worker-1',
      level: 'info',
      prompt: '[redacted]',
      apiKey: '[redacted]',
      nested: { authorization: '[redacted]', attempts: 3 },
      diagnostic: { detail: '[redacted]', code: 'AGENT_MODEL_UNAVAILABLE' },
      resources: ['a', 'b'],
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toEqual({
      url: '[redacted]',
      queue: 'agent',
      level: 'error',
    });
  });
});
