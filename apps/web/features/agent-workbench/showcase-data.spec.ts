import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { showcaseComposerChanges, showcaseExamples } from './showcase-data';

describe('published showcase data', () => {
  it('uses real static files and does not expose private identifiers or URLs', () => {
    expect(showcaseExamples.length).toBeGreaterThanOrEqual(12);
    expect(new Set(showcaseExamples.map((example) => example.id)).size).toBe(
      showcaseExamples.length,
    );
    for (const example of showcaseExamples) {
      expect(example.imageUrl).toMatch(/^\/showcase\/[a-z0-9-]+\.webp$/);
      expect(existsSync(resolve('public', example.imageUrl.slice(1)))).toBe(true);
      expect(example.alt).toBeTruthy();
      expect(example.width).toBeGreaterThan(0);
      expect(example.height).toBeGreaterThan(0);
    }
    const catalog = readFileSync('public/showcase/catalog.json', 'utf8');
    expect(catalog).not.toMatch(
      /https?:\/\/|storage_key|user_id|session_id|artifact_id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(new Set(showcaseExamples.slice(0, 4).map((example) => example.skillSlug)).size).toBe(4);
  });

  it("selects the current catalog version without injecting someone else's artifact", () => {
    const example = showcaseExamples[0]!;
    const result = showcaseComposerChanges(example, [
      { primary_skill_id: `${example.skillSlug}@9.0.0` },
    ]);
    expect(result).toEqual({
      agentMode: 'image',
      attachmentRoles: {},
      prompt: example.prompt,
      referencedAttachmentIds: [],
      selectedPresetIds: {},
      selectedSkillId: `${example.skillSlug}@9.0.0`,
    });
    expect(result).not.toHaveProperty('attachments');
    const draft = {
      attachments: [{ id: 'my-photo-a' }, { id: 'my-photo-b' }],
      prompt: '@photo-a adjust this scene',
      referencedAttachmentIds: ['my-photo-a'],
    };
    const nextDraft = { ...draft, ...result };
    expect(nextDraft.attachments).toBe(draft.attachments);
    expect(nextDraft.prompt).toBe(example.prompt);
    expect(nextDraft.referencedAttachmentIds).toEqual([]);
  });

  it('does not fall back to free creation when the featured Skill is unavailable', () => {
    expect(showcaseComposerChanges(showcaseExamples[0]!, [])).toBeNull();
    expect(
      showcaseComposerChanges(showcaseExamples[0]!, [{ primary_skill_id: 'unrelated@1.0.0' }]),
    ).toBeNull();
  });
});
