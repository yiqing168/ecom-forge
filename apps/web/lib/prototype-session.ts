import type { ComposerValue } from '@/features/agent-workbench/composer-types';
import { CREATIVE_DIRECTION_AUTO_VERSION } from '@ecom-forge/shared/creative-direction';

export const PROTOTYPE_SESSION_KEY = 'ecom-forge-ui-prototype';
export const AUTH_REDIRECT_KEY = 'ecom-forge-auth-required';
export const ATTACHMENT_PREVIEW_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

export type PrototypeSession = Omit<
  Partial<ComposerValue>,
  'attachmentRoles' | 'attachments' | 'prompt' | 'referencedAttachmentIds'
>;

function creationStorageKey(sessionId: string | null, userId: string | null): string {
  const owner = userId ? `user:${userId}` : 'guest';
  return `${PROTOTYPE_SESSION_KEY}:${owner}:${sessionId ? `session:${sessionId}` : 'new'}`;
}

export function readPrototypeSession(
  sessionId: string | null = null,
  userId: string | null = null,
): PrototypeSession {
  const key = creationStorageKey(sessionId, userId);
  const storage = userId ? window.localStorage : window.sessionStorage;
  const stored = storage.getItem(key);
  if (!stored) return {};

  try {
    const parsed = JSON.parse(stored) as PrototypeSession & {
      attachmentRoles?: unknown;
      attachments?: unknown;
      prompt?: unknown;
      referencedAttachmentIds?: unknown;
    };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('INVALID_DRAFT');
    const session = { ...parsed };
    delete session.attachmentRoles;
    delete session.attachments;
    delete session.prompt;
    delete session.referencedAttachmentIds;
    if (
      session.resolutionTier !== undefined &&
      !['1k', '2k', '4k'].includes(session.resolutionTier)
    ) {
      delete session.resolutionTier;
    }
    return session;
  } catch {
    storage.removeItem(key);
    return {};
  }
}

export function markAuthRedirect(targetPath = window.location.pathname) {
  window.sessionStorage.setItem(AUTH_REDIRECT_KEY, targetPath);
}

export function readAuthRedirect() {
  const targetPath = window.sessionStorage.getItem(AUTH_REDIRECT_KEY);
  return targetPath?.startsWith('/') && !targetPath.startsWith('//') ? targetPath : null;
}

export function consumeAuthRedirect() {
  const targetPath = readAuthRedirect();
  window.sessionStorage.removeItem(AUTH_REDIRECT_KEY);
  return targetPath;
}

export function writePrototypeSession(
  session: Partial<ComposerValue>,
  sessionId: string | null = null,
  userId: string | null = null,
) {
  const persistedSession = { ...session };
  delete persistedSession.attachmentRoles;
  delete persistedSession.attachments;
  delete persistedSession.prompt;
  delete persistedSession.referencedAttachmentIds;
  const storage = userId ? window.localStorage : window.sessionStorage;
  storage.setItem(creationStorageKey(sessionId, userId), JSON.stringify(persistedSession));
}

export function resetPrototypeCreationState(userId: string | null = null) {
  writePrototypeSession(
    {
      creativeDirection: { mode: 'auto', version: CREATIVE_DIRECTION_AUTO_VERSION },
      agentMode: 'image',
      aspectRatio: 'auto',
      attachments: [],
      prompt: '',
      referencedAttachmentIds: [],
      resolutionTier: '1k',
      selectedBrainModelId: null,
      selectedImageModelId: null,
      selectedPresetIds: {},
      selectedSkillId: null,
      videoDuration: '5 秒',
      videoResolution: '1080P',
    },
    null,
    userId,
  );
}
