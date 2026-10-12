import { canonicalSha256 } from '@ecom-forge/shared';
import type { z } from 'zod';

export type ToolSideEffect = 'none' | 'read' | 'idempotent_write';

export interface ToolContract<TInput = unknown, TOutput = unknown> {
  name: string;
  contractVersion: number;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  sideEffect: ToolSideEffect;
  activityType: string;
  maxObservationBytes: number;
  deriveOperationKey?: (input: TInput) => string;
}

export function toolFingerprint(input: {
  toolName: string;
  contractVersion: number;
  normalizedArgs: unknown;
  bindingVersions?: unknown;
}): string {
  return canonicalSha256(input);
}

export function callPositionKey(input: {
  turnId: string;
  continuationNo: number;
  llmStepNo: number;
  callIndex: number;
}): string {
  return canonicalSha256(input);
}

export function assertToolContract(contract: ToolContract): void {
  if (!/^[a-z][a-z0-9_.-]*$/.test(contract.name)) throw new Error('TOOL_NAME_INVALID');
  if (!Number.isInteger(contract.contractVersion) || contract.contractVersion < 1) {
    throw new Error('TOOL_VERSION_INVALID');
  }
  if (contract.sideEffect === 'idempotent_write' && !contract.deriveOperationKey) {
    throw new Error('TOOL_OPERATION_KEY_REQUIRED');
  }
}
