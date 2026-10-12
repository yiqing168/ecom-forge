import type { AgentBrainStepInput, AgentBrainStepOutcome } from '@ecom-forge/agent';
import { describe, expect, it, vi } from 'vitest';

import { AgentProcessorWorker } from '../processors/agent-processor.js';
import type { NativeTranscriptPendingExecution } from './agent-transcript-recovery.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';
import type { SkillRuntimeAdapter } from './skill-runtime.adapter.js';

function fixture(outcome: AgentBrainStepOutcome) {
  const pending: NativeTranscriptPendingExecution = {
    step: { stepId: 'settled-model-step', stepNo: 7 },
    outcome,
    completedOrdinals: [],
    budgetUsed: '0.05',
    pricingDrift: false,
  };
  const claimed = {
    turnId: 'turn',
    revision: 9,
    continuationNo: 1,
    transcriptCaptureVersion: 1,
    observations: [],
    attachments: [],
    loopState: {
      rounds: 2,
      toolCalls: 1,
      fingerprintExecutions: new Map(),
      consecutiveNoProgress: 0,
      consecutiveErrorCount: 0,
    },
    inputTokenTotal: 100,
    outputTokenTotal: 200,
    publicTextRejections: 0,
    consecutiveBrainDeliveryFailures: 0,
    pendingTranscriptExecution: pending,
    lastBrainCallOutcomeUnknown: false,
    modelSnapshot: {
      adapter: 'fake',
      capability_contract: { max_tool_calls_per_response: 4, max_output_tokens: 8192 },
    },
  } as unknown as ClaimedAgentTurn;
  const repository = {
    renew: vi
      .fn()
      .mockImplementation(({ revision }: { revision: number }) => Promise.resolve(revision + 1)),
    completeResponse: vi.fn().mockResolvedValue({ eventSeq: 1 }),
    recordPublicTextRejection: vi.fn().mockResolvedValue(true),
    requestClarification: vi.fn().mockResolvedValue({ eventSeq: 1 }),
    block: vi.fn().mockResolvedValue({ eventSeq: 1 }),
    finishImageInspection: vi.fn().mockResolvedValue(false),
  };
  const brain = { countInputTokens: vi.fn(), runStep: vi.fn() };
  const llmCosts = { reserve: vi.fn(), settle: vi.fn() };
  const refreshNativeTranscript = vi.fn().mockResolvedValue(undefined);
  const handleCandidatePlan = vi.fn().mockResolvedValue(undefined);
  const processor = Object.create(AgentProcessorWorker.prototype) as AgentProcessorWorker;
  Object.assign(processor, {
    config: {
      agentMaxOutputTokens: 8192,
      agentMaxLlmRounds: 6,
      agentBrainStepMaxOutputTokens: 8192,
      agentBrainAdapter: 'fake',
      agentProcessingLeaseMs: 10_000,
    },
    repository,
    brain,
    llmCosts,
    refreshNativeTranscript,
    missingKnowledgeForTerminal: () => [],
    turnCostBudget: () => '0.15',
    loopBudget: () => ({
      maxRounds: 6,
      maxToolCalls: 12,
      maxSameFingerprintExecutions: 2,
      maxNoProgress: 4,
      maxSameError: 2,
    }),
    publishWake: vi.fn().mockResolvedValue(undefined),
    handleCandidatePlan,
  });
  const resolveImage = vi
    .fn()
    .mockResolvedValue({ bytes: new Uint8Array([1]), media_type: 'image/png' });
  const run = (images: AgentBrainStepInput['authorized_images'] = []) =>
    processor['runLoop'](
      claimed,
      9,
      {} as SkillRuntimeAdapter,
      [],
      images,
      undefined,
      undefined,
      resolveImage,
    );
  const unchangedBrain = () => {
    expect(brain.countInputTokens).not.toHaveBeenCalled();
    expect(brain.runStep).not.toHaveBeenCalled();
    expect(llmCosts.reserve).not.toHaveBeenCalled();
    expect(llmCosts.settle).not.toHaveBeenCalled();
    expect(claimed.inputTokenTotal).toBe(100);
    expect(claimed.outputTokenTotal).toBe(200);
    expect(claimed.loopState.rounds).toBe(2);
  };
  return {
    run,
    claimed,
    pending,
    repository,
    unchangedBrain,
    handleCandidatePlan,
    resolveImage,
    processor,
    brain,
    refreshNativeTranscript,
  };
}
const usage = { input_tokens: 20, output_tokens: 30 };

