'use client';

import { Sparkles } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthDialog } from '@/features/agent-workbench/auth-dialog';
import { AttachmentPickerDialog } from '@/features/agent-workbench/attachment-picker-dialog';
import { catalogDefaultChanges } from '@/features/agent-workbench/catalog-defaults';
import { restoreSessionCreativeDirection } from '@/features/agent-workbench/session-creative-direction';
import { restoreSessionModelSelection } from '@/features/agent-workbench/session-model-selection';
import type { ComposerProps } from '@/features/agent-workbench/composer';
import type { ConversationProps } from '@/features/agent-workbench/conversation';
import {
  showcaseComposerChanges,
  type ShowcaseExample,
} from '@/features/agent-workbench/showcase-data';
import {
  SessionHistory,
  SessionSidebar,
  type SessionPreview,
} from '@/features/agent-workbench/session-history';
import { useAgentCatalogs } from '@/features/agent-workbench/use-agent-catalogs';
import { useAgentConversation } from '@/features/agent-workbench/use-agent-conversation';
import { useAgentSessions } from '@/features/agent-workbench/use-agent-sessions';
import {
  initialWorkbenchState,
  useWorkbenchState,
} from '@/features/agent-workbench/use-workbench-state';
import { projectWorkflowReviewState } from '@/features/agent-workbench/workflow-public-state';
import { useWorkflowRealtimeCollection } from '@/features/realtime/use-workflow-realtime';
import { WorkbenchContent, type WorkbenchView } from '@/features/agent-workbench/workbench-content';
import { buildTurnPayload } from '@/features/agent-workbench/turn-payload';
import { AgentApiError, retryFailedImage } from '@/lib/agent-api';
import { PRODUCT_ROUTES } from '@/lib/product-navigation';
import {
  consumeAuthRedirect,
  markAuthRedirect,
  readAuthRedirect,
  resetPrototypeCreationState,
} from '@/lib/prototype-session';

