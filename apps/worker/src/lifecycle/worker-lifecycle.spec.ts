import { describe, expect, it, vi } from 'vitest';

import { ActiveWorkTracker, WorkerWriteFence } from './processing-fence.js';
import { WorkerLifecycle } from './worker-lifecycle.js';

function fixture(timeoutMs = 50) {
  const writes: string[] = [];
  const heartbeat = {
    write: vi.fn(({ status }: { status: string }) => {
      writes.push(status);
      return Promise.resolve();
    }),
  };
  const resources = {
    pauseNewWork: vi.fn(() => Promise.resolve()),
    close: vi.fn((_force: boolean) => Promise.resolve()),
  };
  const active = new ActiveWorkTracker();
  const fence = new WorkerWriteFence();
  const logger = { info: vi.fn(), error: vi.fn() };
  const lifecycle = new WorkerLifecycle(
    '00000000-0000-4000-8000-000000000001',
    heartbeat as never,
    resources,
    active,
    fence,
    timeoutMs,
    { version: 'test' },
    logger,
  );
  return { lifecycle, resources, active, fence, writes, logger };
}

describe('WorkerLifecycle', () => {
  it('drains active work before writing stopped', async () => {
    const state = fixture(200);
    let release!: () => void;
    const work = state.active.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const shutdown = state.lifecycle.shutdown();
    await vi.waitFor(() => expect(state.writes).toEqual(['draining']));
    expect(state.resources.close).not.toHaveBeenCalled();
    release();

    await expect(shutdown).resolves.toEqual({ timedOut: false });
    await work;
    expect(state.resources.close).toHaveBeenCalledWith(false);
    expect(state.writes).toEqual(['draining', 'stopped']);
  });

  it('closes the write fence before forcing a timed-out worker closed', async () => {
    const state = fixture(10);
    const work = state.active.run(() => new Promise<void>(() => undefined));
    void work;

    await expect(state.lifecycle.shutdown()).resolves.toEqual({ timedOut: true });
    expect(state.resources.close).toHaveBeenCalledWith(true);
    expect(() => state.fence.assertWritesAllowed()).toThrow(/closed/);
    expect(state.fence.signal.aborted).toBe(true);
    expect(state.writes).toEqual(['draining']);
    expect(state.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_drain_timeout' }),
    );
  });

  it('runs shutdown only once for repeated signals', async () => {
    const state = fixture();

    await Promise.all([state.lifecycle.shutdown(), state.lifecycle.shutdown()]);

    expect(state.resources.pauseNewWork).toHaveBeenCalledTimes(1);
    expect(state.resources.close).toHaveBeenCalledTimes(1);
  });
});
