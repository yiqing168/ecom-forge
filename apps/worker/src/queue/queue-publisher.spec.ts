import type { QueuePayload } from '@ecom-forge/queue';
import { describe, expect, it } from 'vitest';

import { queueJobOptions } from './queue-publisher.js';

const id = '11111111-1111-4111-8111-111111111111';
const agentPayload: QueuePayload = {
  schema_version: 1,
  trace_id: id,
  job_type: 'agent.continue',
  session_id: id,
  turn_id: id,
  user_message_id: id,
  continuation_no: 1,
  turn_revision: 1,
};
const workflowPayload: QueuePayload = {
  schema_version: 1,
  trace_id: id,
  job_type: 'workflow.advance',
  workflow_run_id: id,
  user_id: id,
};

describe('queueJobOptions', () => {
  it('adds bounded exponential retries only to agent continuation jobs', () => {
    expect(queueJobOptions(agentPayload).attempts).toBe(4);
    expect(
      queueJobOptions(agentPayload, {
        agentProcessingRetryAttempts: 3,
        agentProcessingRetryBaseMs: 1_000,
      }),
    ).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 1_000 } });
    expect(queueJobOptions(workflowPayload)).toEqual({ attempts: 1 });
  });

  it('rejects retry configuration outside the bounded policy', () => {
    expect(() => queueJobOptions(agentPayload, { agentProcessingRetryAttempts: 0 })).toThrow(
      'AGENT_PROCESSING_RETRY_ATTEMPTS_INVALID',
    );
    expect(() => queueJobOptions(agentPayload, { agentProcessingRetryBaseMs: 300_001 })).toThrow(
      'AGENT_PROCESSING_RETRY_DELAY_INVALID',
    );
  });
});