export function AgentWorkbench({ view }: { view: WorkbenchView }) {
  const router = useRouter();
  const pathname = usePathname();
  const routeScope = useRef({ pathname });
  if (routeScope.current.pathname !== pathname) routeScope.current = { pathname };
  const activeSessionId = view === 'session' ? pathname.split('/').at(-1) : 'new';
  const composerRef = useRef<HTMLDivElement>(null);
  const requireExplicitModelSelection = useRef(false);
  const [modelSessionId, setModelSessionId] = useState<string | null>(null);
  const [revealSubmittedTurnId, setRevealSubmittedTurnId] = useState<string | null>(null);
  const { authResolved, change, changeComposer, hydrated, refreshAccount, reset, state } =
    useWorkbenchState(
      view !== 'session-new',
      view === 'session' ? (activeSessionId ?? null) : null,
    );
  const catalogs = useAgentCatalogs(authResolved && state.isAuthenticated);
  const sessions = useAgentSessions(authResolved && state.isAuthenticated);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [composerError, setComposerError] = useState('');
  const [postAuthRoute, setPostAuthRoute] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [retryWorkflowRunIds, setRetryWorkflowRunIds] = useState<string[]>([]);
  const [retryLinks, setRetryLinks] = useState<
    Record<
      string,
      { sourceWorkflowRunId: string; workflowRunId: string; taskId: string; status: string }
    >
  >({});
  const workspace = view !== 'home';
  const { composer } = state;
  const handleRealtimeAuthenticationRequired = useCallback(() => {
    setAuthOpen(true);
  }, []);
  const conversation = useAgentConversation({
    enabled: authResolved && state.isAuthenticated && view === 'session',
    onAuthenticationRequired: handleRealtimeAuthenticationRequired,
    sessionId: view === 'session' && activeSessionId ? activeSessionId : null,
  });
  const modelSelectionReady =
    hydrated &&
    (view !== 'session' ||
      (modelSessionId === activeSessionId && conversation.session?.session.id === activeSessionId));
  useEffect(() => {
    const submittedTurnId = revealSubmittedTurnId;
    if (!submittedTurnId || conversation.snapshot?.id !== submittedTurnId) return;

    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ behavior: 'smooth', top: document.documentElement.scrollHeight });
      setRevealSubmittedTurnId((current) => (current === submittedTurnId ? null : current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation.snapshot?.id, revealSubmittedTurnId]);
  const workflowTurns = (conversation.session?.turns ?? []).filter((turn) => turn.workflow_run_id);
  const workflowRunIds = [
    ...workflowTurns.flatMap((turn) => (turn.workflow_run_id ? [turn.workflow_run_id] : [])),
    ...(conversation.snapshot?.workflow_run_id ? [conversation.snapshot.workflow_run_id] : []),
    ...retryWorkflowRunIds,
  ];
  const workflowCollection = useWorkflowRealtimeCollection(workflowRunIds, {
    onAuthenticationRequired: handleRealtimeAuthenticationRequired,
  });
  const projectedWorkflowSnapshots = Object.fromEntries(
    Object.entries(workflowCollection.snapshots).map(([id, workflowSnapshot]) => [
      id,
      {
        ...workflowSnapshot,
        tasks: workflowSnapshot.tasks.map((task) => {
          const retry = retryLinks[task.id];
          return retry && retry.sourceWorkflowRunId === id
            ? {
                ...task,
                retryable: false,
                latest_retry: {
                  workflow_run_id: retry.workflowRunId,
                  task_id: retry.taskId,
                  status: retry.status,
                },
              }
            : task;
        }),
      },
    ]),
  );
  const discoveredRetryWorkflowKey = [
    ...new Set(
      Object.values(projectedWorkflowSnapshots).flatMap((workflowSnapshot) =>
        workflowSnapshot.tasks.flatMap((task) =>
          task.latest_retry ? [task.latest_retry.workflow_run_id] : [],
        ),
      ),
    ),
  ]
    .sort()
    .join('|');

  useEffect(() => {
    setRetryWorkflowRunIds([]);
    setRetryLinks({});
  }, [activeSessionId]);

  useEffect(() => {
    const discoveredRetryWorkflowRunIds = discoveredRetryWorkflowKey
      ? discoveredRetryWorkflowKey.split('|')
      : [];
    if (discoveredRetryWorkflowRunIds.length === 0) return;
    setRetryWorkflowRunIds((current) => {
      const next = [...new Set([...current, ...discoveredRetryWorkflowRunIds])];
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [discoveredRetryWorkflowKey]);

  const handleRetryImage = useCallback(async (workflowRunId: string, taskId: string) => {
    const retriedScope = routeScope.current;
    const result = await retryFailedImage(workflowRunId, taskId);
    if (routeScope.current !== retriedScope) return;
    setRetryLinks((current) => ({
      ...current,
      [taskId]: {
        sourceWorkflowRunId: workflowRunId,
        workflowRunId: result.workflow_run_id,
        taskId: result.task_id,
        status: result.status,
      },
    }));
    setRetryWorkflowRunIds((current) =>
      current.includes(result.workflow_run_id) ? current : [...current, result.workflow_run_id],
    );
  }, []);
  const currentWorkflowSnapshot = conversation.snapshot?.workflow_run_id
    ? (projectedWorkflowSnapshots[conversation.snapshot.workflow_run_id] ?? null)
    : null;
  const backgroundWorkflows = workflowTurns
    .filter((turn) => turn.id !== conversation.snapshot?.id)
    .flatMap((turn) => {
      if (!turn.workflow_run_id) return [];
      const aspectRatio = turn.generation_preferences?.aspect_ratio;
      const workflowSnapshot = projectedWorkflowSnapshots[turn.workflow_run_id] ?? null;
      return [
        {
          aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : undefined,
          snapshot: workflowSnapshot,
          turnId: turn.id,
          turnStatus: turn.user_status,
          workflowReviewState: projectWorkflowReviewState(workflowSnapshot),
        },
      ];
    });

  useEffect(() => {
    const authRedirect = readAuthRedirect();
    if (authRedirect) {
      setPostAuthRoute(authRedirect);
      setAuthOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!workspace || !authResolved || state.isAuthenticated) return;
    markAuthRedirect(pathname);
    router.replace('/');
  }, [authResolved, pathname, router, state.isAuthenticated, workspace]);

  useEffect(() => {
    if (!authResolved || !postAuthRoute) return;
    if (!state.isAuthenticated) {
      setAuthOpen(true);
      return;
    }
    const route = postAuthRoute;
    setPostAuthRoute(null);
    setAuthOpen(false);
    consumeAuthRedirect();
    window.location.assign(route);
  }, [authResolved, postAuthRoute, router, state.isAuthenticated]);

  useEffect(() => {
    requireExplicitModelSelection.current = false;
    setModelSessionId(null);
    setComposerError('');
    setAttachmentPickerOpen(false);
    setRevealSubmittedTurnId(null);
    setToast('');
  }, [activeSessionId]);

  useEffect(() => {
    if (
      !hydrated ||
      view !== 'session' ||
      catalogs.status !== 'ready' ||
      !activeSessionId ||
      conversation.session?.session.id !== activeSessionId ||
      modelSessionId === activeSessionId
    ) {
      return;
    }
    const restored = restoreSessionModelSelection({
      brainModels: catalogs.brainModels?.items ?? [],
      composer,
      imageModels: catalogs.imageModels?.items ?? [],
      turns: conversation.session.turns,
    });
    requireExplicitModelSelection.current = restored.requireExplicitSelection;
    const creativeDirection = restoreSessionCreativeDirection(
      composer.creativeDirection,
      conversation.session.turns,
      conversation.session.session.creative_direction_snapshot,
    );
    changeComposer({ ...restored.choices, creativeDirection });
    setModelSessionId(activeSessionId);
    if (restored.requireExplicitSelection) {
      setComposerError('此会话原选模型已不可用或版本已变更，请重新选择模型');
    } else if (creativeDirection === null) {
      setComposerError('设计师选择已失效，请重新选择');
    }
  }, [
    activeSessionId,
    catalogs,
    changeComposer,
    composer,
    conversation.session,
    hydrated,
    modelSessionId,
    view,
  ]);

  useEffect(() => {
    if (!modelSelectionReady) return;
    if (catalogs.status !== 'ready') return;
    const brainModels = catalogs.brainModels?.items ?? [];
    const imageModels = catalogs.imageModels?.items ?? [];
    const changeSet = catalogDefaultChanges({
      brainModels,
      composer,
      imageModels,
      requireExplicitSelection: requireExplicitModelSelection.current,
      videoModels: catalogs.videoModels?.items ?? [],
    });
    if (Object.keys(changeSet).length > 0) changeComposer(changeSet);
  }, [catalogs, changeComposer, composer, modelSelectionReady]);

  useEffect(() => {
    if (
      view !== 'session' ||
      !activeSessionId ||
      conversation.session?.session.id !== activeSessionId
    )
      return;
    const direction = restoreSessionCreativeDirection(
      undefined,
      conversation.session.turns,
      conversation.session.session.creative_direction_snapshot,
    );
    if (JSON.stringify(direction) !== JSON.stringify(composer.creativeDirection))
      changeComposer({ creativeDirection: direction });
  }, [activeSessionId, changeComposer, composer.creativeDirection, conversation.session, view]);

  useEffect(() => {
    if (!hydrated || view !== 'session' || catalogs.status !== 'ready') return;
    const sessionDetail = conversation.session;
    if (sessionDetail?.session.id !== activeSessionId) return;
    const sessionSkillSlug = sessionDetail?.session.primary_skill_slug;
    if (!sessionSkillSlug) return;
    const sessionSkill = catalogs.skills?.items.find((skill) => skill.slug === sessionSkillSlug);
    if (!sessionSkill) return;
    const selectedPresetIds = Object.fromEntries(
      sessionDetail.session.preset_selections.flatMap((selection) => {
        const slot = sessionSkill.preset_slots.find((item) => item.slot === selection.slot);
        const selectedPresetSlug = versionlessId(selection.preset_id);
        const option = slot?.options.find(
          (item) => versionlessId(item.preset_id) === selectedPresetSlug,
        );
        return option ? [[selection.slot, option.preset_id]] : [];
      }),
    );
    if (
      composer.selectedSkillId === sessionSkill.primary_skill_id &&
      canonicalRecord(composer.selectedPresetIds) === canonicalRecord(selectedPresetIds)
    ) {
      return;
    }
    changeComposer({
      agentMode: 'image',
      attachmentRoles: {},
      selectedPresetIds,
      selectedSkillId: sessionSkill.primary_skill_id,
    });
  }, [
    activeSessionId,
    catalogs.skills?.items,
    catalogs.status,
    changeComposer,
    composer.selectedSkillId,
    composer.selectedPresetIds,
    conversation.session?.session.primary_skill_slug,
    conversation.session?.session.preset_selections,
    conversation.session?.session.id,
    hydrated,
    view,
  ]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function clearCreation(route: '/' | '/workspace/session/new') {
    if (view !== 'session') reset({ ...state, composer: initialWorkbenchState.composer });
    setComposerError('');
    resetPrototypeCreationState(state.userId);
    router.push(route);
  }

  function handleSelectExample(example: ShowcaseExample) {
    const changes = showcaseComposerChanges(example, catalogs.skills?.items ?? []);
    if (!changes) return;
    changeComposer(changes);
    setComposerError('');
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function handleSubmit() {
    if (!modelSelectionReady || requireExplicitModelSelection.current) return;
    if (!composer.prompt.trim() && composer.attachments.length === 0) {
      setComposerError('请输入消息或添加图片');
      return;
    }
    const attachmentIds = new Set(composer.attachments.map((item) => item.id));
    if (composer.referencedAttachmentIds.some((id) => !attachmentIds.has(id))) {
      setComposerError('引用附件已移除，请重新选择');
      return;
    }
    if (!state.isAuthenticated) {
      setAuthOpen(true);
      return;
    }
    if (!state.creationAllowed) {
      setComposerError(
        state.emailVerified ? '当前账户暂时不能发起生成' : '请先完成邮箱验证，再开始生成',
      );
      if (!state.emailVerified) setAuthOpen(true);
      return;
    }

    const submittedScope = routeScope.current;
    try {
      const response = await conversation.submit(
        buildTurnPayload({
          catalogs,
          composer,
          ...(view === 'session' && activeSessionId ? { sessionId: activeSessionId } : {}),
        }),
      );
      if (routeScope.current !== submittedScope) return;
      setComposerError('');
      changeComposer({
        attachmentRoles: {},
        attachments: [],
        prompt: '',
        referencedAttachmentIds: [],
      });
      sessions.reload();
      if (view !== 'session') router.push(`/workspace/session/${response.session_id}`);
      else setRevealSubmittedTurnId(response.turn_id);
    } catch (cause) {
      if (routeScope.current !== submittedScope) return;
      if (cause instanceof AgentApiError) {
        if (
          new Set([
            'MODEL_CATALOG_STALE',
            'MODEL_SELECTION_INVALID',
            'MODEL_SELECTION_REQUIRED',
          ]).has(cause.code)
        ) {
          requireExplicitModelSelection.current = true;
          changeComposer({
            selectedBrainModelId: null,
            selectedBrainModelVersion: null,
            selectedImageModelId: null,
            selectedImageModelVersion: null,
          });
          catalogs.reload();
        } else if (
          new Set(['SKILL_SELECTION_INVALID', 'SKILL_SELECTION_REQUIRED']).has(cause.code)
        ) {
          changeComposer({ selectedPresetIds: {}, selectedSkillId: null });
          catalogs.reload();
        } else if (cause.code === 'SKILL_VERSION_DRIFT') {
          catalogs.reload();
        } else if (cause.code === 'SESSION_SKILL_MISMATCH') {
          void conversation.loadSession();
        }
      }
      setComposerError(cause instanceof Error ? cause.message : '发送失败，请重试');
    }
  }

  function handleNavigation(label: string) {
    if (label === '创作') {
      clearCreation('/');
      return;
    }
    const route = PRODUCT_ROUTES[label];
    if (!route) return;
    if (!authResolved) {
      setPostAuthRoute(route);
      return;
    }
    if (!state.isAuthenticated) {
      markAuthRedirect(route);
      setPostAuthRoute(route);
      setAuthOpen(true);
      return;
    }
    router.push(route);
  }

  function handleReferenceAttachment(id: string) {
    if (!composer.referencedAttachmentIds.includes(id)) {
      changeComposer({ referencedAttachmentIds: [...composer.referencedAttachmentIds, id] });
    }
    setComposerError('');
  }

  function handleComposerChange(changeSet: Partial<typeof composer>) {
    if (!hydrated) return;
    const next = { ...changeSet };
    if (changeSet.selectedBrainModelId !== undefined) {
      next.selectedBrainModelVersion =
        catalogs.brainModels?.items.find((model) => model.id === changeSet.selectedBrainModelId)
          ?.version_no ?? null;
    }
    if (changeSet.selectedImageModelId !== undefined) {
      next.selectedImageModelVersion =
        catalogs.imageModels?.items.find((model) => model.id === changeSet.selectedImageModelId)
          ?.version_no ?? null;
    }
    changeComposer(next);
    if (next.creativeDirection && !requireExplicitModelSelection.current) setComposerError('');
    if (
      changeSet.selectedBrainModelId !== undefined ||
      changeSet.selectedImageModelId !== undefined
    ) {
      const restored = restoreSessionModelSelection({
        brainModels: catalogs.brainModels?.items ?? [],
        composer: { ...composer, ...next },
        imageModels: catalogs.imageModels?.items ?? [],
        turns: [],
      });
      if (
        restored.choices.selectedBrainModelId &&
        restored.choices.selectedImageModelId &&
        !restored.requireExplicitSelection
      ) {
        requireExplicitModelSelection.current = false;
        setComposerError('');
      }
    }
  }

  function handleSelectSession(session: SessionPreview) {
    if (activeSessionId === session.id) return;
    setComposerError('');
    router.push(`/workspace/session/${session.id}`);
  }

  async function handleArchiveSession(session: SessionPreview) {
    const archivedScope = routeScope.current;
    await sessions.archive(session);
    if (routeScope.current === archivedScope && activeSessionId === session.id)
      router.push('/workspace/session/new');
  }

  const composerProps: ComposerProps = {
    catalog: {
      brainModels: modelSelectionReady ? (catalogs.brainModels?.items ?? []) : [],
      error: catalogs.error,
      imageModels: modelSelectionReady ? (catalogs.imageModels?.items ?? []) : [],
      skills: catalogs.skills?.items ?? [],
      status: catalogs.status,
      videoModels: catalogs.videoModels?.items ?? [],
    },
    disabled: conversation.submitting || !modelSelectionReady,
    creditBalance: state.creditBalance,
    error: composerError,
    onAddAttachment: () => setAttachmentPickerOpen(true),
    onChange: handleComposerChange,
    onReferenceAttachment: handleReferenceAttachment,
    onRemoveAttachment: (id) => {
      const nextRoles = { ...composer.attachmentRoles };
      delete nextRoles[id];
      changeComposer({
        attachmentRoles: nextRoles,
        attachments: composer.attachments.filter((item) => item.id !== id),
        referencedAttachmentIds: composer.referencedAttachmentIds.filter((item) => item !== id),
      });
    },
    onReloadCatalog: catalogs.reload,
    onSubmit: () => void handleSubmit(),
    continuation: view === 'session' && Boolean(activeSessionId),
    skillLocked: view === 'session',
    creativeDirectionSnapshot:
      conversation.session && conversation.session.session.id === activeSessionId
        ? conversation.session.session.creative_direction_snapshot
        : undefined,
    value: composer,
  };
  const conversationProps: ConversationProps = {
    actionPending: conversation.actionPending,
    backgroundWorkflows,
    error: conversation.error,
    hasPendingComposerImages: composer.attachments.length > 0,
    loadingOlder: conversation.loadingOlder,
    loading: conversation.loading,
    onAddClarificationImage: () => {
      setAttachmentPickerOpen(true);
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    },
    onConfirm: conversation.confirm,
    onInterrupt: conversation.interrupt,
    onLoadOlder: conversation.loadOlder,
    onRetryImage: handleRetryImage,
    realtimeStatus: conversation.realtimeStatus,
    retrySnapshots: projectedWorkflowSnapshots,
    session: conversation.session,
    snapshot: conversation.snapshot,
    workflowArtifacts: currentWorkflowSnapshot?.artifacts ?? [],
    workflowReviewState: projectWorkflowReviewState(currentWorkflowSnapshot),
    workflowTasks: currentWorkflowSnapshot?.tasks ?? [],
  };

  const workspaceAuthPending = workspace && (!authResolved || !state.isAuthenticated);

  return (
    <AppShell
      account={{ balance: state.creditBalance, displayName: state.accountDisplayName }}
      navigation={{
        activeItem: workspace ? '生成' : '创作',
        isAuthenticated: workspace ? true : state.isAuthenticated,
        onNavigate: handleNavigation,
      }}
      secondaryNavigation={
        workspace ? (
          <SessionSidebar
            activeId={activeSessionId}
            error={workspaceAuthPending ? '' : sessions.error}
            loading={workspaceAuthPending || sessions.loading}
            loadingMore={sessions.loadingMore}
            mutationId={sessions.mutationId}
            nextCursor={sessions.nextCursor}
            onArchive={handleArchiveSession}
            onLoadMore={() => void sessions.loadMore()}
            onNewSession={() => clearCreation('/workspace/session/new')}
            onQueryChange={sessions.setQuery}
            onRename={sessions.rename}
            onSelect={handleSelectSession}
            query={sessions.query}
            sessions={sessions.items}
          />
        ) : null
      }
      topBar={{
        onLogin: () => setAuthOpen(true),
        onOpenAccount: () => handleNavigation('账户'),
        onOpenGeneration: () => handleNavigation('生成'),
        title:
          view === 'home'
            ? '新会话'
            : view === 'session'
              ? (conversation.session?.session.title ?? '创作会话')
              : '新对话',
        workspace,
        ...(workspace ? { onOpenSessions: () => setSessionsOpen(true) } : {}),
      }}
    >
      <main
        aria-busy={workspaceAuthPending}
        className={`min-h-[calc(100vh-64px)] pb-[76px] lg:pb-0 ${workspace ? 'lg:ml-[408px]' : 'lg:ml-[128px]'}`}
        id="main-content"
      >
        {workspaceAuthPending ? (
          <div
            aria-label="正在验证登录状态"
            className="mx-auto w-full max-w-[980px] space-y-6 px-4 py-8 sm:px-7 lg:px-10"
            role="status"
          >
            <div className="space-y-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <Skeleton className="h-[min(52dvh,480px)] w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <WorkbenchContent
            key={activeSessionId}
            composerProps={composerProps}
            composerRef={composerRef}
            conversationProps={conversationProps}
            onSelectExample={handleSelectExample}
            view={view}
          />
        )}
      </main>
      <AuthDialog
        onOpenChange={setAuthOpen}
        onSuccess={(result) => {
          const redirectRoute = postAuthRoute ?? readAuthRedirect();
          change({
            accountDisplayName: result.user.display_name,
            creationAllowed: result.access.can_create,
            creditBalance: null,
            emailVerified: result.user.email_verified,
            isAuthenticated: true,
          });
          void refreshAccount().catch(() => undefined);
          setAuthOpen(false);
          if (redirectRoute) {
            consumeAuthRedirect();
            setPostAuthRoute(null);
            window.location.assign(redirectRoute);
          } else {
            setToast('登录成功，草稿已保留，请再次点击开始创作');
          }
        }}
        open={authOpen}
      />
      <AttachmentPickerDialog
        currentAttachments={composer.attachments}
        onConfirm={(attachments) => {
          const attachmentIds = new Set(attachments.map((attachment) => attachment.id));
          const attachmentRoles = Object.fromEntries(
            Object.entries(composer.attachmentRoles).filter(([id]) => attachmentIds.has(id)),
          );
          changeComposer({
            attachmentRoles,
            attachments,
            referencedAttachmentIds: composer.referencedAttachmentIds.filter((id) =>
              attachmentIds.has(id),
            ),
          });
          setComposerError('');
        }}
        onOpenChange={setAttachmentPickerOpen}
        open={attachmentPickerOpen}
      />
      <SessionHistory
        activeId={activeSessionId}
        error={sessions.error}
        loading={sessions.loading}
        loadingMore={sessions.loadingMore}
        mutationId={sessions.mutationId}
        nextCursor={sessions.nextCursor}
        onArchive={handleArchiveSession}
        onLoadMore={() => void sessions.loadMore()}
        onNewSession={() => clearCreation('/workspace/session/new')}
        onOpenChange={setSessionsOpen}
        onQueryChange={sessions.setQuery}
        onRename={sessions.rename}
        onSelect={handleSelectSession}
        open={sessionsOpen}
        query={sessions.query}
        sessions={sessions.items}
      />
      {toast ? (
        <div
          aria-live="polite"
          className="fixed bottom-[82px] left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-md bg-[var(--inverse-soft)] px-4 py-3 text-sm font-medium text-white shadow-xl lg:bottom-6"
        >
          <Sparkles aria-hidden="true" size={15} />
          {toast}
        </div>
      ) : null}
    </AppShell>
  );
}

function versionlessId(id: string): string {
  const separator = id.lastIndexOf('@');
  return separator > 0 ? id.slice(0, separator) : id;
}

function canonicalRecord(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
