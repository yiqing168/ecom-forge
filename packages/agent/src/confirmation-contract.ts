import { z } from 'zod';

const factList = z.array(z.string().trim().min(1).max(120)).max(24);
export const agentProductFactsSchema = z.strictObject({
  product_name: z.string().trim().min(1).max(120),
  primary_colors: factList,
  logos: factList,
  visible_text: factList,
  materials: factList,
  must_preserve: factList,
  unknown_fields: factList,
});

export const agentClarificationPayloadSchema = z.strictObject({
  schema_version: z.literal(1),
  question: z.string().min(1).max(500),
  options: z
    .array(z.strictObject({ id: z.string().min(1).max(80), label: z.string().min(1).max(80) }))
    .max(6),
  allow_free_text: z.boolean(),
  max_response_chars: z.int().min(1).max(2000),
  scope_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const agentClarificationAnswerSchema = z
  .strictObject({
    response_text: z.string().trim().min(1).max(2000).optional(),
    selected_option_id: z.string().min(1).max(80).optional(),
  })
  .refine((value) => value.response_text !== undefined || value.selected_option_id !== undefined);

const productFactFieldSchema = z.enum([
  'product_name',
  'primary_colors',
  'logos',
  'visible_text',
  'materials',
  'must_preserve',
  'unknown_fields',
]);
const productFactsPayloadBase = {
  schema_version: z.literal(1),
  source_asset_id: z.uuid(),
  source_version: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_facts: agentProductFactsSchema,
  required_fields: z.array(productFactFieldSchema).min(1).max(7),
};
export const agentProductFactsConfirmationPayloadSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...productFactsPayloadBase, mode: z.literal('create_product') }),
  z.strictObject({
    ...productFactsPayloadBase,
    mode: z.literal('link_product'),
    product_id: z.uuid(),
    expected_latest_fact_set_id: z.uuid().nullable(),
  }),
]);
export const agentCreateProductFactsAnswerSchema = z.strictObject({
  sku_code: z.string().max(80).optional(),
  facts: agentProductFactsSchema,
});
export const agentLinkProductFactsAnswerSchema = z.strictObject({ facts: agentProductFactsSchema });

export function normalizeProductFactList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizeAgentProductFacts(
  facts: z.infer<typeof agentProductFactsSchema>,
): z.infer<typeof agentProductFactsSchema> {
  return Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [
      key,
      Array.isArray(value) ? normalizeProductFactList(value) : value.trim(),
    ]),
  ) as z.infer<typeof agentProductFactsSchema>;
}
