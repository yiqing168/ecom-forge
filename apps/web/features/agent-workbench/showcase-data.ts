import type { ComposerValue } from './composer-types';
import catalog from '@/public/showcase/catalog.json';

export type ShowcaseExample = {
  id: string;
  label: string;
  alt: string;
  imageUrl: string;
  width: number;
  height: number;
  skillName: string;
  skillSlug: string;
  description: string;
  prompt: string;
};

// Interleave independent outputs so each batch shows different creative methods.
export const showcaseExamples: ShowcaseExample[] = Array.from(
  { length: Math.max(0, ...catalog.map((group) => group.images.length)) },
  (_, index) =>
    catalog.flatMap((group) => {
      const image = group.images[index];
      return image
        ? [
            {
              id: image.id,
              label: image.title,
              alt: image.alt,
              imageUrl: image.src,
              width: image.width,
              height: image.height,
              skillName: group.name,
              skillSlug: group.skillSlug,
              description: group.description,
              prompt: group.prompt,
            },
          ]
        : [];
    }),
).flat();

export function showcaseComposerChanges(
  example: ShowcaseExample,
  skills: readonly { primary_skill_id: string }[],
): Partial<ComposerValue> | null {
  const skill = skills.find((item) => item.primary_skill_id.split('@')[0] === example.skillSlug);
  if (!skill) return null;
  return {
    agentMode: 'image',
    attachmentRoles: {},
    prompt: example.prompt,
    referencedAttachmentIds: [],
    selectedPresetIds: {},
    selectedSkillId: skill.primary_skill_id,
  };
}
