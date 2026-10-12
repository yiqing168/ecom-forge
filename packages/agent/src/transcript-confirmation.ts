import { canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import {
  agentClarificationAnswerSchema,
  agentClarificationPayloadSchema,
  agentCreateProductFactsAnswerSchema,
  agentProductFactsConfirmationPayloadSchema,
  normalizeAgentProductFacts,
} from './confirmation-contract.js';
import { AGENT_TRANSCRIPT_LIMITS } from './runtime-defaults.js';
import { verifyTranscriptJsonContent } from './transcript-json.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveIntSchema = z.int().positive().max(2_147_483_647);
const common = {
  confirmation_id: z.uuid(),
  answer_schema_version: z.literal(1),
  payload_digest: digestSchema,
};
const storedClarificationAnswerSchema = agentClarificationAnswerSchema
  .safeExtend({
    selected_option_label: z.string().min(1).max(80).optional(),
  })
  .refine(
    (value) =>
      (value.selected_option_id !== undefined) === (value.selected_option_label !== undefined),
  );
const storedProductFactsAnswerSchema = agentCreateProductFactsAnswerSchema.extend({
  product_id: z.uuid(),
  fact_set_id: z.uuid(),
  fact_set_version: positiveIntSchema,
});

export const agentConfirmationContextSchema = z.discriminatedUnion('confirmation_type', [
  z.strictObject({
    ...common,
    confirmation_type: z.literal('clarification'),
    answer: storedClarificationAnswerSchema,
  }),
  z
    .strictObject({
      ...common,
      confirmation_type: z.literal('product_facts'),
      mode: z.enum(['create_product', 'link_product']),
      source_asset_id: z.uuid(),
      source_version: digestSchema,
      answer: storedProductFactsAnswerSchema,
    })
    .refine((value) => value.mode !== 'link_product' || value.answer.sku_code === undefined),
]);
export type AgentConfirmationContext = z.infer<typeof agentConfirmationContextSchema>;

export const agentConfirmedFactDependencySchema = z.strictObject({
  kind: z.literal('product_fact_set'),
  object_id: z.uuid(),
  object_version: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .pipe(z.string().refine((value) => BigInt(value) <= 2_147_483_647n)),
  content_hash: digestSchema,
  owner_user_id: z.uuid(),
  product_id: z.uuid(),
  source_asset_id: z.uuid(),
  source_version: digestSchema,
});

/** Capture already-normalized domain values; never repair persisted source data on read. */
export function prepareAgentConfirmationContext(source: {
  id: string;
  type: string;
  answerSchemaVersion: number;
  payloadDigest: string;
  publicPayloadJson: unknown;
  answerJson: unknown;
}): AgentConfirmationContext | null {
  try {
    if (
      source.answerSchemaVersion !== 1 ||
      canonicalSha256(source.publicPayloadJson) !== source.payloadDigest
    )
      return null;
    const base = {
      confirmation_id: source.id,
      answer_schema_version: source.answerSchemaVersion,
      payload_digest: source.payloadDigest,
      confirmation_type: source.type,
    };
    let content: unknown;
    if (source.type === 'clarification') {
      const question = lossless(source.publicPayloadJson, agentClarificationPayloadSchema);
      const answer = lossless(source.answerJson, storedClarificationAnswerSchema);
      if (
        answer.response_text !== undefined &&
        (!question.allow_free_text || answer.response_text.length > question.max_response_chars)
      )
        return null;
      if (answer.selected_option_id !== undefined) {
        const option = question.options.find(
          (candidate) => candidate.id === answer.selected_option_id,
        );
        if (!option || option.label !== answer.selected_option_label) return null;
      }
      content = { ...base, answer };
    } else if (source.type === 'product_facts') {
      const question = lossless(
        source.publicPayloadJson,
        agentProductFactsConfirmationPayloadSchema,
      );
      const answer = lossless(source.answerJson, storedProductFactsAnswerSchema);
      if (question.mode === 'link_product' && question.product_id !== answer.product_id)
        return null;
      content = {
        ...base,
        answer,
        mode: question.mode,
        source_asset_id: question.source_asset_id,
        source_version: question.source_version,
      };
    } else return null;
    return lossless(content, agentConfirmationContextSchema);
  } catch {
    return null;
  }
}

export function agentConfirmationDependencies(userId: string, content: AgentConfirmationContext) {
  if (content.confirmation_type === 'clarification') return [];
  return [
    agentConfirmedFactDependencySchema.parse({
      kind: 'product_fact_set',
      object_id: content.answer.fact_set_id,
      object_version: String(content.answer.fact_set_version),
      content_hash: canonicalSha256(normalizeAgentProductFacts(content.answer.facts)),
      owner_user_id: userId,
      product_id: content.answer.product_id,
      source_asset_id: content.source_asset_id,
      source_version: content.source_version,
    }),
  ];
}

function lossless<T>(value: unknown, schema: z.ZodType<T>): T {
  return verifyTranscriptJsonContent(value, schema, AGENT_TRANSCRIPT_LIMITS.envelopeBytes).value;
}
