export interface WorkflowArtifactOrderInput {
  id: string;
  taskId: string;
  taskCreatedAt: Date;
  metaJson: unknown;
  createdAt: Date;
}

export function compareWorkflowArtifactOrder(
  left: WorkflowArtifactOrderInput,
  right: WorkflowArtifactOrderInput,
): number {
  const taskTime = left.taskCreatedAt.getTime() - right.taskCreatedAt.getTime();
  if (taskTime !== 0) return taskTime;
  const taskId = left.taskId.localeCompare(right.taskId);
  if (taskId !== 0) return taskId;
  const leftOutputIndex = imageOutputIndex(left.metaJson);
  const rightOutputIndex = imageOutputIndex(right.metaJson);
  if (
    leftOutputIndex !== null &&
    rightOutputIndex !== null &&
    leftOutputIndex !== rightOutputIndex
  ) {
    return leftOutputIndex - rightOutputIndex;
  }
  if (leftOutputIndex !== null && rightOutputIndex === null) return -1;
  if (leftOutputIndex === null && rightOutputIndex !== null) return 1;
  const artifactTime = left.createdAt.getTime() - right.createdAt.getTime();
  return artifactTime !== 0 ? artifactTime : left.id.localeCompare(right.id);
}

function imageOutputIndex(metaJson: unknown): number | null {
  if (!metaJson || typeof metaJson !== 'object') return null;
  const value = (metaJson as Record<string, unknown>).output_index;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < 16 ? Number(value) : null;
}
