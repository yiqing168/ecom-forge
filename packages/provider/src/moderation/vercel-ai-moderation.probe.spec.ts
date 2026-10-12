import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { probeVercelAiModerationModel } from './vercel-ai-moderation.probe.js';

function response(output: unknown): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl_${randomUUID()}`,
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'brain-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(output) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function input(fetchImpl: typeof fetch) {
  return {
    runId: randomUUID(),
    traceId: randomUUID(),
    modelSnapshotId: randomUUID(),
    providerChannelId: randomUUID(),
    providerChannelRevision: 1,
    credentialVersionId: randomUUID(),
    modelId: 'brain-model',
    modelVersion: 'cfg-1',
    apiKey: 'relay-key-123456',
    baseUrl: 'https://relay.test.invalid/v1',
    allowedRelayOrigins: ['https://relay.test.invalid'],
    timeoutMs: 10_000,
    fetchImpl,
  };
}

describe('probeVercelAiModerationModel', () => {
  it('requires fixed safe, blocked, and image decisions', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ decision: 'pass', confidence: 0.99 }))
      .mockResolvedValueOnce(
        response({
          decision: 'blocked',
          confidence: 0.98,
          reason_codes: ['illegal_goods'],
        }),
      )
      .mockResolvedValueOnce(response({ decision: 'pass', confidence: 0.97 }));

    const result = await probeVercelAiModerationModel(input(fetchImpl));

    expect(result).toMatchObject({ status: 'passed', caseCount: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain('relay-key-123456');
  });

  it('stops on an unknown outcome without retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(probeVercelAiModerationModel(input(fetchImpl))).resolves.toEqual({
      status: 'outcome_unknown',
      code: 'MODEL_MODERATION_PROBE_OUTCOME_UNKNOWN',
      diagnostic: { caseKey: 'safe-text', errorCode: 'provider_response_invalid' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
