'use client';

import { AssistantMarkdown } from './assistant-markdown';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  Copy as CopyIcon,
  Download,
  Image,
  ImagePlus,
  LoaderCircle,
  NotebookPen,
  RotateCcw,
  Square,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  ResourceImageViewerProvider,
  useResourceImageViewer,
  type ViewableImage,
} from '@/components/media/resource-image-viewer';
import type { RealtimeConnectionStatus } from '@/features/realtime/realtime.client';
import type { TurnSnapshot } from '@/features/realtime/turn-realtime.types';
import type { WorkflowSnapshot } from '@/features/realtime/workflow-realtime.types';
import type { SessionDetail } from '@/lib/agent-api';
import { artifactAccessUrl, assetAccessUrl } from '@/lib/resource-api';

import { ProductFactsCard } from './product-facts-card';
import { resolveTurnRetryChain, type TurnRetryChainStatus } from './retry-chain';
import type { WorkflowReviewState } from './workflow-public-state';

const RETRY_CHAIN_TURN_HEADERS: Record<Exclude<TurnRetryChainStatus, 'none'>, string> = {
  succeeded: '首次生成未成功，重试已成功',
  running: '首次生成未成功，正在重试',
  failed: '首次生成未成功，重试也未成功',
};
const RETRY_CHAIN_NOTES: Record<Exclude<TurnRetryChainStatus, 'none'>, string> = {
  succeeded: '重试已成功生成图片。',
  running: '正在重试生成图片…',
  failed: '重试也未成功。',
};
const RETRY_CHAIN_NOTE_CLASS_NAMES: Record<Exclude<TurnRetryChainStatus, 'none'>, string> = {
  succeeded: 'text-[var(--info-foreground)]',
  running: 'text-[var(--muted-foreground)]',
  failed: 'text-[var(--danger)]',
};
const RETRY_CHAIN_OUTCOME_REPLACEMENT = '首次生成未成功，相关积分将自动退回；重试已成功生成图片。';

export type ConversationProps = {
  actionPending: boolean;
  backgroundWorkflows: Array<{
    aspectRatio: string | undefined;
    snapshot: WorkflowSnapshot | null;
    turnId: string;
    turnStatus: TurnSnapshot['user_status'];
    workflowReviewState: WorkflowReviewState | null;
  }>;
  error: string;
  hasPendingComposerImages: boolean;
  loadingOlder: boolean;
  loading: boolean;
  onAddClarificationImage: () => void;
  onConfirm: (answers: Record<string, unknown>) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onRetryImage: (workflowRunId: string, taskId: string) => Promise<void>;
  realtimeStatus: RealtimeConnectionStatus;
  retrySnapshots: Record<string, WorkflowSnapshot>;
  session: SessionDetail | null;
  snapshot: TurnSnapshot | null;
  workflowArtifacts: WorkflowSnapshot['artifacts'];
  workflowReviewState: WorkflowReviewState | null;
  workflowTasks: WorkflowSnapshot['tasks'];
};

export function Conversation(props: ConversationProps) {
  return (
    <ResourceImageViewerProvider>
      <ConversationContent {...props} />
    </ResourceImageViewerProvider>
  );
}

