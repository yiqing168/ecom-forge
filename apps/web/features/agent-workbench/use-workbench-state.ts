'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { CREATIVE_DIRECTION_AUTO_VERSION } from '@ecom-forge/shared/creative-direction';

import type { ComposerValue } from '@/features/agent-workbench/composer-types';
import { getCreditAccount, getCurrentUser } from '@/lib/auth-api';
import { readPrototypeSession, writePrototypeSession } from '@/lib/prototype-session';

export type WorkbenchState = {
  accountDisplayName: string | null;
  composer: ComposerValue;
  creationAllowed: boolean;
  creditBalance: string | null;
  emailVerified: boolean;
  isAuthenticated: boolean;
  userId: string | null;
};

const initialComposer: ComposerValue = {
  creativeDirection: { mode: 'auto', version: CREATIVE_DIRECTION_AUTO_VERSION },
  agentMode: 'image',
  aspectRatio: 'auto',
  attachmentRoles: {},
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
};

export const initialWorkbenchState: WorkbenchState = {
  accountDisplayName: null,
  composer: initialComposer,
  creationAllowed: false,
  creditBalance: null,
  emailVerified: false,
  isAuthenticated: false,
  userId: null,
};

type WorkbenchAction =
  | { change: Partial<WorkbenchState>; type: 'change' }
  | { change: Partial<ComposerValue>; type: 'composer' }
  | { composer: ComposerValue; preserveGuestDraft: boolean; type: 'hydrate' }
  | { state?: Partial<WorkbenchState>; type: 'reset' };

function reducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  if (action.type === 'hydrate') {
    return { ...state, composer: action.preserveGuestDraft ? state.composer : action.composer };
  }
  if (action.type === 'composer') {
    return { ...state, composer: { ...state.composer, ...action.change } };
  }
  if (action.type === 'reset') {
    return {
      ...initialWorkbenchState,
      ...action.state,
      composer: action.state?.composer ?? initialComposer,
    };
  }
  const accountChanged =
    action.change.userId !== undefined &&
    state.userId !== null &&
    action.change.userId !== state.userId;
  return { ...state, ...(accountChanged ? { composer: initialComposer } : {}), ...action.change };
}

function hydrateState(
  restoreCreation: boolean,
  sessionId: string | null,
  userId: string | null,
): WorkbenchState {
  if (!restoreCreation) return initialWorkbenchState;
  const stored = readPrototypeSession(sessionId, userId);
  return {
    accountDisplayName: null,
    composer: {
      creativeDirection:
        stored.creativeDirection !== undefined
          ? stored.creativeDirection
          : sessionId
            ? undefined
            : initialComposer.creativeDirection,
      agentMode: stored.agentMode ?? initialComposer.agentMode,
      aspectRatio: stored.aspectRatio ?? initialComposer.aspectRatio,
      attachmentRoles: initialComposer.attachmentRoles,
      attachments: initialComposer.attachments,
      prompt: initialComposer.prompt,
      referencedAttachmentIds: initialComposer.referencedAttachmentIds,
      resolutionTier: stored.resolutionTier ?? initialComposer.resolutionTier,
      selectedBrainModelId: stored.selectedBrainModelId ?? initialComposer.selectedBrainModelId,
      selectedBrainModelVersion: stored.selectedBrainModelVersion ?? null,
      selectedImageModelId: stored.selectedImageModelId ?? initialComposer.selectedImageModelId,
      selectedImageModelVersion: stored.selectedImageModelVersion ?? null,
      selectedPresetIds: stored.selectedPresetIds ?? initialComposer.selectedPresetIds,
      selectedSkillId: stored.selectedSkillId ?? initialComposer.selectedSkillId,
      videoDuration: stored.videoDuration ?? initialComposer.videoDuration,
      videoResolution: stored.videoResolution ?? initialComposer.videoResolution,
    },
    creationAllowed: false,
    creditBalance: null,
    emailVerified: false,
    isAuthenticated: false,
    userId: null,
  };
}

export function useWorkbenchState(restoreCreation: boolean, sessionId: string | null = null) {
  const [state, dispatch] = useReducer(reducer, initialWorkbenchState);
  const hydrationScope = JSON.stringify([restoreCreation, sessionId, state.userId]);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const hydrated = authResolved && hydratedScope === hydrationScope;
  const previousScope = useRef<{ userId: string | null; sessionId: string | null } | null>(null);
  const accountRequest = useRef(0);

  const refreshAccount = useCallback(async () => {
    const requestId = ++accountRequest.current;
    try {
      const result = await getCurrentUser();
      const creditAccount = await getCreditAccount().catch(() => null);
      if (requestId !== accountRequest.current) return;
      dispatch({
        change: {
          accountDisplayName: result.user.display_name,
          creationAllowed: result.access.can_create,
          creditBalance: creditAccount?.balance ?? null,
          emailVerified: result.user.email_verified,
          isAuthenticated: true,
          userId: result.user.id,
        },
        type: 'change',
      });
    } catch (error) {
      if (requestId === accountRequest.current) {
        dispatch({
          type: 'change',
          change: {
            accountDisplayName: null,
            creationAllowed: false,
            creditBalance: null,
            emailVerified: false,
            isAuthenticated: false,
            userId: null,
          },
        });
      }
      throw error;
    } finally {
      if (requestId === accountRequest.current) setAuthResolved(true);
    }
  }, []);

  useEffect(() => {
    if (!authResolved) return;
    const previous = previousScope.current;
    dispatch({
      composer: hydrateState(restoreCreation, sessionId, state.userId).composer,
      preserveGuestDraft:
        previous !== null &&
        previous.userId === null &&
        state.userId !== null &&
        previous.sessionId === null &&
        sessionId === null,
      type: 'hydrate',
    });
    previousScope.current = { userId: state.userId, sessionId };
    setHydratedScope(hydrationScope);
  }, [authResolved, hydrationScope, restoreCreation, sessionId, state.userId]);

  useEffect(() => {
    if (!hydrated) return;
    // A route change must never persist the previous session's render into the new scope.
    writePrototypeSession(state.composer, sessionId, state.userId);
  }, [hydrated, sessionId, state.composer, state.userId]);

  useEffect(() => {
    void refreshAccount().catch(() => undefined);
    return () => {
      accountRequest.current += 1;
    };
  }, [refreshAccount]);

  const change = useCallback(
    (changeSet: Partial<WorkbenchState>) => dispatch({ change: changeSet, type: 'change' }),
    [],
  );
  const changeComposer = useCallback(
    (changeSet: Partial<ComposerValue>) => dispatch({ change: changeSet, type: 'composer' }),
    [],
  );
  const reset = useCallback(
    (stateOverrides?: Partial<WorkbenchState>) =>
      dispatch(stateOverrides ? { state: stateOverrides, type: 'reset' } : { type: 'reset' }),
    [],
  );

  return { authResolved, change, changeComposer, hydrated, refreshAccount, reset, state };
}
