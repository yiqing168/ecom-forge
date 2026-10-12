import { createHash } from 'node:crypto';

export const ADMIN_ROLE_PERMISSIONS = {
  support: ['dashboard.read', 'users.read', 'tasks.read', 'audit.read', 'health.read'],
  operations: [
    'dashboard.read',
    'users.read',
    'tasks.read',
    'tasks.control',
    'invites.read',
    'invites.write',
    'models.read',
    'moderation.read',
    'moderation.decide',
    'skills.read',
    'audit.read',
    'health.read',
  ],
  finance: ['dashboard.read', 'credits.read', 'credits.reconcile', 'appeals.read', 'audit.read'],
  security_admin: [
    'dashboard.read',
    'users.read',
    'risk.manage',
    'sessions.revoke',
    'providers.read',
    'provider_keys.rotate',
    'storage.read',
    'storage_keys.rotate',
    'models.read',
    'models.control',
    'moderation.read',
    'moderation.decide',
    'admin_accounts.read',
    'audit.read',
    'health.read',
  ],
  super_admin: [
    'dashboard.read',
    'invites.read',
    'invites.write',
    'users.read',
    'risk.manage',
    'sessions.revoke',
    'tasks.read',
    'tasks.control',
    'providers.read',
    'provider_keys.rotate',
    'storage.read',
    'storage_keys.rotate',
    'models.read',
    'models.write',
    'models.publish',
    'models.control',
    'moderation.read',
    'moderation.decide',
    'pricing.read',
    'pricing.write',
    'pricing.publish',
    'credits.read',
    'credits.reconcile',
    'credits.correct',
    'appeals.read',
    'appeals.decide',
    'rewards.manage',
    'skills.read',
    'skills.install',
    'skills.review',
    'skills.publish',
    'admin_accounts.read',
    'admin_accounts.manage',
    'audit.read',
    'health.read',
  ],
} as const;

export type AdminRoleKey = keyof typeof ADMIN_ROLE_PERMISSIONS;

export function isAdminRoleKey(value: string): value is AdminRoleKey {
  return value in ADMIN_ROLE_PERMISSIONS;
}

export function rolePermissions(roleKey: string): readonly string[] {
  if (!(roleKey in ADMIN_ROLE_PERMISSIONS)) return [];
  return ADMIN_ROLE_PERMISSIONS[roleKey as AdminRoleKey];
}

export function permissionSnapshotHash(
  bindings: readonly { roleKey: string; scopeKey: string }[],
): string {
  const permissions = [
    ...new Set(bindings.flatMap((binding) => rolePermissions(binding.roleKey))),
  ].sort();
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, permissions }), 'utf8')
    .digest('hex');
}
