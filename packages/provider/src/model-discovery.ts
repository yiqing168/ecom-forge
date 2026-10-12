import { z } from 'zod';

import { assertRelayApiBaseUrlAllowed, relayApiResourceUrl } from './relay-policy.js';

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint > 31 && codePoint !== 127;
      }),
    'Model ID contains control characters',
  );
const modelEntrySchema = z.union([
  modelId.transform((id) => ({ id, displayName: null })),
  z
    .object({
      id: modelId,
      display_name: z.string().trim().min(1).max(256).nullish(),
      name: z.string().trim().min(1).max(256).nullish(),
    })
    .passthrough()
    .transform((model) => ({
      id: model.id,
      displayName: model.display_name ?? model.name ?? null,
    })),
]);
const responseSchema = z
  .object({
    data: z.array(z.unknown()).max(10_000),
  })
  .passthrough();

export interface DiscoveredRelayModel {
  id: string;
  label: string;
}

export type RelayModelDiscoveryResult =
  | { status: 'passed'; baseUrl: string; models: DiscoveredRelayModel[] }
  | { status: 'failed'; code: 'PROVIDER_CREDENTIAL_REJECTED' }
  | {
      status: 'outcome_unknown';
      code:
        | 'PROVIDER_MODEL_LIST_EMPTY'
        | 'PROVIDER_MODEL_LIST_INVALID'
        | 'PROVIDER_MODEL_LIST_UNAVAILABLE';
      diagnostic?:
        | 'relay_url_rejected'
        | 'response_not_ok'
        | 'response_too_large'
        | 'invalid_json'
        | 'envelope_invalid'
        | 'entries_invalid'
        | 'request_failed';
    };

export async function discoverRelayModels(input: {
  apiKey: string;
  baseUrl: string;
  allowedRelayOrigins: readonly string[];
  protocolFamily: 'openai' | 'anthropic' | 'google';
  abortSignal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RelayModelDiscoveryResult> {
  if (input.apiKey.trim().length < 8 || input.abortSignal.aborted) {
    return { status: 'failed', code: 'PROVIDER_CREDENTIAL_REJECTED' };
  }
  let baseUrl: string;
  try {
    baseUrl = assertRelayApiBaseUrlAllowed(input.baseUrl, input.allowedRelayOrigins);
  } catch {
    return {
      status: 'outcome_unknown',
      code: 'PROVIDER_MODEL_LIST_UNAVAILABLE',
      diagnostic: 'relay_url_rejected',
    };
  }
  try {
    const response = await (input.fetchImpl ?? fetch)(relayApiResourceUrl(baseUrl, 'models'), {
      method: 'GET',
      headers:
        input.protocolFamily === 'anthropic'
          ? {
              'anthropic-version': '2023-06-01',
              'x-api-key': input.apiKey,
            }
          : { authorization: `Bearer ${input.apiKey}` },
      redirect: 'error',
      signal: input.abortSignal,
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'failed', code: 'PROVIDER_CREDENTIAL_REJECTED' };
    }
    if (!response.ok) {
      return {
        status: 'outcome_unknown',
        code: 'PROVIDER_MODEL_LIST_UNAVAILABLE',
        diagnostic: 'response_not_ok',
      };
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
      return {
        status: 'outcome_unknown',
        code: 'PROVIDER_MODEL_LIST_INVALID',
        diagnostic: 'response_too_large',
      };
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) {
      return {
        status: 'outcome_unknown',
        code: 'PROVIDER_MODEL_LIST_INVALID',
        diagnostic: 'response_too_large',
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return {
        status: 'outcome_unknown',
        code: 'PROVIDER_MODEL_LIST_INVALID',
        diagnostic: 'invalid_json',
      };
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      return {
        status: 'outcome_unknown',
        code: 'PROVIDER_MODEL_LIST_INVALID',
        diagnostic: 'envelope_invalid',
      };
    }
    const unique = new Map<string, DiscoveredRelayModel>();
    for (const entry of parsed.data.data) {
      const model = modelEntrySchema.safeParse(entry);
      if (!model.success) continue;
      unique.set(model.data.id, {
        id: model.data.id,
        label: model.data.displayName ?? model.data.id,
      });
    }
    const models = [...unique.values()]
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
      .slice(0, 500);
    if (models.length > 0) return { status: 'passed', baseUrl, models };
    return parsed.data.data.length === 0
      ? { status: 'outcome_unknown', code: 'PROVIDER_MODEL_LIST_EMPTY' }
      : {
          status: 'outcome_unknown',
          code: 'PROVIDER_MODEL_LIST_INVALID',
          diagnostic: 'entries_invalid',
        };
  } catch {
    return {
      status: 'outcome_unknown',
      code: 'PROVIDER_MODEL_LIST_UNAVAILABLE',
      diagnostic: 'request_failed',
    };
  }
}
