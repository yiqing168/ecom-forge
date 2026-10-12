import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseQueuePayload } from './payload.js';
import type { QueuePayloadError, QueuePayloadErrorCode } from './payload.js';

function taskPayload() {
  return {
    schema_version: 1,
    job_type: 'task.execute',
    trace_id: randomUUID(),
    task_id: randomUUID(),
    workflow_run_id: randomUUID(),
    user_id: randomUUID(),
  };
}

describe('queue payload contracts', () => {
  it('parses an active task payload', () => {
    const payload = taskPayload();
    expect(parseQueuePayload(payload)).toEqual(payload);
  });

  it('parses a strict v4 post-moderation payload', () => {
    const payload = {
      schema_version: 4,
      job_type: 'moderation.execute',
      trace_id: randomUUID(),
      task_id: randomUUID(),
      workflow_run_id: randomUUID(),
      user_id: randomUUID(),
    } as const;

    expect(parseQueuePayload(payload)).toEqual(payload);
    expect(() => parseQueuePayload({ ...payload, schema_version: 1 })).toThrowError(
      expect.objectContaining({ code: 'QUEUE_PAYLOAD_INVALID' }),
    );
    expect(() => parseQueuePayload({ ...payload, task_attempt_id: randomUUID() })).toThrowError(
      expect.objectContaining({ code: 'QUEUE_PAYLOAD_INVALID' }),
    );
  });

  it.each([
    {
      schema_version: 1,
      job_type: 'provider.callback.process',
      trace_id: randomUUID(),
      provider_callback_event_id: randomUUID(),
      processing_no: 1,
    },
    {
      schema_version: 1,
      job_type: 'provider.poll',
      trace_id: randomUUID(),
      task_attempt_id: randomUUID(),
      poll_no: 1,
    },
  ])('parses an active Provider recovery payload', (payload) => {
    expect(parseQueuePayload(payload)).toEqual(payload);
  });

  it('parses the only v2 payload without upgrading v1 jobs implicitly', () => {
    const payload = {
      schema_version: 2,
      job_type: 'skill-package.validate',
      trace_id: randomUUID(),
      package_record_id: randomUUID(),
      validation_report_id: randomUUID(),
      attempt_no: 1,
      package_digest: 'a'.repeat(64),
      validator_contract_version: 'skill-package-validator@1',
      platform_eval_suite_digest: 'b'.repeat(64),
    } as const;

    expect(parseQueuePayload(payload)).toEqual(payload);
    expect(() => parseQueuePayload({ ...taskPayload(), schema_version: 2 })).toThrowError(
      expect.objectContaining({ code: 'QUEUE_PAYLOAD_INVALID' }),
    );
  });

  it.each([
    {
      schema_version: 3,
      job_type: 'provider-credential.validate',
      trace_id: randomUUID(),
      credential_validation_run_id: randomUUID(),
      provider_channel_id: randomUUID(),
      credential_version_id: randomUUID(),
      probe_contract_version: 'provider-credential@1',
      attempt_no: 1,
    },
    {
      schema_version: 3,
      job_type: 'storage-credential.validate',
      trace_id: randomUUID(),
      storage_validation_run_id: randomUUID(),
      storage_channel_id: randomUUID(),
      credential_version_id: randomUUID(),
      probe_contract_version: 'storage-private-assets@1',
      attempt_no: 1,
    },
    {
      schema_version: 3,
      job_type: 'model-poc.run',
      trace_id: randomUUID(),
      model_poc_run_id: randomUUID(),
      model_snapshot_id: randomUUID(),
      provider_channel_id: randomUUID(),
      credential_version_id: randomUUID(),
      probe_suite_version: 'model-poc@1',
      requested_spec_keys_digest: 'a'.repeat(64),
      attempt_no: 1,
    },
  ])('parses a strict S14 evaluation payload', (payload) => {
    expect(parseQueuePayload(payload)).toEqual(payload);
  });

  it('binds asset processing jobs to the persisted processing revision', () => {
    const assetId = randomUUID();
    const payload = {
      schema_version: 1,
      job_type: 'asset.process',
      trace_id: randomUUID(),
      asset_id: assetId,
      operation: 'inspect_metadata',
      operation_no: 2,
      user_id: randomUUID(),
      idempotency_key: `asset:${assetId}:inspect_metadata:2`,
    } as const;

    expect(parseQueuePayload(payload)).toEqual(payload);
    expect(() =>
      parseQueuePayload({ ...payload, idempotency_key: `asset:${assetId}:inspect_metadata:1` }),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_PAYLOAD_INVALID' }));
  });

  it.each([
    {
      schema_version: 1,
      job_type: 'agent.quote.submit',
      trace_id: randomUUID(),
      turn_id: randomUUID(),
      quote_id: randomUUID(),
      continuation_no: 1,
      plan_digest: 'a'.repeat(64),
      authorization_digest: 'b'.repeat(64),
    },
    {
      schema_version: 1,
      job_type: 'agent.quote.expire',
      trace_id: randomUUID(),
      turn_id: randomUUID(),
      quote_id: randomUUID(),
      continuation_no: 1,
      plan_digest: 'a'.repeat(64),
    },
  ])('parses a strict Agent quote payload', (payload) => {
    expect(parseQueuePayload(payload)).toEqual(payload);
    expect(() => parseQueuePayload({ ...payload, amount: '1.00' })).toThrowError(
      expect.objectContaining({ code: 'QUEUE_PAYLOAD_INVALID' }),
    );
  });

  const invalidPayloads: Array<[Record<string, unknown>, QueuePayloadErrorCode]> = [
    [{ ...taskPayload(), schema_version: 999 }, 'QUEUE_SCHEMA_VERSION_UNSUPPORTED'],
    [{ ...taskPayload(), job_type: 'notification.send' }, 'QUEUE_JOB_TYPE_UNSUPPORTED'],
    [{ ...taskPayload(), prompt: 'private prompt' }, 'QUEUE_PAYLOAD_SENSITIVE_FIELD'],
    [{ ...taskPayload(), unexpected: true }, 'QUEUE_PAYLOAD_INVALID'],
  ];

  it.each(invalidPayloads)('rejects invalid or unsupported payloads', (payload, code) => {
    expect(() => parseQueuePayload(payload)).toThrowError(
      expect.objectContaining<Partial<QueuePayloadError>>({ code }),
    );
  });

  it('rejects sensitive fields nested inside a payload', () => {
    expect(() =>
      parseQueuePayload({
        schema_version: 1,
        job_type: 'agent.continue',
        trace_id: randomUUID(),
        session_id: randomUUID(),
        turn_id: randomUUID(),
        user_message_id: randomUUID(),
        continuation_no: 1,
        turn_revision: 1,
        unexpected: { object_key: 'private/path' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_PAYLOAD_SENSITIVE_FIELD' }));
  });
});
