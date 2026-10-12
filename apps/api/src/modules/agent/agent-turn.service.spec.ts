import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  creativeTurnOperation,
  mentionScopedAttachments,
  primarySkillSlug,
} from './agent-turn.service.js';

function attachment(bindingId: string, position: number) {
  return {
    binding_id: bindingId,
    resource_type: 'asset' as const,
    resource_id: randomUUID(),
    resource_version: 'version',
    role: 'semantic_reference' as const,
    position,
  };
}

function resolvedAttachment(
  role: Parameters<typeof creativeTurnOperation>[1][number]['role'] = 'semantic_reference',
): Parameters<typeof creativeTurnOperation>[1][number] {
  return {
    binding_key: randomUUID(),
    kind: 'asset',
    object_id: randomUUID(),
    object_version: 'a'.repeat(64),
    content_hash: 'a'.repeat(64),
    owner_user_id: randomUUID(),
    readable: true,
    mutable: false,
    producer_mode: null,
    producer_session_id: null,
    mutation_owner: null,
    source_action: null,
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    role,
    position: 0,
    publication_revision: null,
  };
}

describe('mentionScopedAttachments', () => {
  it('keeps every attachment when the message has no @ reference', () => {
    const first = attachment(randomUUID(), 0);
    const second = attachment(randomUUID(), 1);
    expect(
      mentionScopedAttachments({ attachments: [first, second], mention_bindings: [] }),
    ).toEqual([first, second]);
  });

  it('only lets @-referenced attachments enter turn bindings', () => {
    const mentioned = attachment(randomUUID(), 0);
    const ignored = attachment(randomUUID(), 1);
    const alsoIgnored = attachment(randomUUID(), 2);
    const scoped = mentionScopedAttachments({
      attachments: [mentioned, ignored, alsoIgnored],
      mention_bindings: [{ mention_key: '@图一', binding_id: mentioned.binding_id }],
    });
    expect(scoped).toEqual([mentioned]);
  });

  it('keeps the original order of multiple @-referenced attachments', () => {
    const first = attachment(randomUUID(), 0);
    const second = attachment(randomUUID(), 1);
    const ignored = attachment(randomUUID(), 2);
    const scoped = mentionScopedAttachments({
      attachments: [first, second, ignored],
      mention_bindings: [
        { mention_key: '@图一', binding_id: first.binding_id },
        { mention_key: '@图二', binding_id: second.binding_id },
      ],
    });
    expect(scoped).toEqual([first, second]);
  });
});

describe('primarySkillSlug', () => {
  it('keeps the session identity stable across exact built-in versions', () => {
    expect(primarySkillSlug('creative-scene-reimagining@1.3.1')).toBe('creative-scene-reimagining');
    expect(primarySkillSlug('creative-scene-reimagining@1.4.0')).toBe('creative-scene-reimagining');
  });
});

describe('creativeTurnOperation', () => {
  it('selects the edit-capable model route for an attachment-free session continuation', () => {
    expect(
      creativeTurnOperation(
        { version: 1, family: 'optional_references', max_sources: 9 },
        [],
        true,
      ),
    ).toBe('image.edit');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        true,
      ),
    ).toBe('image.edit');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        true,
      ),
    ).toBe('image.edit');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        true,
      ),
    ).toBe('image.edit');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        true,
      ),
    ).toBe('image.edit');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        true,
      ),
    ).toBe('image.edit');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        true,
      ),
    ).toBe('image.edit');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'reference_composition', max_sources: 6 },
        [],
        true,
      ),
    ).toBe('image.edit');
  });

  it('routes a cinematic story poster by whether current visual references exist', () => {
    expect(
      creativeTurnOperation(
        { version: 1, family: 'optional_references', max_sources: 9 },
        [],
        false,
      ),
    ).toBe('image.generate');
    expect(
      creativeTurnOperation(
        { version: 1, family: 'optional_references', max_sources: 9 },
        [resolvedAttachment()],
        false,
      ),
    ).toBe('image.edit');
  });

  it('still rejects an attachment-free first scene-reimagining turn', () => {
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        false,
      ),
    ).toThrow();
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        false,
      ),
    ).toThrow();
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        false,
      ),
    ).toThrow();
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        false,
      ),
    ).toThrow();
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        false,
      ),
    ).toThrow();
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [],
        false,
      ),
    ).toThrow();
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'reference_composition', max_sources: 6 },
        [],
        false,
      ),
    ).toThrow();
  });

  it('routes watercolor photos through image editing and rejects unrelated roles', () => {
    expect(
      creativeTurnOperation(
        { version: 1, family: 'independent_sources', max_sources: 9 },
        [resolvedAttachment()],
        false,
      ),
    ).toBe('image.edit');
    expect(() =>
      creativeTurnOperation({ version: 1, family: 'independent_sources', max_sources: 9 }, [
        { ...resolvedAttachment(), role: 'style_reference' },
      ]),
    ).toThrow();
  });

  it('accepts one to six social contrast sources and rejects larger or mixed-role sets', () => {
    const sixSources = Array.from({ length: 6 }, () => resolvedAttachment());
    expect(
      creativeTurnOperation(
        { version: 1, family: 'reference_composition', max_sources: 6 },
        sixSources,
        false,
      ),
    ).toBe('image.edit');
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'reference_composition', max_sources: 6 },
        [...sixSources, resolvedAttachment()],
        false,
      ),
    ).toThrow();
    expect(() =>
      creativeTurnOperation(
        { version: 1, family: 'reference_composition', max_sources: 6 },
        [resolvedAttachment('style_reference')],
        false,
      ),
    ).toThrow();
  });
});
