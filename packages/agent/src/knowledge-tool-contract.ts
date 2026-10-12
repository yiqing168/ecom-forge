import { z } from 'zod';

const exactSkillIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

const referencePathSchema = z.string().regex(/^references\/[a-z0-9][a-z0-9-]*\.md$/);

export interface LoadSkillViewPathsValue {
  view: 'planning' | 'references';
  reference_paths?: string[] | undefined;
}

/** Minimal structural type for the zod refinement context, so this contract owns no zod internals. */
interface RefinementContext {
  addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void;
}

/**
 * The `view` ↔ `reference_paths` rule for `load_skill@1`.
 *
 * Exported because the Brain builds a per-request variant of this schema that enumerates the skills
 * authorized *right now* (the static schema cannot express that), and that variant must apply
 * exactly the same rule. The rule used to be copy-pasted into both places, so relaxing it in one
 * left the model-facing schema and this contract disagreeing — the drift class this package is
 * supposed to be the single source for.
 */
export function refineLoadSkillViewPaths(
  value: LoadSkillViewPathsValue,
  context: RefinementContext,
): void {
  const paths = value.reference_paths ?? [];
  if (value.view === 'planning') {
    if (paths.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['reference_paths'],
        message: 'planning view accepts no reference_paths',
      });
    }
    return;
  }
  if (paths.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['reference_paths'],
      message: 'references view requires at least one path',
    });
    return;
  }
  if (new Set(paths).size !== paths.length) {
    context.addIssue({
      code: 'custom',
      path: ['reference_paths'],
      message: 'reference_paths must be unique',
    });
  }
}

/**
 * Tool-facing schema for `load_skill@1`.
 *
 * Must stay a single object shape at the JSON-Schema level. A `discriminatedUnion` converts to a
 * top-level `anyOf` without `type: "object"`, which OpenAI-compatible relays reject outright
 * (`Invalid schema for function 'load_skill': schema must be a JSON Schema of 'type: "object"',
 * got 'type: null'`). The per-view rules therefore live in `superRefine` so the wire schema is
 * always `type: object`.
 */
export const loadSkillArgumentsSchema = z
  .strictObject({
    skill_id: exactSkillIdSchema.describe(
      'Exact versioned ID from the allowed optional catalog or reference owner list; never invent an ID or reload a preloaded planning view.',
    ),
    view: z
      .enum(['planning', 'references'])
      .describe(
        'planning loads an optional Skill overview; references loads listed reference resources for an already loaded Skill.',
      ),
    reference_paths: z
      .array(referencePathSchema)
      .max(4)
      .optional()
      .describe(
        'For references supply one to four unique paths listed by that Skill. For planning omit this field or use []; never guess paths.',
      ),
  })
  .superRefine(refineLoadSkillViewPaths);

export const inspectImageArgumentsSchema = z.strictObject({
  binding_key: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Copy one exact authorized binding_key from runtime_context; it is not a filename, URL or role label.',
    ),
  detail: z
    .enum(['overview', 'detail'])
    .describe(
      'overview gives coarse composition; detail is required for source transformations, small subjects, identity or text evidence.',
    ),
});
