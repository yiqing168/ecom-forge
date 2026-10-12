import { describe, expect, it, vi } from 'vitest';

import { AgentProcessorWorker } from '../processors/agent-processor.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

describe('native memory boundary', () => {
  it('refuses to send a previously published summary after its owner is frozen', async () => {
    const readItems = vi.fn();
    const processor = Object.create(AgentProcessorWorker.prototype) as AgentProcessorWorker;
    Object.assign(processor, {
      database: {
        query: {
          users: { findFirst: vi.fn().mockResolvedValue({ id: 'owner', riskStatus: 'frozen' }) },
          agentTranscriptItems: { findMany: readItems },
        },
      },
    });
    await expect(
      processor['refreshNativeTranscript']({
        userId: 'owner',
        transcriptCaptureVersion: 1,
        transcriptGeneration: '2',
        transcriptSummary: { resource_dependencies: [] },
      } as unknown as ClaimedAgentTurn),
    ).rejects.toThrow('AGENT_SESSION_SUMMARY_DEPENDENCY_UNAVAILABLE');
    expect(readItems).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 0, 2])(
    'rejects capture version %s before accessing model memory',
    async (version) => {
      const processor = Object.create(AgentProcessorWorker.prototype) as AgentProcessorWorker;
      await expect(
        processor['prepareSessionMemory'](
          { transcriptCaptureVersion: version } as ClaimedAgentTurn,
          1,
          [],
          [],
          undefined,
        ),
      ).rejects.toThrow('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
    },
  );
});
