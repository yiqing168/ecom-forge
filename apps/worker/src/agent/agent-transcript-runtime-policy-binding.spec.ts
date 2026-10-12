import type { AgentTranscriptItemContracts } from '@ecom-forge/agent';
import type { Database } from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { transcriptOutcomeDigest } from './agent-llm-cost.repository.js';
import {
  AgentTranscriptRuntimePolicyBinding,
  prepareTranscriptRuntimePolicyContext,
} from './agent-transcript-policy-context.js';

/**
 * Regression lock for the repair-round transcript read.
 *
 * A settled `invalid_tool_input` outcome carries bounded repair feedback in `detail`. The
 * policy-context item is written from that outcome, and the read path rebuilds the outcome from
 * the stored item — a rebuild that can never reconstruct `detail`. When the stored digest covered
 * `detail`, this verification could never pass: the read failed with
 * `transcript_integrity_failure` / `AGENT_TRANSCRIPT_READ_FAILED`, the repair round never
 * started, and the turn died at lease expiry.
 */
const contracts: AgentTranscriptItemContracts = {
  userMessage: { schema: z.strictObject({ text: z.string() }) },
  legacyMessage: { schema: z.strictObject({ text: z.string() }) },
  hostContexts: [
    { name: 'runtime_policy@1', content: { schema: z.record(z.string(), z.unknown()) } },
  ],
  resourceDependencySchema: z.strictObject({ binding_id: z.uuid(), version: z.string() }),
  calls: [],
};

const outcome = {
  type: 'invalid_tool_input' as const,
  error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID' as const,
  tool: 'agent_candidate_plan',
  paths: ['nodes.0.params.aspect_ratio'],
  detail: 'nodes.0.params.aspect_ratio: Invalid option: expected one of "3:4" [received <missing>]',
  usage: { input_tokens: 40, output_tokens: 12 },
};

const stepId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';

function buildItem() {
  return prepareTranscriptRuntimePolicyContext(
    {
      id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      userId: 'dddddddd-dddd-4ddd-8ddd-000000000001',
      sessionId: 'eeeeeeee-eeee-4eee-8eee-000000000001',
      turnId: 'ffffffff-ffff-4fff-8fff-000000000001',
      continuationNo: 1,
      sequenceNo: '2',
      stepId,
      outcome,
      createdAt: '2026-09-15T06:00:00.000Z',
    },
    contracts,
  );
}

function stubDatabase(digest: string, repairAttempt?: number): Pick<Database, 'query'> {
  return {
    query: {
      agentTraces: { findFirst: () => Promise.resolve({ id: 'trace-1' }) },
      agentTraceSteps: {
        findFirst: () =>
          Promise.resolve({
            stepType: 'llm_call',
            actor: 'agent',
            status: 'failed',
            errorCode: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
            outputSummary: {
              outcome: 'invalid_tool_input',
              transcript_outcome_digest: digest,
              diagnostic: {
                code: outcome.error_code,
                tool: outcome.tool,
                paths: outcome.paths,
                ...(repairAttempt === undefined ? {} : { repair_attempt: repairAttempt }),
              },
            },
            tokenUsageJson: outcome.usage,
          }),
      },
    },
  } as unknown as Pick<Database, 'query'>;
}

