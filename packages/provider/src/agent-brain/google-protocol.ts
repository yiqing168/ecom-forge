import { createGoogle } from '@ai-sdk/google';
import { agentProviderMetadataSchema, type AgentProviderMetadata } from '@ecom-forge/agent';
import { z } from 'zod';
import type { LanguageModel } from 'ai';

import { googleRelayApiBaseUrl } from '../relay-policy.js';

export function googleToolMetadata(raw: unknown): AgentProviderMetadata | undefined {
  const metadata = z
    .object({
      google: z.object({ thoughtSignature: z.unknown().optional() }).passthrough().optional(),
    })
    .passthrough()
    .safeParse(raw);
  const signature = metadata.success ? metadata.data.google?.thoughtSignature : undefined;
  if (signature === undefined) return undefined;
  return agentProviderMetadataSchema.parse({ google: { thoughtSignature: signature } });
}

export function googleToolReplay(raw: unknown): { provider_metadata?: AgentProviderMetadata } {
  const metadata = googleToolMetadata(raw);
  return metadata ? { provider_metadata: metadata } : {};
}

const requestSchema = z
  .object({
    contents: z
      .array(
        z
          .object({
            parts: z.array(z.object({ thoughtSignature: z.string().optional() }).passthrough()),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export function googleBrainModel(input: {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  modelId: string;
}): LanguageModel {
  return createGoogle({
    apiKey: input.apiKey,
    baseURL: googleRelayApiBaseUrl(input.baseUrl),
    fetch: async (url, init) => {
      // The SDK synthesizes a bypass sentinel for unsigned historical calls. Keep absence
      // as absence instead: the provider decides validity, and real signatures stay intact.
      if (typeof init?.body === 'string') {
        const body = requestSchema.parse(JSON.parse(init.body));
        let changed = false;
        for (const content of body.contents ?? []) {
          for (const part of content.parts) {
            if (part.thoughtSignature === 'skip_thought_signature_validator') {
              delete part.thoughtSignature;
              changed = true;
            }
          }
        }
        if (changed) return input.fetchImpl(url, { ...init, body: JSON.stringify(body) });
      }
      return input.fetchImpl(url, init);
    },
  }).chat(input.modelId);
}
