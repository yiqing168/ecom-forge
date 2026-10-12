import { z } from 'zod';
import {
  parseSkillExecutionPolicy,
  skillExecutionRules,
  type SkillExecutionPolicy,
} from '@ecom-forge/shared';

export const skillExecutionPolicySchema = z.custom<SkillExecutionPolicy>(
  (value) => parseSkillExecutionPolicy(value) !== null,
  'Invalid Skill execution policy',
);
export const skillAttachmentRolesSchema = z
  .array(
    z.strictObject({
      role: z.enum([
        'product',
        'identity_anchor',
        'semantic_reference',
        'style_reference',
        'composition_reference',
        'other',
      ]),
      label: z.string().trim().min(1).max(80),
    }),
  )
  .max(6)
  .superRefine((roles, context) => {
    if (new Set(roles.map((option) => option.role)).size !== roles.length) {
      context.addIssue({ code: 'custom', message: 'Attachment roles must be unique' });
    }
  });

export function validateSkillExecutionMetadata(
  value: {
    kind: string;
    execution_policy?: SkillExecutionPolicy | undefined;
    attachment_roles?: z.infer<typeof skillAttachmentRolesSchema> | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (!value.execution_policy) return;
  const rules = skillExecutionRules(value.execution_policy);
  if (
    value.kind !== 'primary' ||
    value.attachment_roles?.some((option) => !rules.roles.includes(option.role))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Execution metadata does not match the Skill family',
    });
  }
}
