import { z } from 'zod';
import { canonicalJson } from '@ecom-forge/shared';
import { agentProviderMetadataSchema } from './provider-metadata.js';

export const authoredPromptsSchema = z.strictObject({
  prompts: z
    .array(
      z.strictObject({
        candidate_key: z
          .string()
          .min(1)
          .max(64)
          .describe(
            'Copy a current host-requested candidate key exactly from the fixed draft; do not invent or return other keys.',
          ),
        creative_prompt: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Nonempty self-contained final image-model instructions for this candidate only. Include its source-specific visual decisions and exact requested text, not a plan or checklist.',
          ),
      }),
    )
    .min(1)
    .max(32)
    .describe(
      'Exactly one item per current host-requested key, without duplicates. Other draft nodes are context only; do not repeat them.',
    ),
});

export const agentAuthoringOutputSchema = z.strictObject({
  name: z.literal('agent_author_prompts@1'),
  arguments: authoredPromptsSchema,
  provider_call_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .nullable(),
  provider_metadata: agentProviderMetadataSchema.optional(),
});

const draftSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            candidate_key: z.string().min(1).max(64),
            params: z.record(z.string(), z.unknown()),
          })
          .passthrough(),
      )
      .min(1)
      .max(32),
  })
  .passthrough();

export function authoringCandidateKeys(draft: Record<string, unknown>): string[] {
  const keys = draftSchema.parse(draft).nodes.map((node) => node.candidate_key);
  if (new Set(keys).size !== keys.length) throw new Error('AGENT_AUTHORING_NODE_MISMATCH');
  return keys;
}

/** A checkpoint accepts exactly the host-selected keys, preserving all operational fields. */
export function mergeAuthoredPromptBatch(
  draft: Record<string, unknown>,
  authored: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const plan = draftSchema.parse(draft);
  const nodeKeys = authoringCandidateKeys(draft);
  const { prompts } = authoredPromptsSchema.parse(authored);
  const byKey = new Map(prompts.map((item) => [item.candidate_key, item.creative_prompt]));
  if (
    expectedKeys.length === 0 ||
    new Set(expectedKeys).size !== expectedKeys.length ||
    byKey.size !== prompts.length ||
    byKey.size !== expectedKeys.length ||
    expectedKeys.some((key) => !nodeKeys.includes(key) || !byKey.has(key))
  )
    throw new Error('AGENT_AUTHORING_NODE_MISMATCH');
  return {
    ...plan,
    nodes: plan.nodes.map((node) => ({
      ...node,
      params: byKey.has(node.candidate_key)
        ? { ...node.params, creative_prompt: byKey.get(node.candidate_key)! }
        : node.params,
    })),
  };
}

/** The author cannot change any operational decision or create another node. */
export function mergeAuthoredPrompts(
  draft: Record<string, unknown>,
  authored: unknown,
): Record<string, unknown> {
  const plan = draftSchema.parse(draft);
  const { prompts } = authoredPromptsSchema.parse(authored);
  const byKey = new Map(prompts.map((item) => [item.candidate_key, item.creative_prompt]));
  const nodeKeys = new Set(plan.nodes.map((node) => node.candidate_key));
  if (
    byKey.size !== prompts.length ||
    nodeKeys.size !== plan.nodes.length ||
    byKey.size !== nodeKeys.size ||
    [...byKey.keys()].some((key) => !nodeKeys.has(key))
  ) {
    throw new Error('AGENT_AUTHORING_NODE_MISMATCH');
  }
  return {
    ...plan,
    nodes: plan.nodes.map((node) => ({
      ...node,
      params: { ...node.params, creative_prompt: byKey.get(node.candidate_key)! },
    })),
  };
}

/** Validate the retained call against the final plan without reconstructing the original call. */
export function authoredPromptsMatchPlan(
  plan: Record<string, unknown>,
  authored: unknown,
): boolean {
  try {
    return canonicalJson(mergeAuthoredPrompts(plan, authored)) === canonicalJson(plan);
  } catch {
    return false;
  }
}
