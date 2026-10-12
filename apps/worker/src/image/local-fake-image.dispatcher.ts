import { createHash } from 'node:crypto';

import { ProviderImageOutputLease } from '@ecom-forge/provider';
import { canonicalSha256 } from '@ecom-forge/shared';
import sharp from 'sharp';

import type { WorkerConfig } from '../config/worker-config.js';
import type { ImageDispatcher } from './approved-image.dispatcher.js';
import { imageTaskParamsSchema } from './image-output-ingest.service.js';

export function createLocalFakeImageDispatcher(config: WorkerConfig): ImageDispatcher {
  if (
    (config.appEnv !== 'local' && config.appEnv !== 'test') ||
    config.providerProcessorMode !== 'fake_validation'
  ) {
    throw new Error('Local fake image dispatch is restricted to fake validation environments');
  }

  return async (input) => {
    const params = imageTaskParamsSchema.parse(input.paramsSnapshot);
    if (!(await input.markPotentiallyDispatched())) {
      return {
        kind: 'not_dispatched',
        error_code: 'provider_unavailable',
        retryable: false,
        request_digest: canonicalSha256({ operation_key: params.operation_key }),
      };
    }
    const outputs = await Promise.all(
      Array.from({ length: params.output_count }, async (_, index) => {
        const bytes = await sharp({
          create: {
            width: 128,
            height: 128,
            channels: 4,
            background: index % 2 === 0 ? '#e8f3ff' : '#f7efe5',
          },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg width="128" height="128"><rect x="42" y="28" width="44" height="68" rx="8" fill="#2563eb"/><path d="M86 45h8a15 15 0 010 30h-8" fill="none" stroke="#2563eb" stroke-width="8"/></svg>`,
              ),
              top: 0,
              left: 0,
            },
          ])
          .png()
          .toBuffer();
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        return new ProviderImageOutputLease(
          {
            provider_output_id: `local-fake-${input.taskId}-${index}`,
            media_type: 'image/png',
            byte_length: bytes.byteLength,
            width: 128,
            height: 128,
            content_hash: contentHash,
          },
          bytes,
        );
      }),
    );
    const now = new Date();
    return {
      kind: 'succeeded',
      provider_request_id: `local-fake-${input.attemptId}`,
      receipt_summary: { provider_status: 'succeeded', status_code_family: '2xx' },
      accepted_at: now,
      completed_at: now,
      outputs,
    };
  };
}
