import { AgentBrainCallError } from '@ecom-forge/agent';
import { describe, expect, it } from 'vitest';

import {
  AgentPreflightNotDispatchedError,
  AgentPreflightPendingError,
  agentRetryDelayMs,
  isRetryableAgentBrainNotDispatched,
  isSafeAgentProcessingRetry,
  waitForAgentRetry,
} from './agent-processing-retry.js';

describe('agent processing retry policy', () => {
  it('charges retries only for a proven unsent safety check, not a live safety wait', () => {
    expect(
      isSafeAgentProcessingRetry({
        error: new AgentPreflightNotDispatchedError(),
        phase: 'agent_loop',
      }),
    ).toBe(true);
    expect(
      isSafeAgentProcessingRetry({ error: new AgentPreflightPendingError(), phase: 'agent_loop' }),
    ).toBe(false);
    expect(
      isSafeAgentProcessingRetry({
        error: new Error('CONTENT_SAFETY_UNAVAILABLE'),
        phase: 'agent_loop',
      }),
    ).toBe(false);
  });
  it('retries transient infrastructure errors only before the Agent loop', () => {
    const transient = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });

    expect(isSafeAgentProcessingRetry({ error: transient, phase: 'image_context_resolve' })).toBe(
      true,
    );
    expect(isSafeAgentProcessingRetry({ error: transient, phase: 'agent_loop' })).toBe(false);
    expect(
      isSafeAgentProcessingRetry({
        error: new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_OPEN', 'not_dispatched'),
        phase: 'image_context_resolve',
      }),
    ).toBe(false);
  });

  it('recognizes nested transient causes and rejects permanent errors', () => {
    const transient = new Error('storage wrapper', {
      cause: Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }),
    });

    expect(isSafeAgentProcessingRetry({ error: transient, phase: 'skill_core_load' })).toBe(true);
    expect(
      isSafeAgentProcessingRetry({
        error: new Error('ownership invalid'),
        phase: 'skill_core_load',
      }),
    ).toBe(false);
  });

  it('limits Brain retries to explicit not-dispatched availability failures', () => {
    expect(isRetryableAgentBrainNotDispatched('AGENT_BRAIN_CIRCUIT_OPEN')).toBe(true);
    expect(isRetryableAgentBrainNotDispatched('AGENT_BRAIN_IMAGE_CONTEXT_UNAVAILABLE')).toBe(false);
  });

  it('caps exponential backoff and lets shutdown interrupt the wait', async () => {
    expect(agentRetryDelayMs({ attempt: 1, baseMs: 100, maxMs: 250 })).toBe(100);
    expect(agentRetryDelayMs({ attempt: 2, baseMs: 100, maxMs: 250 })).toBe(200);
    expect(agentRetryDelayMs({ attempt: 3, baseMs: 100, maxMs: 250 })).toBe(250);

    const controller = new AbortController();
    const waiting = waitForAgentRetry({ delayMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
