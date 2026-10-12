import { z } from 'zod';

// Opaque replay data only; never model reasoning, tool arguments, or public diagnostics.
export const agentProviderMetadataSchema = z.strictObject({
  google: z.strictObject({
    thoughtSignature: z
      .string()
      .min(1)
      .max(65_536)
      .refine((value) => value !== 'skip_thought_signature_validator'),
  }),
});

export type AgentProviderMetadata = z.infer<typeof agentProviderMetadataSchema>;
