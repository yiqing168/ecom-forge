import type { AttachmentRole, SkillCatalogItem } from '@/lib/agent-api';

export type AttachmentRoleOption = {
  label: string;
  role: AttachmentRole;
};

export function getSkillAttachmentRoleOptions(
  skill: SkillCatalogItem | undefined,
): AttachmentRoleOption[] | null {
  return skill?.attachment_roles?.length ? skill.attachment_roles : null;
}

export function resolveAttachmentRole(
  skill: SkillCatalogItem | undefined,
  selectedRole: AttachmentRole | undefined,
): AttachmentRole | null {
  const options = getSkillAttachmentRoleOptions(skill);
  if (!options) return null;
  if (options.length === 1) return options[0]?.role ?? null;
  if (selectedRole && options.some((option) => option.role === selectedRole)) {
    return selectedRole;
  }
  return null;
}