describe('processor native recovery execution', () => {
  it('executes a pending inspection from the last permitted model round', async () => {
    const test = fixture({
      type: 'tool_calls',
      calls: [
        {
          call_id: 'call-0',
          name: 'inspect_image@1',
          arguments: { binding_key: 'source', detail: 'overview' },
        },
      ],
      usage,
    });
    test.claimed.loopState.rounds = 6;
    await test.run([
      { binding_key: 'source', role: 'semantic_reference', content_hash: 'a'.repeat(64) },
    ]);
    expect(test.repository.finishImageInspection).toHaveBeenCalledOnce();
    expect(test.repository.block).not.toHaveBeenCalled();
    expect(test.brain.runStep).not.toHaveBeenCalled();
  });
  it.each(['rounds', 'tokens'] as const)(
    'rechecks %s consumed by compaction before requesting another model',
    async (budget) => {
      const test = fixture({
        type: 'tool_calls',
        calls: [
          {
            call_id: 'call-0',
            name: 'inspect_image@1',
            arguments: { binding_key: 'source', detail: 'overview' },
          },
        ],
        usage,
      });
      test.repository.finishImageInspection.mockResolvedValue(true);
      test.refreshNativeTranscript
        .mockImplementationOnce(async () => {})
        .mockImplementation(() => {
          delete test.claimed.pendingTranscriptExecution;
          return Promise.resolve();
        });
      Object.assign(test.processor, {
        prepareSessionMemory: () => {
          test.claimed.inputTokenTotal += 500;
          test.claimed.outputTokenTotal = budget === 'tokens' ? 8192 : 300;
          if (budget === 'rounds') test.claimed.loopState.rounds = 6;
          return Promise.resolve({ revision: test.claimed.revision });
        },
      });
      await test.run([
        { binding_key: 'source', role: 'semantic_reference', content_hash: 'a'.repeat(64) },
      ]);
      expect(test.brain.countInputTokens).not.toHaveBeenCalled();
      expect(test.repository.block).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: budget === 'rounds' ? 'AGENT_LOOP_LIMIT_EXCEEDED' : 'AGENT_BUDGET_EXCEEDED',
        }),
      );
      expect(test.claimed.inputTokenTotal).toBe(600);
    },
  );
  it('executes the accepted response on its original step without requesting or settling a model again', async () => {
    const test = fixture({ type: 'respond', text: 'Original reply', usage });
    await test.run();
    expect(test.repository.completeResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        llmStepId: 'settled-model-step',
        revision: 10,
        text: 'Original reply',
      }),
    );
    test.unchangedBrain();
  });

  it('does not publish an unsafe legacy settled response during recovery', async () => {
    const test = fixture({ type: 'respond', text: 'api_key=1234567890abcdef', usage });
    test.claimed.publicTextRejections = 1;
    await test.run();
    expect(test.repository.completeResponse).not.toHaveBeenCalled();
    expect(test.repository.block).toHaveBeenCalledWith(
      expect.objectContaining({
        llmStepId: 'settled-model-step',
        guardrailType: 'public_text_policy',
      }),
    );
    test.unchangedBrain();
  });

  it('publishes a safe settled clarification without calling or settling the model again', async () => {
    const test = fixture({
      type: 'request_clarification',
      question: 'Which direction should I use?',
      suggestions: ['Minimal', 'Expressive'],
      usage,
    });
    await test.run();
    expect(test.repository.requestClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        llmStepId: 'settled-model-step',
        question: 'Which direction should I use?',
        suggestions: ['Minimal', 'Expressive'],
      }),
    );
    test.unchangedBrain();
  });

  it.each([
    { question: 'api_key=1234567890abcdef', suggestions: ['Minimal'] },
    { question: 'Which direction?', suggestions: ['api_key=1234567890abcdef'] },
  ])(
    'blocks unsafe settled clarification content during recovery',
    async ({ question, suggestions }) => {
      const test = fixture({ type: 'request_clarification', question, suggestions, usage });
      test.claimed.publicTextRejections = 1;
      await test.run();
      expect(test.repository.requestClarification).not.toHaveBeenCalled();
      expect(test.repository.block).toHaveBeenCalledWith(
        expect.objectContaining({
          llmStepId: 'settled-model-step',
          guardrailType: 'public_text_policy',
        }),
      );
      test.unchangedBrain();
    },
  );

  it('records a first unsafe settled clarification before blocking a repeated recovery', async () => {
    const test = fixture({
      type: 'request_clarification',
      question: 'api_key=1234567890abcdef',
      suggestions: [],
      usage,
    });
    await test.run();
    expect(test.repository.recordPublicTextRejection).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'secret_pattern', llmStepId: 'settled-model-step' }),
    );
    expect(test.repository.requestClarification).not.toHaveBeenCalled();
    expect(test.repository.block).toHaveBeenCalledWith(
      expect.objectContaining({ guardrailType: 'public_text_policy' }),
    );
    test.unchangedBrain();
  });

  it('resumes the original candidate through the existing compiler path', async () => {
    const plan = { original: true };
    const test = fixture({ type: 'candidate_plan', plan, usage });
    await test.run();
    expect(test.handleCandidatePlan).toHaveBeenCalledWith(
      test.claimed,
      10,
      'settled-model-step',
      plan,
    );
    test.unchangedBrain();
  });

  it('merges the pending final batch with accepted checkpoints without replaying the model', async () => {
    const draft = {
      nodes: [
        {
          candidate_key: 'a',
          input_bindings: ['source-a'],
          params: { creative_prompt: 'Accepted A', output_count: 1 },
        },
        { candidate_key: 'b', input_bindings: ['source-b'], params: { output_count: 1 } },
      ],
    };
    const test = fixture({
      type: 'authoring_batch',
      authoring_output: {
        name: 'agent_author_prompts@1',
        arguments: { prompts: [{ candidate_key: 'b', creative_prompt: 'Original B' }] },
        provider_call_id: 'original-b',
      },
      usage,
    });
    test.claimed.authoringPlan = draft;
    test.claimed.authoringCompletedKeys = ['a'];
    await test.run();
    expect(test.handleCandidatePlan).toHaveBeenCalledWith(test.claimed, 10, 'settled-model-step', {
      nodes: [
        draft.nodes[0],
        { ...draft.nodes[1], params: { output_count: 1, creative_prompt: 'Original B' } },
      ],
    });
    test.unchangedBrain();
  });

  it('never compiles an incomplete authoring batch or replays a stale checkpoint write', async () => {
    const test = fixture({
      type: 'authoring_batch',
      authoring_output: {
        name: 'agent_author_prompts@1',
        arguments: { prompts: [{ candidate_key: 'a', creative_prompt: 'Original A' }] },
        provider_call_id: 'original-a',
      },
      usage,
    });
    test.claimed.authoringPlan = {
      nodes: ['a', 'b'].map((candidate_key) => ({ candidate_key, params: {} })),
    };
    const saveAuthoringBatch = vi.fn().mockResolvedValue(false);
    Object.assign(test.repository, { saveAuthoringBatch });
    await test.run();
    expect(saveAuthoringBatch).toHaveBeenCalledWith(
      expect.objectContaining({ llmStepId: 'settled-model-step', revision: 10 }),
    );
    expect(test.handleCandidatePlan).not.toHaveBeenCalled();
    expect(test.claimed.authoringCompletedKeys).toBeUndefined();
    test.unchangedBrain();
  });

  it.each(['budget', 'pricing'] as const)(
    'blocks a settled output with %s overrun before executing it',
    async (reason) => {
      const test = fixture({ type: 'respond', text: 'Original reply', usage });
      if (reason === 'budget') test.pending.budgetUsed = '0.16';
      else test.pending.pricingDrift = true;
      await test.run();
      expect(test.repository.completeResponse).not.toHaveBeenCalled();
      expect(test.repository.block).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'AGENT_BUDGET_EXCEEDED',
          llmStepId: 'settled-model-step',
        }),
      );
      test.unchangedBrain();
    },
  );

  it('does not resume any call when the last Brain delivery is unknown', async () => {
    const test = fixture({ type: 'respond', text: 'Original reply', usage });
    test.claimed.lastBrainCallOutcomeUnknown = true;
    await test.run();
    expect(test.repository.completeResponse).not.toHaveBeenCalled();
    expect(test.repository.block).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'AGENT_MODEL_UNAVAILABLE' }),
    );
    test.unchangedBrain();
  });

  it('skips committed inspections and retains the pending call ordinal and original step', async () => {
    const calls = [0, 1].map((index) => ({
      call_id: `call-${index}`,
      name: 'inspect_image@1',
      arguments: { binding_key: `source-${index}`, detail: 'detail' },
    }));
    const test = fixture({ type: 'tool_calls', calls, usage });
    test.pending.completedOrdinals = [0];
    const images = calls.map((call) => ({
      binding_key: call.arguments.binding_key,
      role: 'semantic_reference' as const,
      content_hash: 'a'.repeat(64),
    }));
    await test.run(images);
    expect(test.resolveImage).toHaveBeenCalledExactlyOnceWith(images[1], 'detail');
    expect(test.repository.finishImageInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        llmStepId: 'settled-model-step',
        callOrdinal: 1,
        bindingKey: 'source-1',
      }),
    );
    test.unchangedBrain();
  });
});