function ConversationContent({
  actionPending,
  backgroundWorkflows,
  error,
  hasPendingComposerImages,
  loadingOlder,
  loading,
  onAddClarificationImage,
  onConfirm,
  onInterrupt,
  onLoadOlder,
  onRetryImage,
  realtimeStatus,
  retrySnapshots,
  session,
  snapshot,
  workflowArtifacts,
  workflowReviewState,
  workflowTasks,
}: ConversationProps) {
  const messages = mergeMessages(session, snapshot);
  const turnRetryStatusByTurnId = new Map<string, Exclude<TurnRetryChainStatus, 'none'>>();
  for (const turn of session?.turns ?? []) {
    if (turn.user_status !== 'failed' || !turn.workflow_run_id) continue;
    const status = resolveTurnRetryChain(retrySnapshots, turn.workflow_run_id);
    if (status !== 'none') turnRetryStatusByTurnId.set(turn.id, status);
  }
  if (snapshot?.user_status === 'failed' && snapshot.workflow_run_id) {
    const status = resolveTurnRetryChain(retrySnapshots, snapshot.workflow_run_id);
    if (status !== 'none') turnRetryStatusByTurnId.set(snapshot.id, status);
  }
  const lastAssistantIndexByTurnId = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.turnId) {
      lastAssistantIndexByTurnId.set(message.turnId, index);
    }
  });
  const currentTurnRetryStatus = snapshot
    ? (turnRetryStatusByTurnId.get(snapshot.id) ?? null)
    : null;
  const failureSummaryProjection =
    snapshot?.user_status === 'failed' && currentTurnRetryStatus
      ? RETRY_CHAIN_TURN_HEADERS[currentTurnRetryStatus]
      : (snapshot?.failure_summary ?? null);
  const assistantTurnIds = new Set(
    messages
      .filter((message) => message.role === 'assistant' && message.turnId)
      .map((message) => message.turnId as string),
  );
  const backgroundWorkflowByTurn = new Map(
    backgroundWorkflows.map((workflow) => [workflow.turnId, workflow]),
  );
  const backgroundAssistantAnchorByTurn = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (
      message.role === 'assistant' &&
      message.turnId &&
      backgroundWorkflowByTurn.has(message.turnId) &&
      !backgroundAssistantAnchorByTurn.has(message.turnId)
    ) {
      backgroundAssistantAnchorByTurn.set(message.turnId, index);
    }
  }
  const activityAnchor = findActivityAnchor(messages, snapshot?.id ?? null);
  const assistantActivityAnchor = findAssistantActivityAnchor(messages, snapshot?.id ?? null);
  const showGenerationPlaceholder = shouldShowGenerationPlaceholder(snapshot, messages);
  const imageTasks = workflowTasks.filter(isImageGenerationTask);
  const turnCompleted = snapshot?.user_status === 'completed';
  const messageArtifactIds = new Set(
    messages.flatMap((message) => message.artifactAttachments.map((item) => item.artifact_id)),
  );
  const workflowArtifactsCommitted = areSuccessfulImageOutputsCommitted(
    imageTasks,
    workflowArtifacts,
    messageArtifactIds,
  );
  const hasRetryableImageSlot = imageTasks.some(
    (task) => task.retryable || Boolean(task.latest_retry),
  );
  const projectWorkflow =
    workflowReviewState !== null ||
    !turnCompleted ||
    !workflowArtifactsCommitted ||
    hasRetryableImageSlot;
  const keepOnlyRetrySlots = turnCompleted && workflowArtifactsCommitted && hasRetryableImageSlot;
  const projectedWorkflowTasks = projectWorkflow
    ? keepOnlyRetrySlots
      ? imageTasks.filter((task) => task.retryable || Boolean(task.latest_retry))
      : imageTasks
    : [];
  const projectedTaskIds = new Set(projectedWorkflowTasks.map((task) => task.id));
  const projectedWorkflowArtifacts = projectWorkflow
    ? workflowArtifacts.filter((artifact) => projectedTaskIds.has(artifact.task_id))
    : [];
  const turnAwaitingFirstFeedback =
    snapshot?.user_status === 'thinking' &&
    !messages.some((message) => message.turnId === snapshot.id && message.role === 'assistant');
  const showAgentProgress = Boolean(
    snapshot?.activities.length ||
    snapshot?.response_draft?.text ||
    showGenerationPlaceholder ||
    turnAwaitingFirstFeedback ||
    imageTasks.length > 0 ||
    workflowArtifacts.length > 0 ||
    workflowReviewState !== null,
  );
  const mergeProgressIntoAssistant = assistantActivityAnchor >= 0;
  const projectedArtifactIds = new Set(projectedWorkflowArtifacts.map((artifact) => artifact.id));
  if (loading && !session && !snapshot)
    return <ConversationNotice icon="loading" text="正在加载会话…" />;
  if (error && !session && !snapshot) return <ConversationNotice icon="error" text={error} />;
  return (
    <div className="mx-auto w-full max-w-[960px] px-4 pb-[240px] pt-8 sm:px-6 sm:pt-10">
      {session?.older_cursor ? (
        <div className="mb-7 flex justify-center">
          <Button
            disabled={loadingOlder}
            onClick={() => void onLoadOlder()}
            size="sm"
            variant="ghost"
          >
            {loadingOlder ? '加载中…' : '加载更早消息'}
          </Button>
        </div>
      ) : null}
      {messages.length === 0 ? (
        <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">
          这个会话还没有消息
        </p>
      ) : (
        <div className="space-y-7">
          {messages.map((message, index) => {
            const backgroundWorkflow = message.turnId
              ? (backgroundWorkflowByTurn.get(message.turnId) ?? null)
              : null;
            const currentProgress =
              snapshot &&
              showAgentProgress &&
              mergeProgressIntoAssistant &&
              index === assistantActivityAnchor ? (
                <AgentProgressContent
                  activities={snapshot.activities}
                  aspectRatio={snapshot.generation_preferences?.aspect_ratio}
                  failureSummary={failureSummaryProjection}
                  responseDraft={snapshot.response_draft?.text}
                  showGenerationPlaceholder={showGenerationPlaceholder && !turnCompleted}
                  status={snapshot.user_status}
                  onRetryImage={onRetryImage}
                  retrySnapshots={retrySnapshots}
                  workflowRunId={snapshot.workflow_run_id}
                  workflowArtifacts={projectedWorkflowArtifacts}
                  workflowReviewState={workflowReviewState}
                  workflowTasks={projectedWorkflowTasks}
                />
              ) : null;
            const backgroundProgress =
              message.role === 'assistant' &&
              message.turnId &&
              backgroundAssistantAnchorByTurn.get(message.turnId) === index &&
              backgroundWorkflow ? (
                <BackgroundWorkflowProgress
                  committedArtifactIds={messageArtifactIds}
                  inline
                  onRetryImage={onRetryImage}
                  retrySnapshots={retrySnapshots}
                  workflow={backgroundWorkflow}
                />
              ) : null;
            const retryStatus =
              message.role === 'assistant' && message.turnId
                ? turnRetryStatusByTurnId.get(message.turnId)
                : undefined;
            const isTurnOutcomeMessage =
              message.role === 'assistant' &&
              message.turnId != null &&
              lastAssistantIndexByTurnId.get(message.turnId) === index;
            const retryProjection =
              retryStatus && isTurnOutcomeMessage
                ? retryStatus === 'succeeded' && message.content.includes('已全额退回')
                  ? { content: RETRY_CHAIN_OUTCOME_REPLACEMENT }
                  : {
                      note: RETRY_CHAIN_NOTES[retryStatus],
                      noteClassName: RETRY_CHAIN_NOTE_CLASS_NAMES[retryStatus],
                    }
                : null;
            const clarification =
              snapshot?.pending_confirmation?.type === 'clarification' &&
              message.role === 'assistant' &&
              message.turnId === snapshot.id &&
              lastAssistantIndexByTurnId.get(snapshot.id) === index ? (
                <ClarificationActions
                  disabled={actionPending}
                  hasPendingComposerImages={hasPendingComposerImages}
                  onAddImage={onAddClarificationImage}
                  onConfirm={onConfirm}
                  payload={snapshot.pending_confirmation.public_payload}
                  showQuestion={
                    message.content.trim() !==
                    (typeof snapshot.pending_confirmation.public_payload.question === 'string'
                      ? snapshot.pending_confirmation.public_payload.question.trim()
                      : '')
                  }
                />
              ) : null;
            return (
              <div key={message.id}>
                <Message
                  {...(showAgentProgress && projectWorkflow
                    ? { hiddenArtifactIds: projectedArtifactIds }
                    : {})}
                  {...(retryProjection ? { retryProjection } : {})}
                  message={message}
                  continuation={
                    message.role === 'assistant' &&
                    message.turnId != null &&
                    messages[index - 1]?.role === 'assistant' &&
                    messages[index - 1]?.turnId === message.turnId
                  }
                  progressAfter={snapshot?.user_status === 'thinking' && Boolean(currentProgress)}
                  showActions={
                    (message.turnId == null || isTurnOutcomeMessage) &&
                    !(snapshot?.id === message.turnId && snapshot?.user_status === 'thinking')
                  }
                  {...(clarification ? { clarification } : {})}
                  {...(currentProgress || backgroundProgress
                    ? { progress: currentProgress ?? backgroundProgress }
                    : {})}
                />
                {snapshot &&
                showAgentProgress &&
                !mergeProgressIntoAssistant &&
                index === activityAnchor ? (
                  <AgentProgress
                    activities={snapshot.activities}
                    aspectRatio={snapshot.generation_preferences?.aspect_ratio}
                    failureSummary={failureSummaryProjection}
                    responseDraft={snapshot.response_draft?.text}
                    showGenerationPlaceholder={showGenerationPlaceholder && !turnCompleted}
                    status={snapshot.user_status}
                    onRetryImage={onRetryImage}
                    retrySnapshots={retrySnapshots}
                    workflowRunId={snapshot.workflow_run_id}
                    workflowArtifacts={projectedWorkflowArtifacts}
                    workflowReviewState={workflowReviewState}
                    workflowTasks={projectedWorkflowTasks}
                  />
                ) : null}
                {message.role === 'user' &&
                message.turnId &&
                !assistantTurnIds.has(message.turnId) ? (
                  <BackgroundWorkflowProgress
                    committedArtifactIds={messageArtifactIds}
                    onRetryImage={onRetryImage}
                    retrySnapshots={retrySnapshots}
                    workflow={backgroundWorkflow}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {snapshot && showAgentProgress && !mergeProgressIntoAssistant && activityAnchor < 0 ? (
        <AgentProgress
          activities={snapshot.activities}
          aspectRatio={snapshot.generation_preferences?.aspect_ratio}
          failureSummary={failureSummaryProjection}
          responseDraft={snapshot.response_draft?.text}
          showGenerationPlaceholder={showGenerationPlaceholder && !turnCompleted}
          status={snapshot.user_status}
          onRetryImage={onRetryImage}
          retrySnapshots={retrySnapshots}
          workflowRunId={snapshot.workflow_run_id}
          workflowArtifacts={projectedWorkflowArtifacts}
          workflowReviewState={workflowReviewState}
          workflowTasks={projectedWorkflowTasks}
        />
      ) : null}
      {snapshot?.pending_confirmation?.type === 'clarification' &&
      !assistantTurnIds.has(snapshot.id) ? (
        <ClarificationActions
          disabled={actionPending}
          hasPendingComposerImages={hasPendingComposerImages}
          key={`${snapshot.pending_confirmation.id}:${snapshot.pending_confirmation.version}`}
          onAddImage={onAddClarificationImage}
          onConfirm={onConfirm}
          payload={snapshot.pending_confirmation.public_payload}
          showQuestion
        />
      ) : null}
      {snapshot?.pending_confirmation?.type === 'product_facts' ? (
        <ProductFactsCard
          confirmation={snapshot.pending_confirmation}
          disabled={actionPending}
          onConfirm={onConfirm}
        />
      ) : null}
      {snapshot?.pending_confirmation &&
      snapshot.pending_confirmation.type !== 'clarification' &&
      snapshot.pending_confirmation.type !== 'product_facts' ? (
        <section className="ml-0 mt-6 border-l-2 border-[var(--warning)] py-1 pl-4 sm:ml-11">
          <h2 className="text-sm font-semibold">当前确认暂不可处理</h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--muted-foreground)]">
            请刷新页面；若仍未恢复，请稍后重试。
          </p>
        </section>
      ) : null}
      {snapshot ? (
        <TurnStatus
          failureSummary={failureSummaryProjection}
          actionPending={actionPending}
          onInterrupt={onInterrupt}
          realtimeStatus={realtimeStatus}
          status={snapshot.user_status}
          workflowReviewState={workflowReviewState}
        />
      ) : null}
      {error ? (
        <p className="ml-0 mt-4 text-sm font-medium text-[var(--danger)] sm:ml-11" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AgentProgress({
  activities,
  aspectRatio,
  failureSummary,
  responseDraft,
  showThinkingIndicator = true,
  showGenerationPlaceholder,
  status,
  onRetryImage,
  retrySnapshots,
  workflowRunId,
  workflowArtifacts,
  workflowReviewState,
  workflowTasks,
}: {
  activities: TurnSnapshot['activities'];
  aspectRatio: string | undefined;
  failureSummary?: string | null;
  responseDraft?: string | undefined;
  showThinkingIndicator?: boolean;
  showGenerationPlaceholder: boolean;
  status: TurnSnapshot['user_status'];
  onRetryImage: ConversationProps['onRetryImage'];
  retrySnapshots: Record<string, WorkflowSnapshot>;
  workflowRunId: string | null;
  workflowArtifacts: WorkflowSnapshot['artifacts'];
  workflowReviewState: WorkflowReviewState | null;
  workflowTasks: WorkflowSnapshot['tasks'];
}) {
  return (
    <div className="mt-4 flex items-start gap-3">
      <AgentAvatar className="mt-0" />
      <div className="min-w-0 max-w-[86%] flex-1">
        <p className="mb-1.5 text-xs font-medium text-[var(--muted-foreground)]">创作助手</p>
        <AgentProgressContent
          activities={activities}
          aspectRatio={aspectRatio}
          failureSummary={failureSummary ?? null}
          responseDraft={responseDraft}
          showThinkingIndicator={showThinkingIndicator}
          showGenerationPlaceholder={showGenerationPlaceholder}
          status={status}
          onRetryImage={onRetryImage}
          retrySnapshots={retrySnapshots}
          workflowRunId={workflowRunId}
          workflowArtifacts={workflowArtifacts}
          workflowReviewState={workflowReviewState}
          workflowTasks={workflowTasks}
        />
      </div>
    </div>
  );
}

function AgentProgressContent({
  activities,
  aspectRatio,
  failureSummary,
  responseDraft,
  showThinkingIndicator = true,
  showGenerationPlaceholder,
  status,
  onRetryImage,
  retrySnapshots,
  workflowRunId,
  workflowArtifacts,
  workflowReviewState,
  workflowTasks,
}: {
  activities: TurnSnapshot['activities'];
  aspectRatio: string | undefined;
  failureSummary?: string | null;
  responseDraft?: string | undefined;
  showThinkingIndicator?: boolean;
  showGenerationPlaceholder: boolean;
  status: TurnSnapshot['user_status'];
  onRetryImage: ConversationProps['onRetryImage'];
  retrySnapshots: Record<string, WorkflowSnapshot>;
  workflowRunId: string | null;
  workflowArtifacts: WorkflowSnapshot['artifacts'];
  workflowReviewState: WorkflowReviewState | null;
  workflowTasks: WorkflowSnapshot['tasks'];
}) {
  const terminal =
    workflowReviewState !== null ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped';
  return (
    <>
      {activities.length ? (
        <ActivityStream
          activities={activities}
          failureSummary={failureSummary ?? null}
          status={status}
          workflowReviewState={workflowReviewState}
        />
      ) : showThinkingIndicator && workflowReviewState === null && status === 'thinking' ? (
        <ThinkingIndicator />
      ) : null}
      {status === 'thinking' && responseDraft ? (
        <div aria-label="实时回复草稿" className="mt-3 min-w-0">
          <AssistantMarkdown text={responseDraft} streaming />
        </div>
      ) : null}
      {workflowReviewState ? <WorkflowReviewNotice state={workflowReviewState} /> : null}
      {showGenerationPlaceholder ||
      workflowTasks.length > 0 ||
      workflowArtifacts.length > 0 ||
      workflowReviewState ? (
        <ImageWorkflowSlots
          artifacts={workflowArtifacts}
          aspectRatio={aspectRatio}
          reviewState={workflowReviewState}
          onRetryImage={onRetryImage}
          retrySnapshots={retrySnapshots}
          tasks={workflowTasks}
          terminal={terminal}
          workflowRunId={workflowRunId}
        />
      ) : null}
    </>
  );
}

function BackgroundWorkflowProgress({
  committedArtifactIds,
  inline = false,
  onRetryImage,
  retrySnapshots,
  workflow,
}: {
  committedArtifactIds: ReadonlySet<string>;
  inline?: boolean;
  onRetryImage: ConversationProps['onRetryImage'];
  retrySnapshots: Record<string, WorkflowSnapshot>;
  workflow: ConversationProps['backgroundWorkflows'][number] | null;
}) {
  if (!workflow) return null;
  const allImageTasks = (workflow.snapshot?.tasks ?? []).filter(isImageGenerationTask);
  const workflowArtifacts = workflow.snapshot?.artifacts ?? [];
  const terminal = ['succeeded', 'failed', 'cancelled', 'refunded'].includes(
    workflow.snapshot?.workflow_run.status ?? '',
  );
  const artifactsCommitted = areSuccessfulImageOutputsCommitted(
    allImageTasks,
    workflowArtifacts,
    committedArtifactIds,
  );
  const imageTasks =
    terminal && artifactsCommitted
      ? allImageTasks.filter((task) => task.retryable || Boolean(task.latest_retry))
      : allImageTasks;
  const taskIds = new Set(imageTasks.map((task) => task.id));
  const workflowArtifactsForTasks = workflowArtifacts.filter((artifact) =>
    taskIds.has(artifact.task_id),
  );
  if (inline) {
    return (
      <AgentProgressContent
        activities={[]}
        aspectRatio={workflow.aspectRatio}
        showGenerationPlaceholder={workflow.snapshot === null}
        showThinkingIndicator={false}
        status={workflow.turnStatus}
        onRetryImage={onRetryImage}
        retrySnapshots={retrySnapshots}
        workflowRunId={workflow.snapshot?.workflow_run.id ?? null}
        workflowArtifacts={workflowArtifactsForTasks}
        workflowReviewState={workflow.workflowReviewState}
        workflowTasks={imageTasks}
      />
    );
  }
  return (
    <AgentProgress
      activities={[]}
      aspectRatio={workflow.aspectRatio}
      showGenerationPlaceholder={workflow.snapshot === null}
      showThinkingIndicator={false}
      status={workflow.turnStatus}
      onRetryImage={onRetryImage}
      retrySnapshots={retrySnapshots}
      workflowRunId={workflow.snapshot?.workflow_run.id ?? null}
      workflowArtifacts={workflowArtifactsForTasks}
      workflowReviewState={workflow.workflowReviewState}
      workflowTasks={imageTasks}
    />
  );
}

function ThinkingIndicator() {
  return (
    <div aria-live="polite" className="flex min-h-7 items-center gap-2.5">
      <span className="flex items-end gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            className="size-1.5 animate-bounce rounded-full bg-[var(--primary)]"
            key={dot}
            style={{ animationDelay: `${dot * 140}ms` }}
          />
        ))}
      </span>
      <span className="text-sm text-[var(--muted-foreground)]">正在理解你的需求…</span>
    </div>
  );
}

function ActivityStream({
  activities,
  failureSummary,
  status,
  workflowReviewState,
}: {
  activities: TurnSnapshot['activities'];
  failureSummary?: string | null;
  status: TurnSnapshot['user_status'];
  workflowReviewState: WorkflowReviewState | null;
}) {
  const terminal =
    workflowReviewState !== null ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'waiting_for_you';
  const [expansion, setExpansion] = useState<{ terminal: boolean; expanded: boolean } | null>(null);
  const expanded =
    expansion?.terminal === terminal ? expansion.expanded : !terminal && status === 'thinking';
  const currentIndex = findCurrentActivityIndex(activities);
  const current = activities[currentIndex];
  const visibleActivities = activities.filter(
    (activity, index) =>
      !(
        (activity.status === 'failed' || activity.status === 'blocked') &&
        activities.slice(index + 1).some((later) => later.activity_type === activity.activity_type)
      ),
  );
  const firstStartedAt = activities.find((activity) => activity.started_at)?.started_at ?? null;
  const lastFinishedAt = activities.reduce<string | null>((latest, activity) => {
    if (!activity.finished_at) return latest;
    return !latest || activity.finished_at > latest ? activity.finished_at : latest;
  }, null);
  const totalSeconds =
    firstStartedAt && lastFinishedAt
      ? Math.max(1, Math.round((Date.parse(lastFinishedAt) - Date.parse(firstStartedAt)) / 1000))
      : null;
  return (
    <section aria-label="创作过程">
      <ThinkingHeader
        active={!terminal && current?.status === 'started'}
        expanded={expanded}
        failed={workflowReviewState === null && status === 'failed'}
        label={
          workflowReviewState
            ? '处理步骤已完成'
            : terminal
              ? status === 'failed'
                ? (failureSummary ?? '处理未完成')
                : status === 'stopped'
                  ? '已停止'
                  : totalSeconds === null
                    ? '创作步骤已完成'
                    : `创作步骤 · ${totalSeconds}s`
              : (current?.display_summary ?? '正在思考')
        }
        onToggle={() => setExpansion({ terminal, expanded: !expanded })}
        startedAt={firstStartedAt}
      />
      {expanded ? (
        <ol className="mt-1.5 space-y-1 border-l border-[var(--border)] pl-3">
          {visibleActivities.map((activity) => (
            <li key={activity.activity_id}>
              <ActivityRow activity={activity} />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function ThinkingHeader({
  active,
  expanded,
  failed,
  label,
  onToggle,
  startedAt,
}: {
  active: boolean;
  expanded: boolean;
  failed: boolean;
  label: string;
  onToggle: () => void;
  startedAt: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsedSeconds =
    startedAt && active ? Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000)) : null;
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? '收起创作过程' : '展开创作过程'}
      className="flex min-h-7 w-full max-w-[560px] items-center gap-2 rounded px-1 text-left text-xs font-medium outline-none transition-colors hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      onClick={onToggle}
      type="button"
    >
      {active ? (
        <LoaderCircle
          aria-label="进行中"
          className="shrink-0 animate-spin text-[var(--primary)]"
          size={14}
        />
      ) : failed ? (
        <CircleAlert aria-label="未完成" className="shrink-0 text-[var(--danger)]" size={14} />
      ) : (
        <Check aria-hidden="true" className="shrink-0 text-[var(--muted-foreground)]" size={14} />
      )}
      <span aria-live="polite" className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">
        {label}
        {elapsedSeconds === null ? '' : ` · ${elapsedSeconds}s`}
      </span>
      {expanded ? (
        <ChevronUp aria-hidden="true" className="shrink-0" size={14} />
      ) : (
        <ChevronDown aria-hidden="true" className="shrink-0" size={14} />
      )}
    </button>
  );
}

function activityDurationLabel(activity: TurnSnapshot['activities'][number]): string | null {
  if (!activity.started_at || !activity.finished_at) return null;
  const seconds = (Date.parse(activity.finished_at) - Date.parse(activity.started_at)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds < 1 ? '<1s' : `${Math.round(seconds)}s`;
}

function ActivityRow({ activity }: { activity: TurnSnapshot['activities'][number] }) {
  const duration = activityDurationLabel(activity);
  const unresolved = activity.status === 'failed' || activity.status === 'blocked';
  return (
    <div
      className={`flex min-h-6 min-w-0 items-center gap-2 text-[13px] leading-5 ${
        activity.status === 'started'
          ? 'text-[var(--foreground)]'
          : unresolved
            ? 'text-[var(--danger)]'
            : 'text-[var(--muted-foreground)]'
      }`}
      data-activity-status={activity.status}
    >
      <ActivityIcon status={activity.status} />
      <span className="min-w-0 break-words">{activity.display_summary}</span>
      {duration ? (
        <span className="ml-auto shrink-0 text-[11px] text-[var(--muted-foreground)]">
          {duration}
        </span>
      ) : null}
    </div>
  );
}

function ImageGenerationPlaceholder({ aspectRatio }: { aspectRatio: string | undefined }) {
  const dimensions = placeholderDimensions(aspectRatio);
  return (
    <div
      aria-label="图片生成中"
      className="relative grid size-full animate-pulse place-items-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] text-center"
      role="status"
      style={{ aspectRatio: dimensions.cssRatio, maxWidth: dimensions.maxWidth }}
    >
      <div className="px-4 text-[var(--muted-foreground)]">
        <span className="mx-auto grid size-10 place-items-center rounded-md bg-[var(--soft)] text-[var(--primary)]">
          <Image aria-hidden="true" size={20} />
        </span>
        <span className="mt-3 flex items-center justify-center gap-2 text-sm">
          <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
          图片生成中
        </span>
      </div>
    </div>
  );
}

function ImageWorkflowSlots({
  artifacts,
  aspectRatio,
  onRetryImage,
  reviewState,
  retrySnapshots,
  tasks,
  terminal,
  workflowRunId,
}: {
  artifacts: WorkflowSnapshot['artifacts'];
  aspectRatio: string | undefined;
  onRetryImage: ConversationProps['onRetryImage'];
  reviewState: WorkflowReviewState | null;
  retrySnapshots: Record<string, WorkflowSnapshot>;
  tasks: WorkflowSnapshot['tasks'];
  terminal: boolean;
  workflowRunId: string | null;
}) {
  const [retryingTaskIds, setRetryingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [retryError, setRetryError] = useState('');
  const dimensions = placeholderDimensions(aspectRatio);
  const slots =
    tasks.length > 0
      ? tasks.flatMap((task) =>
          Array.from({ length: task.output_count ?? 1 }, (_, outputIndex) => ({
            task,
            outputIndex,
          })),
        )
      : [
          {
            task: {
              id: 'pending',
              type: 'image.generate',
              status: 'running',
              error_code: null,
              output_count: 1,
              retryable: false,
              latest_retry: null,
              created_at: new Date(0).toISOString(),
              started_at: null,
              ended_at: null,
              latest_attempt: null,
            },
            outputIndex: 0,
          },
        ];
  const fallbackIndexes = new Map<string, number>();
  const artifactBySlot = new Map(
    artifacts.map((artifact) => {
      const fallbackIndex = fallbackIndexes.get(artifact.task_id) ?? 0;
      fallbackIndexes.set(artifact.task_id, fallbackIndex + 1);
      return [`${artifact.task_id}:${artifact.output_index ?? fallbackIndex}`, artifact] as const;
    }),
  );
  const resolvedSlots = slots.map(({ task, outputIndex }) => {
    const resolved = resolveRetrySlot(task, artifacts, workflowRunId, retrySnapshots);
    const retryArtifactBySlot = new Map(
      resolved.artifacts.map((candidate, artifactIndex) => [
        `${candidate.task_id}:${candidate.output_index ?? artifactIndex}`,
        candidate,
      ]),
    );
    const artifact =
      retryArtifactBySlot.get(`${resolved.task.id}:${outputIndex}`) ??
      artifactBySlot.get(`${task.id}:${outputIndex}`);
    return { artifact, outputIndex, resolved, task };
  });
  const viewerItems = resolvedSlots.flatMap(({ artifact }) =>
    artifact ? [viewableArtifact(artifact.id)] : [],
  );
  const viewerIndexByArtifactId = new Map(
    viewerItems.map((item, index) => [item.id, index] as const),
  );
  const completedCount = resolvedSlots.filter(({ artifact }) => Boolean(artifact)).length;
  const hasUnknownRetry = resolvedSlots.some(
    ({ artifact, resolved }) =>
      !artifact &&
      resolved.task.retryable &&
      resolved.task.latest_attempt?.status === 'outcome_unknown',
  );
  return (
    <div className="mt-3">
      {!terminal && tasks.length > 0 && slots.length > 1 ? (
        <p aria-live="polite" className="mb-2 text-xs text-[var(--muted-foreground)]">
          已生成 {completedCount}/{slots.length} 张
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {resolvedSlots.map(({ artifact, outputIndex, resolved, task }, index) => {
          const resultUnknown =
            ['waiting_manual_review', 'failed'].includes(resolved.task.status) &&
            resolved.task.latest_attempt?.status === 'outcome_unknown';
          const failed =
            resultUnknown ||
            (reviewState === null &&
              (['failed', 'cancelled'].includes(resolved.task.status) ||
                (terminal && !resolved.followedRetry)));
          const retrying = retryingTaskIds.has(resolved.task.id);
          return (
            <div
              className="relative min-w-0 overflow-hidden rounded-lg"
              key={`${task.id}:${outputIndex}`}
              style={{ aspectRatio: dimensions.cssRatio, maxWidth: dimensions.maxWidth }}
            >
              {artifact ? (
                <ArtifactImage
                  artifactId={artifact.id}
                  fill
                  viewerIndex={viewerIndexByArtifactId.get(artifact.id) ?? 0}
                  viewerItems={viewerItems}
                />
              ) : failed ? (
                <div
                  aria-label={`第 ${index + 1} 张图片生成失败`}
                  className="grid size-full place-items-center border border-[var(--danger)]/35 bg-[var(--surface-raised)] px-3 text-center text-xs text-[var(--danger)]"
                  role="status"
                >
                  <span className="grid justify-items-center gap-2">
                    <CircleAlert aria-hidden="true" className="mx-auto mb-2" size={18} />
                    {resultUnknown ? '本次生成未完成' : '图片未能生成'}
                    {resolved.task.retryable && resolved.workflowRunId ? (
                      <Button
                        aria-label={`重新生成第 ${index + 1} 张图片`}
                        disabled={retrying}
                        onClick={() => {
                          setRetryError('');
                          setRetryingTaskIds((current) => new Set(current).add(resolved.task.id));
                          void onRetryImage(resolved.workflowRunId!, resolved.task.id)
                            .catch((error: unknown) => {
                              setRetryError(
                                error instanceof Error ? error.message : '重新生成失败，请稍后重试',
                              );
                            })
                            .finally(() => {
                              setRetryingTaskIds((current) => {
                                const next = new Set(current);
                                next.delete(resolved.task.id);
                                return next;
                              });
                            });
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {retrying ? (
                          <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
                        ) : (
                          <RotateCcw aria-hidden="true" size={14} />
                        )}
                        重新生成
                      </Button>
                    ) : null}
                  </span>
                </div>
              ) : reviewState ? (
                <ImageReviewPlaceholder state={reviewState} />
              ) : (
                <ImageGenerationPlaceholder aspectRatio={aspectRatio} />
              )}
            </div>
          );
        })}
        {retryError ? (
          <p className="col-span-full text-xs text-[var(--danger)]" role="alert">
            {retryError}
          </p>
        ) : null}
      </div>
      {hasUnknownRetry && reviewState !== 'result_confirmation' ? (
        <p
          className="mt-2 max-w-[620px] border-l-2 border-[var(--warning)] py-1 pl-3 text-xs leading-5 text-[var(--muted-foreground)]"
          role="status"
        >
          上次生成结果仍未知。重新生成会创建新的请求并独立计费，原结果仍可能迟到。
        </p>
      ) : null}
    </div>
  );
}

function resolveRetrySlot(
  originalTask: WorkflowSnapshot['tasks'][number],
  originalArtifacts: WorkflowSnapshot['artifacts'],
  originalWorkflowRunId: string | null,
  retrySnapshots: Record<string, WorkflowSnapshot>,
): {
  task: WorkflowSnapshot['tasks'][number];
  artifacts: WorkflowSnapshot['artifacts'];
  workflowRunId: string | null;
  followedRetry: boolean;
} {
  let task = originalTask;
  let artifacts = originalArtifacts;
  let workflowRunId = originalWorkflowRunId;
  let followedRetry = false;
  const visited = new Set<string>();
  while (task.latest_retry && visited.size < 16) {
    const retry = task.latest_retry;
    if (visited.has(retry.task_id)) break;
    visited.add(retry.task_id);
    followedRetry = true;
    workflowRunId = retry.workflow_run_id;
    const snapshot = retrySnapshots[retry.workflow_run_id];
    if (!snapshot) {
      task = {
        ...task,
        id: retry.task_id,
        status: retry.status,
        retryable: false,
        latest_retry: null,
      };
      artifacts = [];
      break;
    }
    const retryTask = snapshot.tasks.find((candidate) => candidate.id === retry.task_id);
    if (!retryTask) break;
    task = retryTask;
    artifacts = snapshot.artifacts;
  }
  return { task, artifacts, workflowRunId, followedRetry };
}

function WorkflowReviewNotice({ state }: { state: WorkflowReviewState }) {
  const content =
    state === 'content_review'
      ? {
          description:
            '生成已完成，图片正在进行结果复核。平台将在 24 小时内完成处理；逾期未通过将退回本次积分。',
          heading: '正在复核生成结果',
        }
      : {
          description:
            '生成服务未能返回可确认的结果。你可以立即重新生成；这是一次新的生成并独立计费，原结果仍可能迟到。原请求未结算的冻结积分最迟 30 分钟自动退回。',
          heading: '本次生成未完成',
        };
  return (
    <section
      aria-live="polite"
      className="mt-3 flex max-w-[620px] items-start gap-3 border-l-2 border-[var(--warning)] py-1 pl-3"
      role="status"
    >
      <Clock3 aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--warning)]" size={17} />
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-6">{content.heading}</p>
        <p className="mt-0.5 break-words text-sm leading-6 text-[var(--muted-foreground)]">
          {content.description}
        </p>
      </div>
    </section>
  );
}

function ImageReviewPlaceholder({ state }: { state: WorkflowReviewState }) {
  const label = state === 'content_review' ? '图片结果复核中' : '本次生成未完成';
  return (
    <div
      aria-label={label}
      className="grid size-full place-items-center border border-[var(--warning)]/35 bg-[var(--surface-raised)] px-3 text-center text-xs text-[var(--muted-foreground)]"
      role="status"
    >
      <span>
        <Clock3 aria-hidden="true" className="mx-auto mb-2 text-[var(--warning)]" size={18} />
        {label}
      </span>
    </div>
  );
}

function ActivityIcon({ status }: { status: TurnSnapshot['activities'][number]['status'] }) {
  if (status === 'started') {
    return (
      <LoaderCircle
        aria-label="进行中"
        className="shrink-0 animate-spin text-[var(--primary)]"
        size={14}
      />
    );
  }
  if (status === 'succeeded') {
    return <Check aria-label="已完成" className="shrink-0" size={14} />;
  }
  return <CircleAlert aria-label="未完成" className="shrink-0" size={14} />;
}

function Message({
  continuation = false,
  clarification,
  hiddenArtifactIds,
  message,
  progress,
  progressAfter = false,
  showActions = true,
  retryProjection,
}: {
  continuation?: boolean;
  clarification?: ReactNode;
  hiddenArtifactIds?: ReadonlySet<string>;
  message: ConversationMessage;
  progress?: ReactNode;
  progressAfter?: boolean;
  showActions?: boolean;
  retryProjection?: { content?: string; note?: string; noteClassName?: string };
}) {
  const user = message.role === 'user';
  const displayContent = retryProjection?.content ?? message.content;
  const attachments = hiddenArtifactIds
    ? message.attachments.filter(
        (attachment) =>
          attachment.resourceType !== 'artifact' || !hiddenArtifactIds.has(attachment.resourceId),
      )
    : message.attachments;
  const viewerItems = attachments.map(viewableMessageAttachment);
  const unresolvedAttachmentCount = Math.max(
    0,
    message.attachmentCount - message.attachments.length,
  );
  return (
    <article className={user ? 'flex justify-end gap-3' : 'flex items-start gap-3'}>
      {!user ? (
        continuation ? (
          <span className="w-8 shrink-0" aria-hidden="true" />
        ) : (
          <AgentAvatar />
        )
      ) : null}
      <div className={user ? 'min-w-0 max-w-[82%] sm:max-w-[72%]' : 'min-w-0 max-w-[86%] flex-1'}>
        {!continuation ? (
          <p
            className={`mb-1.5 text-xs font-medium text-[var(--muted-foreground)] ${user ? 'text-right' : ''}`}
          >
            {user ? '你' : '创作助手'}
          </p>
        ) : null}
        <div
          className={
            user
              ? 'rounded-lg rounded-tr-sm bg-[var(--primary-soft)] px-4 py-3 text-[15px] leading-6'
              : 'min-w-0 text-[15px] leading-7 text-[var(--foreground)]'
          }
        >
          {!user && progress && !progressAfter ? <div className="mb-2">{progress}</div> : null}
          {unresolvedAttachmentCount > 0 ? (
            <p className="mb-1.5 text-xs font-medium text-[var(--muted-foreground)]">
              {unresolvedAttachmentCount} 个附件暂时无法预览
            </p>
          ) : null}
          {user && attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap justify-start gap-1.5">
              {attachments.map((attachment, index) => (
                <MessageAttachmentThumbnail
                  attachment={attachment}
                  index={index}
                  key={`${attachment.resourceType}:${attachment.resourceId}`}
                  viewerItems={viewerItems}
                />
              ))}
            </div>
          ) : null}
          {user ? (
            <p className="whitespace-pre-wrap break-words">{displayContent}</p>
          ) : (
            <AssistantMarkdown text={displayContent} />
          )}
          {!user && progress && progressAfter ? <div className="mt-4">{progress}</div> : null}
          {clarification}
          {retryProjection?.note ? (
            <p
              className={`mt-2 text-xs font-medium ${retryProjection.noteClassName ?? 'text-[var(--muted-foreground)]'}`}
              role="status"
            >
              {retryProjection.note}
            </p>
          ) : null}
          {!user && attachments.length > 0 ? (
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {attachments.map((attachment, index) =>
                attachment.resourceType === 'artifact' ? (
                  <ArtifactImage
                    artifactId={attachment.resourceId}
                    {...(attachment.creativeNote ? { creativeNote: attachment.creativeNote } : {})}
                    key={`${attachment.resourceType}:${attachment.resourceId}`}
                    viewerIndex={index}
                    viewerItems={viewerItems}
                  />
                ) : (
                  <MessageAttachmentThumbnail
                    attachment={attachment}
                    index={index}
                    key={`${attachment.resourceType}:${attachment.resourceId}`}
                    viewerItems={viewerItems}
                  />
                ),
              )}
            </div>
          ) : null}
        </div>
        {user || !showActions ? null : <AssistantMessageActions text={displayContent} />}
      </div>
      {user ? (
        <span className="mt-5 grid size-8 shrink-0 place-items-center rounded-full bg-[var(--avatar)] text-sm font-bold text-white">
          我
        </span>
      ) : null}
    </article>
  );
}

function AssistantMessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mt-1.5 flex items-center gap-1">
      <button
        aria-label={copied ? '已复制' : '复制回复内容'}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] outline-none transition-colors hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
          copied ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]'
        }`}
        onClick={() => void copy()}
        type="button"
      >
        {copied ? (
          <Check aria-hidden="true" size={13} />
        ) : (
          <CopyIcon aria-hidden="true" size={13} />
        )}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

function MessageAttachmentThumbnail({
  attachment,
  index,
  viewerItems,
}: {
  attachment: ConversationAttachment;
  index: number;
  viewerItems: ViewableImage[];
}) {
  const { open } = useResourceImageViewer();
  const [state, setState] = useState<{ status: 'error' | 'loading' | 'ready'; url?: string }>({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    const access =
      attachment.resourceType === 'asset'
        ? assetAccessUrl(attachment.resourceId, 'thumbnail', 'preview')
        : artifactAccessUrl(attachment.resourceId, 'thumbnail', 'preview');
    void access
      .then((result) => {
        if (active) setState({ status: 'ready', url: result.url });
      })
      .catch(() => {
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [attachment.resourceId, attachment.resourceType, attempt]);

  const label = `附件第 ${index + 1} 张`;
  if (state.status !== 'ready' || !state.url) {
    return (
      <button
        aria-label={state.status === 'error' ? `${label}加载失败，点击重试` : `${label}加载中`}
        className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-raised)] text-[10px] text-[var(--muted-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        disabled={state.status === 'loading'}
        onClick={() => setAttempt((value) => value + 1)}
        type="button"
      >
        {state.status === 'loading' ? (
          <span className="size-full animate-pulse bg-[var(--media-placeholder)]" />
        ) : (
          '重试'
        )}
      </button>
    );
  }

  return (
    <button
      aria-label={`查看${label}`}
      className="group/thumbnail relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-md border border-black/10 bg-[var(--surface-raised)] shadow-sm outline-none transition-transform duration-200 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[var(--focus)] motion-reduce:transition-none"
      onClick={() => open(viewerItems, index)}
      type="button"
    >
      <img
        alt={label}
        className="size-full object-cover transition-transform duration-200 group-hover/thumbnail:scale-[1.03] motion-reduce:transition-none"
        loading="lazy"
        src={state.url}
      />
    </button>
  );
}

function ArtifactImage({
  artifactId,
  creativeNote,
  fill = false,
  viewerIndex = 0,
  viewerItems,
}: {
  artifactId: string;
  creativeNote?: string;
  fill?: boolean;
  viewerIndex?: number;
  viewerItems?: ViewableImage[];
}) {
  const { open } = useResourceImageViewer();
  const [state, setState] = useState<{ status: 'loading' | 'ready'; url?: string }>({
    status: 'loading',
  });
  const [failed, setFailed] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const noteButtonRef = useRef<HTMLButtonElement>(null);
  const notePanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    setFailed(false);
    artifactAccessUrl(artifactId, 'thumbnail', 'preview')
      .then((result) => {
        if (active) setState({ status: 'ready', url: result.url });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [artifactId, attempt]);
  useEffect(() => {
    if (!noteOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        noteButtonRef.current?.contains(event.target) ||
        notePanelRef.current?.contains(event.target)
      ) {
        return;
      }
      setNoteOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNoteOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [noteOpen]);
  if (failed) {
    return (
      <button
        className={`grid w-full place-items-center rounded-lg border border-[var(--border)] text-xs text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${fill ? 'h-full max-w-none' : 'h-28 max-w-[280px]'}`}
        onClick={() => setAttempt((value) => value + 1)}
        type="button"
      >
        图片加载失败，点击重试
      </button>
    );
  }
  if (state.status !== 'ready' || !state.url) {
    return (
      <div
        aria-label="图片加载中"
        className={`w-full animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] ${fill ? 'h-full max-w-none' : 'h-28 max-w-[280px]'}`}
        role="status"
      />
    );
  }
  const gallery = viewerItems ?? [viewableArtifact(artifactId)];
  return (
    // 签名 URL 仅作为本组件内存中的 <img> 源使用，不写入状态存储或日志。
    <figure className={`group relative m-0 ${fill ? 'size-full' : 'w-full min-w-0'}`}>
      <button
        aria-label="查看生成的图片"
        className={`block w-full cursor-pointer overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${fill ? 'h-full max-w-none' : ''}`}
        onClick={() => open(gallery, viewerIndex)}
        type="button"
      >
        <img
          alt="生成的图片"
          className={`w-full rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] object-contain transition-transform duration-200 group-hover:scale-[1.01] motion-reduce:transition-none ${fill ? 'h-full max-w-none' : 'h-auto max-w-none'}`}
          loading="lazy"
          onError={() => setFailed(true)}
          src={state.url}
        />
      </button>
      <div className="absolute right-2 top-2 z-20 flex gap-1.5">
        {creativeNote ? (
          <button
            aria-expanded={noteOpen}
            aria-label="查看创作笔记"
            className="grid size-8 place-items-center rounded-md border border-white/25 bg-black/80 !text-white shadow-md outline-none backdrop-blur-sm transition-colors hover:bg-black/95 focus-visible:ring-2 focus-visible:ring-white"
            onClick={() => setNoteOpen((value) => !value)}
            ref={noteButtonRef}
            title="查看创作笔记"
            type="button"
          >
            <NotebookPen aria-hidden="true" className="!text-white" size={16} strokeWidth={2.4} />
          </button>
        ) : null}
        <button
          aria-label="下载原图"
          className="grid size-8 place-items-center rounded-md border border-white/25 bg-black/80 !text-white shadow-md outline-none backdrop-blur-sm transition-colors hover:bg-black/95 focus-visible:ring-2 focus-visible:ring-white"
          onClick={() => void downloadArtifact(artifactId)}
          title="下载原图"
          type="button"
        >
          <Download aria-hidden="true" className="!text-white" size={16} strokeWidth={2.4} />
        </button>
      </div>
      {creativeNote && noteOpen ? (
        <div
          aria-label="创作笔记"
          className="absolute left-2 right-2 top-12 z-10 rounded-md border border-white/15 bg-black/88 px-3 py-2 text-left text-xs leading-5 !text-white shadow-lg backdrop-blur-sm"
          ref={notePanelRef}
          role="dialog"
        >
          <p className="mb-1 font-medium">创作笔记</p>
          <p className="whitespace-pre-wrap break-words text-white/85">{creativeNote}</p>
        </div>
      ) : null}
    </figure>
  );
}

async function downloadArtifact(artifactId: string): Promise<void> {
  try {
    const { url } = await artifactAccessUrl(artifactId, 'original', 'download');
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = '';
    window.document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    // 下载失败保持静默；重试由用户再次点击触发。
  }
}

function AgentAvatar({ className = 'mt-5' }: { className?: string }) {
  return (
    <span
      className={`${className} grid size-8 shrink-0 place-items-center rounded-full bg-[var(--agent-avatar)] text-xs font-bold text-white`}
    >
      AI
    </span>
  );
}

function ClarificationActions({
  disabled,
  hasPendingComposerImages,
  onAddImage,
  onConfirm,
  payload,
  showQuestion,
}: {
  disabled: boolean;
  hasPendingComposerImages: boolean;
  onAddImage: () => void;
  onConfirm: (answers: Record<string, unknown>) => Promise<void>;
  payload: Record<string, unknown>;
  showQuestion: boolean;
}) {
  const question = typeof payload.question === 'string' ? payload.question : '请补充创作信息';
  const options = Array.isArray(payload.options)
    ? payload.options.filter(isClarificationOption)
    : [];
  return (
    <section aria-label="快捷回复" className="mt-3 max-w-2xl">
      {showQuestion ? (
        <p className="text-sm leading-6 text-[var(--foreground)]">{question}</p>
      ) : null}
      {options.length ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="建议回复">
          {options.map((option) => (
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal break-words rounded-md px-3 py-2 text-left font-normal sm:min-h-9"
              disabled={disabled || hasPendingComposerImages}
              key={option.id}
              onClick={() => {
                // The conversation hook owns the visible error and preserves the retry key.
                void onConfirm({ selected_option_id: option.id }).catch(() => undefined);
              }}
              size="sm"
              variant="outline"
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button disabled={disabled} onClick={onAddImage} size="sm" type="button" variant="ghost">
          <ImagePlus aria-hidden="true" size={15} />
          附图回复
        </Button>
      </div>
      {hasPendingComposerImages ? (
        <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]" role="status">
          图片已加入输入区，发送消息后我会继续。
        </p>
      ) : null}
    </section>
  );
}

function TurnStatus({
  actionPending,
  failureSummary,
  onInterrupt,
  realtimeStatus,
  status,
  workflowReviewState,
}: {
  actionPending: boolean;
  failureSummary?: string | null;
  onInterrupt: () => Promise<void>;
  realtimeStatus: RealtimeConnectionStatus;
  status: TurnSnapshot['user_status'];
  workflowReviewState: WorkflowReviewState | null;
}) {
  const active = status === 'thinking' && workflowReviewState === null;
  const connectionText = new Set(['reconnecting', 'polling']).has(realtimeStatus)
    ? realtimeStatus === 'polling'
      ? '实时连接不稳定，已切换为定时恢复'
      : '连接中断，正在恢复'
    : null;
  const label = workflowReviewState
    ? null
    : {
        completed: '本轮已完成',
        failed:
          failureSummary ??
          '未取得推理模型的完整响应，具体原因尚未确认；请稍后重新发送，或更换推理模型',
        stopped: '本轮已停止',
        thinking: '创作助手正在处理',
        waiting_for_you: null,
      }[status];
  if (!connectionText && !active && !label) return null;
  return (
    <div className="ml-0 mt-6 flex flex-wrap items-center gap-3 text-sm sm:ml-11">
      {connectionText ? (
        <span className="text-[var(--muted-foreground)]">{connectionText}</span>
      ) : active ? (
        <span className="sr-only">创作助手正在处理</span>
      ) : label ? (
        <span className="text-[var(--muted-foreground)]">{label}</span>
      ) : null}
      {active ? (
        <Button
          disabled={actionPending}
          onClick={() => void onInterrupt()}
          size="sm"
          variant="ghost"
        >
          <Square aria-hidden="true" size={13} />
          {actionPending ? '正在停止…' : '停止'}
        </Button>
      ) : null}
    </div>
  );
}

function ConversationNotice({ icon, text }: { icon: 'error' | 'loading'; text: string }) {
  return (
    <div className="grid min-h-[360px] place-items-center px-6 text-center text-sm text-[var(--muted-foreground)]">
      <div>
        {icon === 'loading' ? (
          <LoaderCircle aria-hidden="true" className="mx-auto mb-3 animate-spin" size={20} />
        ) : (
          <CircleAlert aria-hidden="true" className="mx-auto mb-3" size={20} />
        )}
        {text}
      </div>
    </div>
  );
}

type ArtifactAttachment = { artifact_id: string; creative_note?: string };

type ConversationAttachment = {
  creativeNote?: string;
  position: number;
  resourceId: string;
  resourceType: 'artifact' | 'asset';
};

type ConversationMessage = {
  attachmentCount: number;
  attachments: ConversationAttachment[];
  artifactAttachments: ArtifactAttachment[];
  content: string;
  createdAt: string;
  id: string;
  role: 'assistant' | 'user';
  turnId: string | null;
};

function conversationAttachmentsOf(raw: unknown): ConversationAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((item, index) => {
      if (
        item &&
        typeof item === 'object' &&
        ['artifact', 'asset'].includes(
          String((item as { resource_type?: unknown }).resource_type),
        ) &&
        typeof (item as { resource_id?: unknown }).resource_id === 'string'
      ) {
        const note = (item as { creative_note?: unknown }).creative_note;
        const position = (item as { position?: unknown }).position;
        return [
          {
            resourceId: (item as { resource_id: string }).resource_id,
            resourceType: (item as { resource_type: 'artifact' | 'asset' }).resource_type,
            position:
              Number.isInteger(position) && Number(position) >= 0 ? Number(position) : index,
            ...(typeof note === 'string' && note.trim() ? { creativeNote: note } : {}),
          },
        ];
      }
      return [];
    })
    .sort((left, right) => left.position - right.position);
}

function artifactAttachmentsOf(attachments: ConversationAttachment[]): ArtifactAttachment[] {
  return attachments.flatMap((attachment) =>
    attachment.resourceType === 'artifact'
      ? [
          {
            artifact_id: attachment.resourceId,
            ...(attachment.creativeNote ? { creative_note: attachment.creativeNote } : {}),
          },
        ]
      : [],
  );
}

function viewableMessageAttachment(
  attachment: ConversationAttachment,
  index: number,
): ViewableImage {
  return {
    alt: `附件第 ${index + 1} 张`,
    id: attachment.resourceId,
    resourceType: attachment.resourceType,
  };
}

function viewableArtifact(artifactId: string): ViewableImage {
  return {
    alt: '生成的图片',
    id: artifactId,
    resourceType: 'artifact',
  };
}

function mergeMessages(
  session: SessionDetail | null,
  snapshot: TurnSnapshot | null,
): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>();
  const turnCreatedAt = new Map(
    (session?.turns ?? []).map((turn) => [turn.id, turn.created_at] as const),
  );
  if (snapshot) turnCreatedAt.set(snapshot.id, snapshot.created_at);
  for (const message of session?.messages ?? []) {
    const attachments = conversationAttachmentsOf(message.attachments);
    const artifactAttachments = artifactAttachmentsOf(attachments);
    messages.set(message.id, {
      attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
      attachments,
      artifactAttachments,
      content: message.content,
      createdAt: message.created_at,
      id: message.id,
      role: message.role,
      turnId: message.turn_id,
    });
  }
  for (const message of snapshot?.messages ?? []) {
    const attachments = conversationAttachmentsOf(message.attachments);
    const artifactAttachments = artifactAttachmentsOf(attachments);
    messages.set(message.id, {
      attachmentCount: message.attachments.length,
      attachments,
      artifactAttachments,
      content: message.content,
      createdAt: message.created_at,
      id: message.id,
      role: message.role,
      turnId: snapshot?.id ?? null,
    });
  }
  return [...messages.values()].sort((left, right) => {
    const leftTurnTime = Date.parse(
      (left.turnId && turnCreatedAt.get(left.turnId)) || left.createdAt,
    );
    const rightTurnTime = Date.parse(
      (right.turnId && turnCreatedAt.get(right.turnId)) || right.createdAt,
    );
    if (leftTurnTime !== rightTurnTime) return leftTurnTime - rightTurnTime;
    if (left.turnId !== right.turnId) return (left.turnId ?? '').localeCompare(right.turnId ?? '');
    return (
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      (left.role === right.role ? 0 : left.role === 'user' ? -1 : 1)
    );
  });
}

function findActivityAnchor(messages: ConversationMessage[], turnId: string | null): number {
  if (!turnId) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.turnId === turnId && message.role === 'user') return index;
  }
  return -1;
}

function findAssistantActivityAnchor(
  messages: ConversationMessage[],
  turnId: string | null,
): number {
  if (!turnId) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.turnId === turnId && message.role === 'assistant') return index;
  }
  return -1;
}

function findCurrentActivityIndex(activities: TurnSnapshot['activities']): number {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]?.status === 'started') return index;
  }
  return activities.length - 1;
}

function shouldShowGenerationPlaceholder(
  snapshot: TurnSnapshot | null,
  _messages: ConversationMessage[],
): boolean {
  return Boolean(snapshot?.user_status === 'thinking' && snapshot.workflow_run_id);
}

function isImageGenerationTask(task: WorkflowSnapshot['tasks'][number]): boolean {
  return task.type === 'image.generate' || task.type === 'image.edit';
}

function areSuccessfulImageOutputsCommitted(
  imageTasks: WorkflowSnapshot['tasks'],
  workflowArtifacts: WorkflowSnapshot['artifacts'],
  committedArtifactIds: ReadonlySet<string>,
): boolean {
  const successfulTasks = imageTasks.filter((task) => task.status === 'succeeded');
  if (successfulTasks.length === 0) return true;
  return successfulTasks.every((task) => {
    const taskArtifacts = workflowArtifacts.filter((artifact) => artifact.task_id === task.id);
    return (
      taskArtifacts.length >= (task.output_count ?? 1) &&
      taskArtifacts.every((artifact) => committedArtifactIds.has(artifact.id))
    );
  });
}

function placeholderDimensions(aspectRatio: string | undefined): {
  cssRatio: string;
  maxWidth: number;
} {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio ?? '');
  const width = Number(match?.[1] ?? 1);
  const height = Number(match?.[2] ?? 1);
  const ratio = width > 0 && height > 0 ? width / height : 1;
  if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4) {
    return { cssRatio: '1 / 1', maxWidth: 520 };
  }
  return {
    cssRatio: `${width} / ${height}`,
    maxWidth: Math.min(720, Math.round(520 * ratio)),
  };
}

function isClarificationOption(value: unknown): value is { id: string; label: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { label?: unknown }).label === 'string'
  );
}
