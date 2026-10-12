import { z } from 'zod';
import { creativeDirectionSelectionSchema } from '@ecom-forge/agent';

export {
  agentClarificationPayloadSchema as clarificationPayloadSchema,
  agentClarificationAnswerSchema as clarificationAnswerSchema,
  agentProductFactsConfirmationPayloadSchema as productFactsConfirmationPayloadSchema,
  agentCreateProductFactsAnswerSchema as createProductFactsAnswerSchema,
  agentLinkProductFactsAnswerSchema as linkProductFactsAnswerSchema,
} from '@ecom-forge/agent';

export const MAX_AGENT_MESSAGE_CHARS = 2_000;
export const MAX_AGENT_ATTACHMENTS = 9;

const printableIdempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7E]+$/);
const exactSkillId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

const attachmentSchema = z.strictObject({
  binding_id: z.uuid(),
  resource_type: z.enum(['asset', 'artifact', 'upload']),
  resource_id: z.uuid(),
  resource_version: z.string().min(1).max(128),
  role: z.enum([
    'product',
    'style_reference',
    'composition_reference',
    'identity_anchor',
    'semantic_reference',
    'edit_source',
    'other',
  ]),
  position: z
    .int()
    .min(0)
    .max(MAX_AGENT_ATTACHMENTS - 1),
});

const selectedModelSchema = z.strictObject({
  catalog_entry_id: z.uuid(),
  version_no: z.int().positive(),
});

export const modelSelectionSchema = z.strictObject({
  catalog_revision: z.int().positive(),
  brain: selectedModelSchema,
  image: selectedModelSchema.optional(),
  video: selectedModelSchema.optional(),
});

export const generationPreferencesSchema = z.strictObject({
  schema_version: z.literal(2),
  output_kind: z.literal('image'),
  aspect_ratio: z.union([z.literal('auto'), z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/)]),
  resolution_tier: z.enum(['1k', '2k', '4k']),
  creative_direction: creativeDirectionSelectionSchema.optional(),
});

export const createTurnSchema = z
  .strictObject({
    session_id: z.uuid().optional(),
    message: z.string().trim().max(MAX_AGENT_MESSAGE_CHARS),
    attachments: z.array(attachmentSchema).max(MAX_AGENT_ATTACHMENTS).default([]),
    mention_bindings: z
      .array(z.strictObject({ mention_key: z.string().min(1).max(120), binding_id: z.uuid() }))
      .max(24)
      .default([]),
    skill_selection: z.strictObject({
      primary_skill_id: exactSkillId,
      preset_selections: z
        .array(z.strictObject({ slot: z.string().min(1).max(80), preset_id: exactSkillId }))
        .max(8)
        .default([]),
    }),
    model_selection: modelSelectionSchema,
    generation_preferences: generationPreferencesSchema,
  })
  .superRefine((value, context) => {
    if (!value.message && value.attachments.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'message or attachment is required',
      });
    }
    const positions = value.attachments.map((item) => item.position).sort((a, b) => a - b);
    if (positions.some((position, index) => position !== index)) {
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'positions must be contiguous',
      });
    }
    const bindings = new Set(value.attachments.map((item) => item.binding_id));
    if (bindings.size !== value.attachments.length) {
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'binding ids must be unique',
      });
    }
    for (const mention of value.mention_bindings) {
      if (!bindings.has(mention.binding_id)) {
        context.addIssue({
          code: 'custom',
          path: ['mention_bindings'],
          message: 'mention binding is missing',
        });
      }
    }
  });

export const confirmTurnSchema = z.strictObject({
  confirmation_id: z.uuid(),
  confirmation_type: z.enum(['clarification', 'product_facts', 'risk']),
  confirmation_version: z.int().positive(),
  answers: z.record(z.string(), z.unknown()),
});

export const interruptTurnSchema = z.strictObject({ reason: z.literal('user_requested') });

const normalizedSessionTitle = z
  .string()
  .transform((value) => value.normalize('NFKC').trim())
  .pipe(z.string().min(1).max(120));

const normalizedSessionQuery = z
  .string()
  .transform((value) => value.normalize('NFKC').trim())
  .pipe(z.string().max(120));

export const sessionListQuerySchema = z.strictObject({
  query: normalizedSessionQuery.optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const sessionDetailQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const renameSessionSchema = z.strictObject({
  revision: z.int().positive(),
  title: normalizedSessionTitle,
});

export const archiveSessionSchema = z.strictObject({ revision: z.int().positive() });

export function parseIdempotencyKey(value: string | undefined): string {
  return printableIdempotencyKey.parse(value);
}

export type CreateTurnInput = z.infer<typeof createTurnSchema>;
export type ModelSelectionInput = z.infer<typeof modelSelectionSchema>;
export type GenerationPreferencesInput = z.infer<typeof generationPreferencesSchema>;
export type ConfirmTurnInput = z.infer<typeof confirmTurnSchema>;
export type InterruptTurnInput = z.infer<typeof interruptTurnSchema>;
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
export type SessionDetailQuery = z.infer<typeof sessionDetailQuerySchema>;
export type RenameSessionInput = z.infer<typeof renameSessionSchema>;
export type ArchiveSessionInput = z.infer<typeof archiveSessionSchema>;
