import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commands = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('node:child_process', () => commands);

class ExitRequested extends Error {}

describe('stable Worker startup', () => {
  const argv = [...process.argv];
  let initialInterrupts;
  let initialTerminates;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = [...argv];
    initialInterrupts = new Set(process.listeners('SIGINT'));
    initialTerminates = new Set(process.listeners('SIGTERM'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new ExitRequested();
    });
    commands.execFileSync.mockReset();
    commands.spawn.mockReturnValue(
      Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    for (const listener of process.listeners('SIGINT')) {
      if (!initialInterrupts.has(listener)) process.removeListener('SIGINT', listener);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!initialTerminates.has(listener)) process.removeListener('SIGTERM', listener);
    }
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('builds cold workspace dependencies before validating and starting the compiled Worker', async () => {
    await import('./dev.mjs');
    expect(commands.execFileSync.mock.calls.map((call) => call[1])).toEqual([
      ['--filter', '@ecom-forge/worker...', 'build'],
      ['--filter', '@ecom-forge/skills', 'validate:skill-content'],
    ]);
    expect(commands.spawn).toHaveBeenCalledOnce();
    expect(commands.spawn.mock.calls[0]?.[1]).toEqual([
      '--env-file-if-exists=../../.env.local',
      'dist/main.js',
    ]);
  });

  it.each([0, 1])('does not start a consumer when preflight step %i fails', async (step) => {
    for (let index = 0; index < step; index++)
      commands.execFileSync.mockImplementationOnce(() => undefined);
    commands.execFileSync.mockImplementationOnce(() => {
      throw new Error('PREFLIGHT_FAILED');
    });
    await expect(import('./dev.mjs')).rejects.toBeInstanceOf(ExitRequested);
    expect(commands.execFileSync).toHaveBeenCalledTimes(step + 1);
    expect(commands.spawn).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('keeps source watch startup separate from the stable preflight', async () => {
    process.argv.push('--watch');
    await import('./dev.mjs');
    expect(commands.execFileSync).not.toHaveBeenCalled();
    expect(commands.spawn.mock.calls[0]?.[1]).toContain('--watch');
    expect(commands.spawn.mock.calls[0]?.[1]).toContain('src/main.ts');
  });
});
