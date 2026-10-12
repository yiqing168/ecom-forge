export const QUEUE_NAMES = [
  'workflow',
  'task',
  'moderation',
  'provider-callback',
  'agent',
  'asset',
  'evaluation',
  'notification',
  'settlement',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const ACTIVE_JOB_TYPES = [
  'workflow.advance',
  'task.execute',
  'moderation.execute',
  'agent.continue',
  'agent.quote.submit',
  'agent.quote.expire',
  'evaluation.run',
  'asset.process',
  'export.process',
  'provider.callback.process',
  'provider.poll',
  'settlement.execute',
  'skill-package.validate',
  'provider-credential.validate',
  'storage-credential.validate',
  'model-poc.run',
] as const;

export type ActiveJobType = (typeof ACTIVE_JOB_TYPES)[number];

export const SUPPORTED_QUEUE_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;
export type QueueSchemaVersion = (typeof SUPPORTED_QUEUE_SCHEMA_VERSIONS)[number];

export const QUEUE_SCHEMA_VERSION = 4 as const;
export const QUEUE_RECOVERY_SCHEMA_VERSION = 4 as const;

const JOB_TYPE_QUEUE_NAMES: Record<ActiveJobType, QueueName> = {
  'workflow.advance': 'workflow',
  'task.execute': 'task',
  'moderation.execute': 'moderation',
  'agent.continue': 'agent',
  'agent.quote.submit': 'agent',
  'agent.quote.expire': 'agent',
  'evaluation.run': 'evaluation',
  'asset.process': 'asset',
  'export.process': 'asset',
  'provider.callback.process': 'provider-callback',
  'provider.poll': 'provider-callback',
  'settlement.execute': 'settlement',
  'skill-package.validate': 'evaluation',
  'provider-credential.validate': 'evaluation',
  'storage-credential.validate': 'evaluation',
  'model-poc.run': 'evaluation',
};

export function queueNameForJobType(jobType: ActiveJobType): QueueName {
  return JOB_TYPE_QUEUE_NAMES[jobType];
}

export function queueRecoverySentinelKey(redisPrefix: string): string {
  const normalized = redisPrefix.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error('REDIS_PREFIX must contain only letters, digits, underscores, or hyphens');
  }
  return `${normalized}:queue-recovery:v${QUEUE_RECOVERY_SCHEMA_VERSION}:ready`;
}

export function builtinSkillCatalogKey(redisPrefix: string): string {
  const normalized = redisPrefix.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error('REDIS_PREFIX must contain only letters, digits, underscores, or hyphens');
  }
  return `${normalized}:runtime:builtin-skill-catalog:v1`;
}
