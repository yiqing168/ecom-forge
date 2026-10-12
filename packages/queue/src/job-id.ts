import { createHash } from 'node:crypto';

import { canonicalJson } from '@ecom-forge/shared';

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function assertStableJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error('BullMQ job ID must contain only letters, digits, underscores, or hyphens');
  }
  return jobId;
}

export function jobIdFromAggregateId(aggregateId: string): string {
  return assertStableJobId(aggregateId.toLowerCase());
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function evaluationJobId(prefix: string, aggregateId: string): string {
  if (!UUID_PATTERN.test(aggregateId)) throw new Error('Evaluation aggregate ID must be a UUID');
  return assertStableJobId(`${prefix}_${aggregateId.toLowerCase()}`);
}

export function providerCredentialValidationJobId(validationRunId: string): string {
  return evaluationJobId('provider_credential_validate', validationRunId);
}

export function storageCredentialValidationJobId(validationRunId: string): string {
  return evaluationJobId('storage_credential_validate', validationRunId);
}

export function modelPocJobId(modelPocRunId: string): string {
  return evaluationJobId('model_poc', modelPocRunId);
}

export function compositeJobId(input: unknown): string {
  // Reuse the single canonical ordering from `@ecom-forge/shared`; a second local comparator
  // would drift across runtimes and silently break intent idempotency.
  const digest = createHash('sha256').update(canonicalJson(input), 'utf8').digest('base64url');
  return assertStableJobId(digest);
}
