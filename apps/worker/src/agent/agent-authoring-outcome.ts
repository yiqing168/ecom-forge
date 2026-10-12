import {
  authoringCandidateKeys,
  mergeAuthoredPromptBatch,
  type AgentBrainStepOutcome,
} from '@ecom-forge/agent';
import { z } from 'zod';

/** Validate before capture/settlement so rejected batches use the existing persisted repair loop. */
export async function validateAuthoringBatchOutcome(input: {
  outcome: AgentBrainStepOutcome;
  draft: Record<string, unknown> | undefined;
  completedKeys: readonly string[];
  rejectsRepeatedPrompt: (plan: Record<string, unknown>) => boolean | Promise<boolean>;
}): Promise<AgentBrainStepOutcome> {
  if (input.outcome.type !== 'authoring_batch') return input.outcome;
  if (!input.draft) throw new Error('AGENT_AUTHORING_DRAFT_MISSING');
  const expected = authoringCandidateKeys(input.draft)
    .filter((key) => !input.completedKeys.includes(key))
    .slice(0, 1);
  if (expected.length === 0) throw new Error('AGENT_AUTHORING_DRAFT_COMPLETED');
  let plan: Record<string, unknown>;
  try {
    plan = mergeAuthoredPromptBatch(
      input.draft,
      input.outcome.authoring_output.arguments,
      expected,
    );
  } catch (error) {
    if (
      !(error instanceof z.ZodError) &&
      !(error instanceof Error && error.message === 'AGENT_AUTHORING_NODE_MISMATCH')
    )
      throw error;
    return invalid(
      input.outcome,
      'Return exactly the host-selected candidate key once; do not omit, repeat or add nodes.',
    );
  }
  const nodes = z
    .array(z.object({ candidate_key: z.string(), params: z.record(z.string(), z.unknown()) }))
    .parse(plan.nodes);
  const prompt = nodes.find((node) => node.candidate_key === expected[0])?.params.creative_prompt;
  const repeatsAcceptedPrompt = nodes.some(
    (node) =>
      input.completedKeys.includes(node.candidate_key) && node.params.creative_prompt === prompt,
  );
  if (repeatsAcceptedPrompt && (await input.rejectsRepeatedPrompt(plan))) {
    return invalid(
      input.outcome,
      'The current prompt is exactly identical to an accepted source prompt. Rewrite only the current candidate using its own visible structure; keep completed candidates and all operational fields unchanged.',
    );
  }
  return input.outcome;
}

function invalid(outcome: AgentBrainStepOutcome, detail: string): AgentBrainStepOutcome {
  return {
    type: 'invalid_tool_input',
    error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
    tool: 'agent_author_prompts',
    paths: ['prompts'],
    detail,
    usage: outcome.usage,
  };
}