describe('runtime policy context source verification', () => {
  it.each([1, 2])(
    'verifies public safety repair %i and rejects altered limits',
    async (repairAttempt) => {
      const rejected = {
        type: 'public_text_rejected' as const,
        error_code: 'AGENT_PUBLIC_TEXT_REJECTED' as const,
        rule: 'secret_pattern' as const,
        usage: { input_tokens: 4, output_tokens: 2 },
      };
      const base = buildItem();
      const item = prepareTranscriptRuntimePolicyContext(
        {
          id: base.id,
          userId: base.user_id,
          sessionId: base.session_id,
          turnId: base.turn_id!,
          continuationNo: 1,
          sequenceNo: '2',
          stepId,
          outcome: rejected,
          repairAttempt,
          createdAt: base.created_at,
        },
        contracts,
      );
      const database = {
        query: {
          agentTraces: { findFirst: () => Promise.resolve({ id: 'trace-1' }) },
          agentTraceSteps: {
            findFirst: () =>
              Promise.resolve({
                stepType: 'llm_call',
                actor: 'agent',
                status: 'failed',
                errorCode: rejected.error_code,
                outputSummary: {
                  outcome: rejected.type,
                  transcript_outcome_digest: transcriptOutcomeDigest(rejected),
                  diagnostic: {
                    code: rejected.error_code,
                    rule: rejected.rule,
                    repair_attempt: repairAttempt,
                  },
                },
                tokenUsageJson: rejected.usage,
              }),
          },
        },
      } as unknown as Pick<Database, 'query'>;
      const binding = new AgentTranscriptRuntimePolicyBinding(database);
      await expect(binding.verifySource(item)).resolves.toBe(true);
      expect(item.payload_json).toMatchObject({
        content: {
          value: {
            max_repair_attempts: 1,
            remaining_repair_attempts: 2 - repairAttempt,
            retryable: repairAttempt === 1,
          },
        },
      });
      const altered = structuredClone(item);
      if (
        altered.payload_json.type !== 'host_context' ||
        altered.payload_json.content.type !== 'inline'
      )
        throw new Error('Unexpected policy fixture');
      (altered.payload_json.content.value as Record<string, unknown>).remaining_repair_attempts = 3;
      await expect(binding.verifySource(altered)).resolves.toBe(false);
    },
  );

  it.each([
    ['empty_without_tool_call', 'return_nonempty_text_or_call_one_supported_tool'],
    ['mixed_text_and_tool_calls', 'choose_text_or_tools_not_both'],
    ['free_text_without_tool_call', 'call_one_supported_tool'],
  ] as const)('persists a phase-compatible repair hint for %s', (reason, requiredAction) => {
    const item = prepareTranscriptRuntimePolicyContext(
      {
        id: 'cccccccc-cccc-4ccc-8ccc-000000000002',
        userId: 'dddddddd-dddd-4ddd-8ddd-000000000001',
        sessionId: 'eeeeeeee-eeee-4eee-8eee-000000000001',
        turnId: 'ffffffff-ffff-4fff-8fff-000000000001',
        continuationNo: 1,
        sequenceNo: '2',
        stepId,
        outcome: {
          type: 'invalid_terminal_output',
          error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
          reason,
          paths: ['text', 'tool_calls'],
          usage: { input_tokens: 20, output_tokens: 12 },
        },
        repairAttempt: 1,
        createdAt: '2026-09-15T06:00:00.000Z',
      },
      contracts,
    );
    expect(item.payload_json).toMatchObject({
      type: 'host_context',
      content: {
        value: {
          reason,
          retryable: true,
          repair_attempt: 1,
          max_repair_attempts: 3,
          remaining_repair_attempts: 3,
          required_action: requiredAction,
        },
      },
    });
  });

  it('verifies a detail-bearing invalid tool input written by the settlement path', async () => {
    const item = buildItem();
    expect(item.payload_json.type).toBe('host_context');

    const binding = new AgentTranscriptRuntimePolicyBinding(
      stubDatabase(transcriptOutcomeDigest(outcome)),
    );

    await expect(binding.verifySource(item)).resolves.toBe(true);
  });

  it('keeps the third repair attempt and rejects a mismatched trace ordinal', async () => {
    const item = prepareTranscriptRuntimePolicyContext(
      {
        id: 'cccccccc-cccc-4ccc-8ccc-000000000003',
        userId: 'dddddddd-dddd-4ddd-8ddd-000000000001',
        sessionId: 'eeeeeeee-eeee-4eee-8eee-000000000001',
        turnId: 'ffffffff-ffff-4fff-8fff-000000000001',
        continuationNo: 1,
        sequenceNo: '2',
        stepId,
        outcome,
        repairAttempt: 3,
        createdAt: '2026-09-15T06:00:00.000Z',
      },
      contracts,
    );
    expect(item.payload_json).toMatchObject({
      content: {
        value: {
          repair_attempt: 3,
          max_repair_attempts: 3,
          remaining_repair_attempts: 1,
          required_action: 'correct_tool_arguments_or_choose_allowed_action',
        },
      },
    });
    await expect(
      new AgentTranscriptRuntimePolicyBinding(
        stubDatabase(transcriptOutcomeDigest(outcome), 3),
      ).verifySource(item),
    ).resolves.toBe(true);
    await expect(
      new AgentTranscriptRuntimePolicyBinding(
        stubDatabase(transcriptOutcomeDigest(outcome), 2),
      ).verifySource(item),
    ).resolves.toBe(false);
  });

  it('would reject the digest that used to cover the optional detail', async () => {
    // Documents the defect: hashing the outcome as-is (detail included) can never be rebuilt
    // from the stored item, so verification failed and stalled the repair round.
    const binding = new AgentTranscriptRuntimePolicyBinding(stubDatabase(canonicalSha256(outcome)));

    await expect(binding.verifySource(buildItem())).resolves.toBe(false);
  });
});
