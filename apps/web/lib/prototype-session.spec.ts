import { beforeEach, describe, expect, it } from 'vitest';

import {
  PROTOTYPE_SESSION_KEY,
  readPrototypeSession,
  resetPrototypeCreationState,
  writePrototypeSession,
} from './prototype-session';

describe('prototype session draft storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('never persists attachments, prompt text or mention references', () => {
    writePrototypeSession({
      attachmentRoles: { 'private-asset': 'identity_anchor' },
      attachments: [
        {
          category: 'upload',
          id: '11111111-1111-4111-8111-111111111111',
          imageUrl: 'https://storage.example/private.png?signature=secret',
          label: 'Product image',
          prompt: '',
          resourceType: 'asset',
          resourceVersion: 'content-version',
          tags: 'upload',
        },
      ],
      aspectRatio: '3:4',
      prompt: 'Keep this draft',
      referencedAttachmentIds: ['11111111-1111-4111-8111-111111111111'],
    });

    const serialized = window.sessionStorage.getItem(`${PROTOTYPE_SESSION_KEY}:guest:new`);
    expect(serialized).not.toContain('storage.example');
    expect(serialized).not.toContain('signature');
    expect(serialized).not.toContain('Product image');
    expect(serialized).not.toContain('Keep this draft');
    expect(serialized).not.toContain('private-asset');
    expect(readPrototypeSession()).toEqual({ aspectRatio: '3:4' });
  });

  it('isolates new-session preferences and each historical session', () => {
    writePrototypeSession({ selectedBrainModelId: 'new-brain' });
    writePrototypeSession({ selectedBrainModelId: 'brain-a', selectedBrainModelVersion: 2 }, 'a');
    writePrototypeSession(
      { selectedBrainModelId: 'brain-b', selectedImageModelId: 'image-b' },
      'b',
    );

    expect(readPrototypeSession()).toEqual({ selectedBrainModelId: 'new-brain' });
    expect(readPrototypeSession('a')).toEqual({
      selectedBrainModelId: 'brain-a',
      selectedBrainModelVersion: 2,
    });
    expect(readPrototypeSession('b').selectedBrainModelId).toBe('brain-b');
    expect(readPrototypeSession('uncached')).toEqual({});

    resetPrototypeCreationState();
    expect(readPrototypeSession().selectedBrainModelId).toBeNull();
    expect(readPrototypeSession().creativeDirection).toEqual({ mode: 'auto', version: 3 });
    expect(readPrototypeSession('a').selectedBrainModelId).toBe('brain-a');
    expect(readPrototypeSession('b').selectedBrainModelId).toBe('brain-b');
  });

  it('removes only a corrupted session cache', () => {
    writePrototypeSession({ selectedBrainModelId: 'new-brain' });
    writePrototypeSession({ selectedBrainModelId: 'brain-b' }, 'b');
    window.sessionStorage.setItem(`${PROTOTYPE_SESSION_KEY}:guest:session:a`, '{invalid');
    expect(readPrototypeSession('a')).toEqual({});
    expect(readPrototypeSession('b').selectedBrainModelId).toBe('brain-b');
    expect(readPrototypeSession().selectedBrainModelId).toBe('new-brain');
  });

  it('retains 4K but discards any unsupported cached resolution', () => {
    writePrototypeSession({ resolutionTier: '4k', selectedBrainModelId: 'brain-a' });
    expect(readPrototypeSession().resolutionTier).toBe('4k');
    window.sessionStorage.setItem(
      `${PROTOTYPE_SESSION_KEY}:guest:new`,
      JSON.stringify({ resolutionTier: '3k', selectedBrainModelId: 'brain-a' }),
    );
    expect(readPrototypeSession()).toEqual({ selectedBrainModelId: 'brain-a' });
  });

  it('ignores legacy stored drafts when restoring an older session', () => {
    window.localStorage.setItem(
      PROTOTYPE_SESSION_KEY,
      JSON.stringify({
        attachments: [{ id: 'legacy-asset', label: '旧附件' }],
        aspectRatio: '9:16',
        prompt: 'Legacy draft',
        referencedAttachmentIds: ['legacy-asset'],
      }),
    );

    expect(readPrototypeSession()).toEqual({});
  });

  it('isolates two users and the current anonymous tab, including resets', () => {
    writePrototypeSession({ selectedBrainModelId: 'guest' });
    writePrototypeSession({ selectedBrainModelId: 'user-a' }, null, 'a');
    writePrototypeSession({ selectedBrainModelId: 'a-session' }, 'shared-session', 'a');
    writePrototypeSession({ selectedBrainModelId: 'user-b' }, null, 'b');
    expect(readPrototypeSession(null, 'a').selectedBrainModelId).toBe('user-a');
    expect(readPrototypeSession(null, 'b').selectedBrainModelId).toBe('user-b');
    expect(readPrototypeSession('shared-session', 'b')).toEqual({});
    expect(readPrototypeSession().selectedBrainModelId).toBe('guest');
    resetPrototypeCreationState('a');
    expect(readPrototypeSession(null, 'a').selectedBrainModelId).toBeNull();
    expect(readPrototypeSession(null, 'b').selectedBrainModelId).toBe('user-b');
    expect(readPrototypeSession('shared-session', 'a').selectedBrainModelId).toBe('a-session');
    window.sessionStorage.clear();
    expect(readPrototypeSession()).toEqual({});
    expect(readPrototypeSession(null, 'b').selectedBrainModelId).toBe('user-b');
  });
});
