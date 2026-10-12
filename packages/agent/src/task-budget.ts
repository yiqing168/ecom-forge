export const MAX_AGENT_TASK_UNITS = 32;
const MAX_AGENT_INSPECTION_INPUTS = 34;

/** Budget work, not conversation length. A draft may increase work but never resets usage. */
export function agentTaskBudget(input: {
  attachmentCount: number;
  nodeCount?: number;
  inspectionCount?: number;
  baseRounds: number;
  baseToolCalls?: number;
  stepOutputTokens: number;
  maxOutputTokens: number;
  inspectionBatchSize?: number;
}) {
  const counts = [input.attachmentCount, input.nodeCount ?? 0];
  const inspectionCount = input.inspectionCount ?? input.attachmentCount;
  const baseToolCalls = input.baseToolCalls ?? 12;
  const batchSize = input.inspectionBatchSize ?? 4;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 4 ||
    !Number.isSafeInteger(inspectionCount) ||
    inspectionCount < 0 ||
    inspectionCount > MAX_AGENT_INSPECTION_INPUTS ||
    counts.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > MAX_AGENT_TASK_UNITS,
    ) ||
    [input.baseRounds, baseToolCalls, input.stepOutputTokens, input.maxOutputTokens].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  )
    throw new Error('AGENT_TASK_BUDGET_INVALID');
  const units = Math.max(1, ...counts, Math.min(inspectionCount, MAX_AGENT_TASK_UNITS));
  // A legal model can inspect one image per response even when its batch capacity is four.
  const extraInspections = Math.max(0, inspectionCount - 1);
  const rounds = input.baseRounds + units - 1 + extraInspections;
  const toolCalls = baseToolCalls + extraInspections;
  const outputTokens = Math.min(input.maxOutputTokens, rounds * input.stepOutputTokens);
  if (!Number.isSafeInteger(outputTokens)) throw new Error('AGENT_TASK_BUDGET_INVALID');
  return { units, rounds, toolCalls, outputTokens };
}
