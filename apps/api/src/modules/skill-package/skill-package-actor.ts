import type { AppEnvironment } from '../../config/app-config.js';

export interface SkillPackageActor {
  actorType: 'bootstrap_cli' | 'admin_session';
  actorAdminId?: string;
  adminSessionId?: string;
  permissionSnapshot?: Record<string, unknown>;
}

export function isAuthorizedSkillPackageActor(
  actor: SkillPackageActor,
  appEnv: AppEnvironment,
): boolean {
  if (actor.actorType === 'bootstrap_cli') {
    return (
      ['local', 'test'].includes(appEnv) &&
      !actor.actorAdminId &&
      !actor.adminSessionId &&
      !actor.permissionSnapshot
    );
  }
  return Boolean(actor.actorAdminId && actor.adminSessionId && actor.permissionSnapshot);
}

export function skillPackageActorRef(actor: SkillPackageActor): string {
  return actor.actorAdminId ?? 'bootstrap_cli';
}

export function skillPackageAuditActor(actor: SkillPackageActor) {
  return {
    actorType: actor.actorType,
    actorAdminId: actor.actorAdminId,
    adminSessionId: actor.adminSessionId,
    permissionSnapshot: actor.permissionSnapshot,
  };
}
