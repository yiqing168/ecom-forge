import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/resource-api', () => ({
  artifactAccessUrl: vi.fn().mockResolvedValue({
    url: 'https://signed.example/thumbnail',
    expires_at: '2026-08-17T09:00:00.000Z',
  }),
  assetAccessUrl: vi.fn().mockResolvedValue({
    url: 'https://signed.example/asset-thumbnail',
    expires_at: '2026-08-17T09:00:00.000Z',
  }),
}));
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyTurnEvent } from '@/features/realtime/turn-realtime.reducer';
import type { TurnRealtimeEvent, TurnSnapshot } from '@/features/realtime/turn-realtime.types';
import type { WorkflowSnapshot } from '@/features/realtime/workflow-realtime.types';
import { artifactAccessUrl, assetAccessUrl } from '@/lib/resource-api';

import { Conversation, type ConversationProps } from './conversation';

afterEach(cleanup);

describe('Conversation', () => {
  it('shows an actionable Brain failure after SSE and refresh without offering image regeneration', () => {
    const props = baseProps();
    const initial = { ...snapshot(), user_status: 'thinking' as const };
    const summary = '推理模型响应超时，本轮已停止；请稍后重新发送，或更换推理模型';
    const failedEvent = textEvent(2, 'turn.failed', {
      public_error_code: 'AGENT_MODEL_UNAVAILABLE',
      summary,
      user_status: 'failed',
    });
    const failed = applyTurnEvent(initial, failedEvent);
    const { rerender } = render(<Conversation {...props} snapshot={failed} />);
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重新生成/ })).toBeNull();
    expect(screen.queryByText('创作助手正在处理')).toBeNull();
    const recovered = { ...failed, failure_summary: summary, last_event_seq: 2 };
    rerender(<Conversation {...props} snapshot={applyTurnEvent(recovered, failedEvent)} />);
    expect(screen.getByText(summary)).toBeTruthy();
    expect(props.onRetryImage).not.toHaveBeenCalled();
  });

  it('keeps public commentary before ongoing progress and joins the final reply without another avatar', () => {
    const initial = snapshot();
    const active = {
      ...initial,
      user_status: 'thinking' as const,
      messages: [
        {
          id: 'z-commentary',
          role: 'assistant' as const,
          content: '先查看这张照片的主体关系。',
          attachments: [],
          created_at: initial.created_at,
        },
      ],
      response_draft: { step_id: 'step-next', draft_seq: 1, text: '## 接下来\n\n正在整理方向' },
    };
    const { container, rerender } = render(<Conversation {...baseProps()} snapshot={active} />);
    const text = container.textContent;
    expect(text.indexOf('先查看这张照片')).toBeLessThan(text.indexOf('正在整理方向'));
    rerender(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...active,
          user_status: 'completed',
          response_draft: null,
          messages: [
            ...active.messages,
            {
              id: 'a-reply',
              role: 'assistant',
              content: '## 海报方案\n\n**保留主体**，调整构图。',
              attachments: [],
              created_at: initial.created_at,
            },
          ],
        }}
      />,
    );
    expect(screen.getAllByText('创作助手')).toHaveLength(1);
    expect(screen.getByText('先查看这张照片的主体关系。')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '海报方案' })).toBeTruthy();
    expect(container.textContent.indexOf('先查看这张照片')).toBeLessThan(
      container.textContent.indexOf('海报方案'),
    );
  });
  it('streams draft and final text, then recovers without duplicating messages', () => {
    const initial = { ...snapshot(), user_status: 'thinking' as const };
    const { rerender } = render(<Conversation {...baseProps()} snapshot={initial} />);
    const draftOne = applyTurnEvent(
      initial,
      textEvent(2, 'turn.response_draft_delta', {
        step_id: 'step-a',
        draft_seq: 1,
        text_delta: '先整理',
      }),
    );
    rerender(<Conversation {...baseProps()} snapshot={draftOne} />);
    expect(screen.getByLabelText('实时回复草稿').textContent).toContain('先整理');
    const draftTwo = applyTurnEvent(
      draftOne,
      textEvent(3, 'turn.response_draft_delta', {
        step_id: 'step-a',
        draft_seq: 2,
        text_delta: '画面方向',
      }),
    );
    rerender(<Conversation {...baseProps()} snapshot={draftTwo} />);
    expect(screen.getByLabelText('实时回复草稿').textContent).toContain('先整理画面方向');

    const finalOne = applyTurnEvent(
      draftTwo,
      textEvent(4, 'turn.message_delta', {
        message_id: 'assistant-final',
        delta_seq: 1,
        is_final: false,
        text_delta: '方案已',
      }),
    );
    rerender(<Conversation {...baseProps()} snapshot={finalOne} />);
    expect(screen.queryByLabelText('实时回复草稿')).toBeNull();
    expect(screen.getByText('方案已')).toBeTruthy();
    const finalTwoEvent = textEvent(5, 'turn.message_delta', {
      message_id: 'assistant-final',
      delta_seq: 2,
      is_final: true,
      text_delta: '整理好。',
    });
    const finalTwo = applyTurnEvent(finalOne, finalTwoEvent);
    rerender(<Conversation {...baseProps()} snapshot={finalTwo} realtimeStatus="reconnecting" />);
    expect(screen.getByText('方案已整理好。')).toBeTruthy();
    expect(screen.getByText('连接中断，正在恢复')).toBeTruthy();
    const recovered = { ...finalTwo, last_event_seq: 5 };
    const replayed = applyTurnEvent(recovered, finalTwoEvent);
    rerender(<Conversation {...baseProps()} snapshot={replayed} realtimeStatus="live" />);
    expect(screen.getAllByText('方案已整理好。')).toHaveLength(1);
    expect(screen.queryByLabelText('实时回复草稿')).toBeNull();
  });
  it('handles a failed shortcut reply and keeps the conversation error visible', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('连接中断'));
    const props = { ...baseProps(), onConfirm, snapshot: clarificationSnapshot() };
    const { rerender } = render(<Conversation {...props} />);
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: '产品展示' }));
      return Promise.resolve();
    });
    rerender(<Conversation {...props} error="连接中断" />);
    expect(screen.getByText('连接中断')).toBeTruthy();
    expect(screen.getByRole('button', { name: '产品展示' })).toHaveProperty('disabled', false);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
  it('submits a suggested clarification reply with one click', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <Conversation {...baseProps()} onConfirm={onConfirm} snapshot={clarificationSnapshot()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '产品展示' }));

    expect(onConfirm).toHaveBeenCalledWith({ selected_option_id: 'product' });
  });

  it('opens image selection from the clarification reply', () => {
    const onAddClarificationImage = vi.fn();
    render(
      <Conversation
        {...baseProps()}
        onAddClarificationImage={onAddClarificationImage}
        snapshot={clarificationSnapshot()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '附图回复' }));
    expect(onAddClarificationImage).toHaveBeenCalledOnce();
  });

  it('does not confirm a clarification while images are staged in the composer', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <Conversation
        {...baseProps()}
        hasPendingComposerImages
        onConfirm={onConfirm}
        snapshot={clarificationSnapshot()}
      />,
    );

    const confirm = screen.getByRole('button', { name: '产品展示' });
    expect(confirm).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('图片已加入输入区，发送消息后我会继续。');
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('requires an explicit visible-text decision and submits normalized product facts', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <Conversation {...baseProps()} onConfirm={onConfirm} snapshot={productFactsSnapshot()} />,
    );

    const submit = screen.getByRole('button', { name: '确认商品事实并继续' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('SKU / 货号（选填）'), {
      target: { value: ' sku-02 ' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(submit);

    expect(onConfirm).toHaveBeenCalledWith({
      sku_code: 'sku-02',
      facts: {
        product_name: '白色水杯',
        primary_colors: ['白色'],
        logos: [],
        visible_text: [],
        materials: [],
        must_preserve: ['杯盖', '杯身比例'],
        unknown_fields: ['材质'],
      },
    });
  });

  it('loads an older message page only when the cursor exists', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    render(
      <Conversation
        {...baseProps()}
        onLoadOlder={onLoadOlder}
        session={{
          session: {
            id: 'session-a',
            title: '测试会话',
            revision: 1,
            primary_skill_slug: 'commerce-main',
            preset_selections: [],
            created_at: '2026-08-17T08:00:00.000Z',
            updated_at: '2026-08-17T08:00:00.000Z',
          },
          messages: [],
          turns: [],
          active_turn_id: null,
          older_cursor: 'older-1',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '加载更早消息' }));
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it('renders sent attachments as thumbnails and opens them as one image gallery', async () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          messages: [
            {
              id: 'message-with-attachments',
              role: 'user',
              content: '参考这两张图继续生成',
              attachments: [
                {
                  resource_type: 'asset',
                  resource_id: 'asset-1',
                  role: 'semantic_reference',
                  position: 0,
                },
                {
                  resource_type: 'artifact',
                  resource_id: 'artifact-1',
                  role: 'semantic_reference',
                  position: 1,
                },
              ],
              created_at: '2026-08-17T08:00:00.000Z',
            },
          ],
        }}
      />,
    );

    const firstThumbnail = await screen.findByRole('img', { name: '附件第 1 张' });
    expect(firstThumbnail.parentElement?.className).toContain('size-12');
    expect(firstThumbnail.parentElement?.className).toContain('cursor-pointer');
    expect(firstThumbnail.parentElement?.parentElement?.className).toContain('justify-start');
    expect(await screen.findByRole('img', { name: '附件第 2 张' })).toBeTruthy();
    expect(screen.queryByText('2 个附件')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查看附件第 2 张' }));
    expect(screen.getByText('正在加载原图…')).toBeTruthy();
    expect(await screen.findByLabelText('图片查看器')).toBeTruthy();
    expect(screen.getByTitle('上一张图片')).toBeTruthy();
    expect(screen.getByTitle('下一张图片')).toBeTruthy();
    expect(screen.getByTitle('放大图片')).toBeTruthy();
    expect(assetAccessUrl).toHaveBeenCalledWith('asset-1', 'original', 'preview');
    expect(artifactAccessUrl).toHaveBeenCalledWith('artifact-1', 'original', 'preview');
  });

  it('renders activity events as a compact live progress stream', () => {
    const activeSnapshot = {
      ...snapshot(),
      user_status: 'thinking' as const,
      messages: [
        {
          id: 'message-user',
          role: 'user' as const,
          content: '基于附件生成一张图',
          attachments: [],
          created_at: '2026-08-17T08:00:00.000Z',
        },
        {
          id: 'message-assistant',
          role: 'assistant' as const,
          content: '方案已经准备好',
          attachments: [],
          created_at: '2026-08-17T08:00:01.000Z',
        },
      ],
    };
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...activeSnapshot,
          activities: [
            {
              activity_id: '22222222-2222-4222-8222-222222222222',
              activity_type: 'context_reading',
              display_summary: '正在理解你的需求',
              status: 'succeeded',
            },
            {
              activity_id: '33333333-3333-4333-8333-333333333333',
              activity_type: 'knowledge_loading',
              display_summary: '正在加载专业知识',
              status: 'started',
            },
            {
              activity_id: '44444444-4444-4444-8444-444444444444',
              activity_type: 'plan_preparing',
              display_summary: '正在准备方案',
              status: 'succeeded',
            },
            {
              activity_id: '55555555-5555-4555-8555-555555555555',
              activity_type: 'safety_checking',
              display_summary: '正在检查安全与权限',
              status: 'failed',
            },
          ],
        }}
      />,
    );

    const progress = screen.getByRole('region', { name: '创作过程' });
    expect(progress).toBeTruthy();
    expect(progress.querySelectorAll('[data-activity-status]')).toHaveLength(4);
    expect(screen.getAllByText('正在加载专业知识')).toHaveLength(2);
    expect(screen.getAllByLabelText('进行中')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '收起创作过程' }));
    expect(progress.querySelectorAll('[data-activity-status]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '展开创作过程' }));
    expect(screen.getByText('正在理解你的需求')).toBeTruthy();
    expect(screen.getByLabelText('未完成')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起创作过程' }));
    expect(progress.querySelectorAll('[data-activity-status]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    const userMessage = screen.getByText('基于附件生成一张图');
    const assistantMessage = screen.getByText('方案已经准备好');
    expect(userMessage.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      assistantMessage.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it.each(['completed', 'failed', 'stopped', 'waiting_for_you'] as const)(
    'collapses live activity on transition to %s while allowing manual expansion',
    (status) => {
      const active = {
        ...snapshot(),
        user_status: 'thinking' as const,
        activities: [
          {
            activity_id: '22222222-2222-4222-8222-222222222222',
            activity_type: 'context_reading' as const,
            display_summary: '正在理解你的需求',
            status: 'succeeded' as const,
          },
        ],
      };
      const { rerender } = render(<Conversation {...baseProps()} snapshot={active} />);
      expect(screen.getByRole('button', { name: '收起创作过程' })).toBeTruthy();
      rerender(<Conversation {...baseProps()} snapshot={{ ...active, user_status: status }} />);
      expect(document.querySelectorAll('[data-activity-status]')).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: '展开创作过程' }));
      expect(document.querySelectorAll('[data-activity-status]')).toHaveLength(1);
    },
  );

  it('keeps completed thinking activity and the final message in one assistant reply', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'completed',
          messages: [
            {
              id: 'message-user-one-reply',
              role: 'user',
              content: '重绘这张图片',
              attachments: [],
              created_at: '2026-08-17T08:00:00.000Z',
            },
            {
              id: 'message-assistant-one-reply',
              role: 'assistant',
              content: '已生成 1 张图片。',
              attachments: [],
              created_at: '2026-08-17T08:00:01.000Z',
            },
          ],
          activities: [
            {
              activity_id: '66666666-6666-4666-8666-666666666666',
              activity_type: 'plan_preparing',
              display_summary: '正在准备方案',
              status: 'succeeded',
              started_at: '2026-08-17T08:00:00.000Z',
              finished_at: '2026-08-17T08:00:01.000Z',
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('创作助手')).toHaveLength(1);
    expect(screen.getByText('创作步骤 · 1s')).toBeTruthy();
    expect(screen.getByText('已生成 1 张图片。')).toBeTruthy();
  });

  it('hides a recovered retry and keeps the final failed step', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'failed',
          failure_summary: '当前技能不支持该生成操作',
          activities: [
            {
              activity_id: '22222222-2222-4222-8222-222222222222',
              activity_type: 'context_reading',
              display_summary: '正在读取已授权的上下文',
              status: 'failed',
            },
            {
              activity_id: '33333333-3333-4333-8333-333333333333',
              activity_type: 'context_reading',
              display_summary: '正在读取已授权的上下文',
              status: 'succeeded',
            },
            {
              activity_id: '44444444-4444-4444-8444-444444444444',
              activity_type: 'plan_preparing',
              display_summary: '正在准备方案',
              status: 'blocked',
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('当前技能不支持该生成操作')).toHaveLength(2);
    expect(screen.getAllByLabelText('未完成').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '展开创作过程' }));
    const recovered = document.querySelector('[data-activity-status="failed"]');
    const succeeded = document.querySelector('[data-activity-status="succeeded"]');
    const blocked = document.querySelector('[data-activity-status="blocked"]');
    expect(recovered).toBeNull();
    expect(succeeded?.textContent).toContain('正在读取已授权的上下文');
    expect(blocked?.getAttribute('class')).toContain('var(--danger)');
  });

  it('reserves the selected image ratio while an image workflow is running', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'thinking',
          workflow_run_id: '11111111-1111-4111-8111-111111111111',
          generation_preferences: {
            schema_version: 2,
            output_kind: 'image',
            aspect_ratio: '9:16',
            resolution_tier: '1k',
          },
          messages: [
            {
              id: 'message-user',
              role: 'user',
              content: '生成一张竖图',
              attachments: [],
              created_at: '2026-08-17T08:00:00.000Z',
            },
          ],
        }}
        workflowTasks={[
          workflowTask('task-1', 'running'),
          workflowTask('task-2', 'queued'),
          workflowTask('task-3', 'queued'),
        ]}
      />,
    );

    const placeholders = screen.getAllByRole('status', { name: '图片生成中' });
    expect(placeholders).toHaveLength(3);
    expect(placeholders[0]?.getAttribute('style')).toContain('aspect-ratio: 9 / 16');
    expect(placeholders[0]?.getAttribute('style')).toContain('max-width: 293px');
    expect(screen.getByText('创作助手')).toBeTruthy();
  });

  it('keeps an earlier workflow anchored after a newer turn starts', async () => {
    render(
      <Conversation
        {...baseProps()}
        backgroundWorkflows={[
          {
            aspectRatio: '1:1',
            snapshot: {
              workflow_run: {
                id: 'workflow-earlier',
                status: 'running',
                trigger_mode: 'agent',
                created_at: '2026-08-17T08:00:00.000Z',
                finished_at: null,
              },
              tasks: [
                workflowTask('task-1', 'succeeded'),
                workflowTask('task-2', 'succeeded'),
                workflowTask('task-3', 'succeeded'),
                workflowTask('task-4', 'failed'),
              ],
              last_event_seq: 8,
              credit_summary: null,
              artifacts: [
                workflowArtifact('task-1', 'artifact-1'),
                workflowArtifact('task-2', 'artifact-2'),
                workflowArtifact('task-3', 'artifact-3'),
              ],
            },
            turnId: 'turn-earlier',
            turnStatus: 'thinking',
            workflowReviewState: null,
          },
        ]}
        session={{
          session: {
            id: 'session-a',
            title: '连续生成',
            revision: 1,
            primary_skill_slug: 'skill-a',
            preset_selections: [],
            created_at: '2026-08-17T08:00:00.000Z',
            updated_at: '2026-08-17T08:01:00.000Z',
          },
          messages: [
            {
              id: 'message-earlier',
              role: 'user',
              content: '第一轮',
              attachments: [],
              turn_id: 'turn-earlier',
              created_at: '2026-08-17T08:00:00.000Z',
            },
            {
              id: 'message-current',
              role: 'user',
              content: '第二轮',
              attachments: [],
              turn_id: 'turn-current',
              created_at: '2026-08-17T08:01:00.000Z',
            },
          ],
          turns: [],
          active_turn_id: 'turn-current',
          older_cursor: null,
        }}
        snapshot={{
          ...snapshot(),
          id: 'turn-current',
          user_status: 'thinking',
          workflow_run_id: 'workflow-current',
          created_at: '2026-08-17T08:01:00.000Z',
        }}
        workflowTasks={[workflowTask('task-current', 'running')]}
      />,
    );

    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(3);
    expect(screen.getByRole('status', { name: '第 4 张图片生成失败' })).toBeTruthy();
    expect(screen.getByText('第一轮')).toBeTruthy();
    expect(screen.getByText('第二轮')).toBeTruthy();
  });

  it('does not duplicate committed artifacts while preserving a failed background slot', async () => {
    render(
      <Conversation
        {...baseProps()}
        backgroundWorkflows={[
          {
            aspectRatio: '1:1',
            snapshot: {
              workflow_run: {
                id: 'workflow-earlier',
                status: 'failed',
                trigger_mode: 'agent',
                created_at: '2026-08-17T08:00:00.000Z',
                finished_at: '2026-08-17T08:01:00.000Z',
              },
              tasks: [
                workflowTask('task-success', 'succeeded'),
                {
                  ...workflowTask('task-failed', 'failed'),
                  retryable: true,
                  latest_retry: null,
                },
              ],
              last_event_seq: 8,
              credit_summary: null,
              artifacts: [workflowArtifact('task-success', 'artifact-success')],
            },
            turnId: 'turn-earlier',
            turnStatus: 'completed',
            workflowReviewState: null,
          },
        ]}
        session={{
          session: {
            id: 'session-a',
            title: 'Partial result',
            revision: 1,
            primary_skill_slug: 'skill-a',
            preset_selections: [],
            created_at: '2026-08-17T08:00:00.000Z',
            updated_at: '2026-08-17T08:02:00.000Z',
          },
          messages: [
            {
              id: 'message-user',
              role: 'user',
              content: 'Generate two images',
              attachments: [],
              turn_id: 'turn-earlier',
              created_at: '2026-08-17T08:00:00.000Z',
            },
            {
              id: 'message-assistant',
              role: 'assistant',
              content: 'One image completed',
              attachments: [
                {
                  resource_type: 'artifact',
                  resource_id: 'artifact-success',
                  role: 'other',
                  position: 0,
                },
              ],
              turn_id: 'turn-earlier',
              created_at: '2026-08-17T08:03:00.000Z',
            },
            {
              id: 'message-assistant-followup',
              role: 'assistant',
              content: 'The failed slot can be retried',
              attachments: [],
              turn_id: 'turn-earlier',
              created_at: '2026-08-17T08:04:00.000Z',
            },
            {
              id: 'message-current-user',
              role: 'user',
              content: 'Second turn',
              attachments: [],
              turn_id: 'turn-current',
              created_at: '2026-08-17T08:01:00.000Z',
            },
          ],
          turns: [
            publicTurn('turn-earlier', 'workflow-earlier', '2026-08-17T08:00:00.000Z'),
            publicTurn('turn-current', 'workflow-current', '2026-08-17T08:01:00.000Z'),
          ],
          active_turn_id: 'turn-current',
          older_cursor: null,
        }}
        snapshot={{
          ...snapshot(),
          id: 'turn-current',
          user_status: 'thinking',
          workflow_run_id: 'workflow-current',
          created_at: '2026-08-17T08:01:00.000Z',
        }}
        workflowTasks={[workflowTask('task-current', 'running')]}
      />,
    );

    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '重新生成第 1 张图片' })).toHaveLength(1);
    const firstAssistant = screen.getByText('One image completed');
    const secondTurn = screen.getByText('Second turn');
    expect(
      firstAssistant.compareDocumentPosition(secondTurn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('retries only the definite failed image task from its slot', async () => {
    const onRetryImage = vi.fn().mockResolvedValue(undefined);
    render(
      <Conversation
        {...baseProps()}
        onRetryImage={onRetryImage}
        session={{
          session: {
            id: 'session-a',
            title: '单图重试',
            revision: 1,
            primary_skill_slug: 'skill-a',
            preset_selections: [],
            created_at: '2026-08-17T08:00:00.000Z',
            updated_at: '2026-08-17T08:01:00.000Z',
          },
          messages: [
            {
              id: 'message-a',
              role: 'user',
              content: '生成四张',
              attachments: [],
              turn_id: 'turn-a',
              created_at: '2026-08-17T08:00:00.000Z',
            },
          ],
          turns: [],
          active_turn_id: 'turn-a',
          older_cursor: null,
        }}
        snapshot={{
          ...snapshot(),
          id: 'turn-a',
          user_status: 'completed',
          workflow_run_id: 'workflow-a',
        }}
        workflowTasks={[
          { ...workflowTask('task-success', 'succeeded') },
          { ...workflowTask('task-failed', 'failed'), retryable: true, latest_retry: null },
        ]}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '重新生成第 2 张图片' }));
    await vi.waitFor(() => expect(onRetryImage).toHaveBeenCalledWith('workflow-a', 'task-failed'));
  });

  it('shows the image placeholder only after workflow creation and keeps it during partial progress', async () => {
    const { rerender } = render(
      <Conversation
        {...baseProps()}
        snapshot={{ ...snapshot(), user_status: 'thinking', workflow_run_id: null }}
      />,
    );
    expect(screen.queryByRole('status', { name: '图片生成中' })).toBeNull();

    rerender(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'thinking',
          workflow_run_id: '11111111-1111-4111-8111-111111111111',
          messages: [
            {
              id: 'message-assistant',
              role: 'assistant',
              content: '图片已经生成',
              attachments: [],
              created_at: '2026-08-17T08:00:00.000Z',
            },
          ],
        }}
        workflowArtifacts={[
          {
            id: '77777777-7777-4777-8777-777777777777',
            task_id: '88888888-8888-4888-8888-888888888888',
            type: 'image',
            visibility: 'private',
            publication_revision: 1,
            output_index: 0,
            created_at: '2026-08-17T08:00:01.000Z',
          },
        ]}
        workflowTasks={[
          workflowTask('88888888-8888-4888-8888-888888888888', 'succeeded'),
          workflowTask('99999999-9999-4999-8999-999999999999', 'running'),
        ]}
      />,
    );
    expect(screen.getByRole('status', { name: '图片生成中' })).toBeTruthy();
    expect(screen.getByText('已生成 1/2 张')).toBeTruthy();
    const generatedImage = await screen.findByRole('img', { name: '生成的图片' });
    expect(generatedImage.className).toContain('object-contain');
    expect(generatedImage.className).not.toContain('object-cover');
  });

  it('renders one stable slot per image task and preserves a failed slot after partial success', async () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'failed',
          workflow_run_id: '11111111-1111-4111-8111-111111111111',
          messages: [
            {
              id: 'message-user',
              role: 'user',
              content: '生成三张三联海报',
              attachments: [],
              created_at: '2026-08-17T08:00:00.000Z',
            },
          ],
        }}
        workflowArtifacts={[
          workflowArtifact('task-1', 'artifact-1'),
          workflowArtifact('task-2', 'artifact-2'),
        ]}
        workflowTasks={[
          workflowTask('task-1', 'succeeded'),
          workflowTask('task-2', 'succeeded'),
          workflowTask('task-3', 'failed'),
        ]}
      />,
    );

    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(2);
    expect(screen.getByRole('status', { name: '第 3 张图片生成失败' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: '图片生成中' })).toBeNull();
  });

  it('renders every output slot when one generation task requests multiple images', async () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'thinking',
          workflow_run_id: '11111111-1111-4111-8111-111111111111',
        }}
        workflowArtifacts={[
          workflowArtifact('task-multi', 'artifact-1', 0),
          workflowArtifact('task-multi', 'artifact-2', 1),
        ]}
        workflowTasks={[workflowTask('task-multi', 'running', 3)]}
      />,
    );

    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(2);
    expect(screen.getAllByRole('status', { name: '图片生成中' })).toHaveLength(1);
    expect(screen.getByText('已生成 2/3 张')).toBeTruthy();
  });

  it('shows an unknown result as unfinished and allows explicit regeneration', async () => {
    const onRetryImage = vi.fn().mockResolvedValue(undefined);
    render(
      <Conversation
        {...baseProps()}
        onRetryImage={onRetryImage}
        snapshot={{ ...snapshot(), user_status: 'thinking', workflow_run_id: 'workflow-a' }}
        workflowReviewState="result_confirmation"
        workflowTasks={[
          {
            ...workflowTask('task-1', 'waiting_manual_review'),
            retryable: true,
            latest_attempt: {
              id: 'attempt-1',
              attempt_no: 1,
              status: 'outcome_unknown',
            },
          },
        ]}
      />,
    );

    expect(screen.getAllByText('本次生成未完成')).toHaveLength(2);
    expect(screen.getByText(/冻结积分最迟 30 分钟自动退回/)).toBeTruthy();
    expect(screen.queryByText(/48 小时/)).toBeNull();
    expect(screen.queryByRole('status', { name: '图片生成中' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新生成第 1 张图片' }));
    await vi.waitFor(() => expect(onRetryImage).toHaveBeenCalledWith('workflow-a', 'task-1'));
  });

  it('isolates an unknown slot and its retry from a still-running sibling', async () => {
    const onRetryImage = vi.fn().mockResolvedValue(undefined);
    const props = {
      ...baseProps(),
      onRetryImage,
      snapshot: { ...snapshot(), user_status: 'thinking' as const, workflow_run_id: 'workflow-a' },
      workflowReviewState: 'result_confirmation' as const,
      workflowArtifacts: [workflowArtifact('task-3', 'artifact-3')],
    };
    const unknownTask = {
      ...workflowTask('task-1', 'waiting_manual_review'),
      retryable: true,
      latest_attempt: { id: 'attempt-1', attempt_no: 1, status: 'outcome_unknown' },
    };
    const { rerender } = render(
      <Conversation
        {...props}
        workflowTasks={[
          unknownTask,
          workflowTask('task-2', 'running'),
          workflowTask('task-3', 'succeeded'),
        ]}
      />,
    );

    expect(screen.getAllByRole('status', { name: '图片生成中' })).toHaveLength(1);
    expect(screen.getByText('已生成 1/3 张')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新生成第 2 张图片' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新生成第 1 张图片' }));
    await vi.waitFor(() =>
      expect(onRetryImage).toHaveBeenCalledExactlyOnceWith('workflow-a', 'task-1'),
    );

    rerender(
      <Conversation
        {...props}
        workflowTasks={[
          {
            ...unknownTask,
            latest_retry: {
              workflow_run_id: 'workflow-retry',
              task_id: 'task-retry',
              status: 'running',
            },
          },
          { ...unknownTask, id: 'task-2' },
          workflowTask('task-3', 'succeeded'),
        ]}
      />,
    );
    expect(screen.getAllByRole('status', { name: '图片生成中' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '重新生成第 1 张图片' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新生成第 2 张图片' })).toBeTruthy();
    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(1);
  });

  it('keeps each failed slot retryable even when another output is in content review', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{ ...snapshot(), user_status: 'thinking', workflow_run_id: 'workflow-a' }}
        workflowReviewState="content_review"
        workflowTasks={[
          { ...workflowTask('task-1', 'failed'), retryable: true },
          workflowTask('task-2', 'running'),
          workflowTask('task-3', 'succeeded'),
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: '重新生成第 1 张图片' })).toBeTruthy();
    expect(screen.getAllByRole('status', { name: '图片生成中' })).toHaveLength(1);
    expect(screen.getAllByRole('status', { name: '图片结果复核中' })).toHaveLength(1);
  });

  it('keeps the independent-charge warning beside retry after unknown timeout', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{ ...snapshot(), user_status: 'failed', workflow_run_id: 'workflow-a' }}
        workflowTasks={[
          {
            ...workflowTask('task-1', 'failed'),
            retryable: true,
            latest_attempt: { id: 'attempt-1', attempt_no: 1, status: 'outcome_unknown' },
          },
        ]}
      />,
    );
    expect(screen.getByText(/重新生成会创建新的请求并独立计费/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新生成第 1 张图片' })).toBeTruthy();
    expect(screen.getByRole('status', { name: '第 1 张图片生成失败' }).textContent).toContain(
      '本次生成未完成',
    );
  });

  it('shows the 24-hour content review state and keeps completed artifacts visible', async () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{ ...snapshot(), user_status: 'thinking' }}
        workflowArtifacts={[workflowArtifact('task-1', 'artifact-reviewed', 0)]}
        workflowReviewState="content_review"
        workflowTasks={[workflowTask('task-1', 'succeeded', 2)]}
      />,
    );

    expect(await screen.findByRole('img', { name: '生成的图片' })).toBeTruthy();
    expect(screen.getByText('正在复核生成结果')).toBeTruthy();
    expect(screen.getByText(/平台将在 24 小时内完成处理/)).toBeTruthy();
    expect(screen.getByRole('status', { name: '图片结果复核中' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: '图片生成中' })).toBeNull();
  });

  it('keeps realtime artifacts visible until the completed message snapshot contains them', async () => {
    const artifact = workflowArtifact('task-1', 'artifact-terminal');
    const { rerender } = render(
      <Conversation
        {...baseProps()}
        snapshot={{ ...snapshot(), user_status: 'completed' }}
        workflowArtifacts={[artifact]}
        workflowTasks={[workflowTask('task-1', 'succeeded')]}
      />,
    );

    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(1);

    rerender(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'completed',
          messages: [
            {
              id: 'message-terminal',
              role: 'assistant',
              content: '已生成 1 张图片。',
              attachments: [
                {
                  resource_type: 'artifact',
                  resource_id: artifact.id,
                  role: 'other',
                  position: 0,
                },
              ],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
        workflowArtifacts={[artifact]}
        workflowTasks={[workflowTask('task-1', 'succeeded')]}
      />,
    );

    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(1);
  });

  it('collapses the thinking stream into a history chip after completion', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'completed',
          activities: [
            {
              activity_id: '33333333-3333-4333-8333-333333333333',
              activity_type: 'knowledge_loading',
              display_summary: '正在加载专业知识',
              status: 'succeeded',
              started_at: '2026-08-17T08:00:01.000Z',
              finished_at: '2026-08-17T08:00:04.000Z',
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole('region', { name: '创作过程' })).toBeTruthy();
    expect(screen.queryByText('正在加载专业知识')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开创作过程' }));
    expect(screen.getByText('正在加载专业知识')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起创作过程' }));
    expect(screen.queryByText('正在加载专业知识')).toBeNull();
  });

  it('renders generated artifact images with copy and download affordances', async () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'completed',
          messages: [
            {
              id: 'message-artifact',
              role: 'assistant' as const,
              content: '已生成 1 张图片。',
              attachments: [
                {
                  resource_type: 'artifact' as const,
                  resource_id: '77777777-7777-4777-8777-777777777777',
                  role: 'other' as const,
                  position: 0,
                },
              ],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
      />,
    );
    const image = await screen.findByRole('img', { name: '生成的图片' });
    expect(image.getAttribute('src')).toBe('https://signed.example/thumbnail');
    expect(screen.getByRole('button', { name: '下载原图' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制回复内容' })).toBeTruthy();

    const accessCalls = vi.mocked(artifactAccessUrl).mock.calls.length;
    fireEvent.error(image);
    expect(screen.queryByRole('img', { name: '生成的图片' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '图片加载失败，点击重试' }));
    expect(await screen.findByRole('img', { name: '生成的图片' })).toBeTruthy();
    expect(vi.mocked(artifactAccessUrl).mock.calls.length).toBe(accessCalls + 1);
  });

  it('shows the actual creation note attached to each generated image', async () => {
    const firstNote = '让山脊成为唯一视觉岛，用断续颗粒边缘把远景推入大片留白。';
    const secondNote = '把海岸压缩成低位剪影，以一处暖色亮点承担视线出口。';
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'completed',
          messages: [
            {
              id: 'message-artifacts-with-notes',
              role: 'assistant' as const,
              content: '已生成 2 张图片。',
              attachments: [
                {
                  resource_type: 'artifact' as const,
                  resource_id: '77777777-7777-4777-8777-777777777777',
                  role: 'other' as const,
                  position: 0,
                  creative_note: firstNote,
                },
                {
                  resource_type: 'artifact' as const,
                  resource_id: '88888888-8888-4888-8888-888888888888',
                  role: 'other' as const,
                  position: 1,
                  creative_note: secondNote,
                },
              ],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
      />,
    );

    expect(await screen.findAllByRole('img', { name: '生成的图片' })).toHaveLength(2);
    const noteButtons = screen.getAllByRole('button', { name: '查看创作笔记' });
    const imageGrid = noteButtons[0]!.closest('figure')?.parentElement;
    expect(imageGrid?.className).toContain('sm:grid-cols-3');
    expect(noteButtons).toHaveLength(2);
    expect(screen.queryByText(firstNote)).toBeNull();
    expect(screen.queryByText(secondNote)).toBeNull();

    fireEvent.click(noteButtons[0]!);
    expect(screen.getByText(firstNote)).toBeTruthy();
    expect(screen.queryByText(secondNote)).toBeNull();

    fireEvent.pointerDown(screen.getAllByRole('img', { name: '生成的图片' })[0]!);
    expect(screen.queryByText(firstNote)).toBeNull();

    fireEvent.click(noteButtons[0]!);
    expect(screen.getByText(firstNote)).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(firstNote)).toBeNull();

    fireEvent.click(noteButtons[1]!);
    expect(screen.getByText(secondNote)).toBeTruthy();

    expect(noteButtons[0]!.className).toContain('!text-white');
    expect(screen.getAllByRole('button', { name: '下载原图' })[0]!.className).toContain(
      '!text-white',
    );
  });

  it('copies an assistant reply to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'completed',
          messages: [
            {
              id: 'message-copy',
              role: 'assistant' as const,
              content: '你好！请告诉我你想创作的画面。',
              attachments: [],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '复制回复内容' }));
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('你好！请告诉我你想创作的画面。'),
    );
  });

  it('composes the refunded failure message when the retry settled successfully', async () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'failed',
          workflow_run_id: 'workflow-a',
          failure_summary: '生成服务未能返回可确认的结果。',
          messages: [
            {
              id: 'message-user',
              role: 'user',
              content: '生成一张',
              attachments: [],
              created_at: '2026-08-17T08:00:00.000Z',
            },
            {
              id: 'message-outcome',
              role: 'assistant',
              content: '图片生成失败，本次冻结的积分已全额退回。',
              attachments: [],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
        workflowTasks={[
          {
            ...workflowTask('task-a', 'failed'),
            latest_retry: { workflow_run_id: 'workflow-b', task_id: 'task-b', status: 'succeeded' },
          },
        ]}
        retrySnapshots={{
          'workflow-a': failedWorkflowSnapshot('workflow-a', [
            {
              ...workflowTask('task-a', 'failed'),
              latest_retry: {
                workflow_run_id: 'workflow-b',
                task_id: 'task-b',
                status: 'succeeded',
              },
            },
          ]),
          'workflow-b': workflowSnapshotFixture('workflow-b', 'succeeded', [
            workflowTask('task-b', 'succeeded'),
          ]),
        }}
      />,
    );

    expect(await screen.findByRole('img', { name: '生成的图片' })).toBeTruthy();
    expect(screen.queryByText('图片生成失败，本次冻结的积分已全额退回。')).toBeNull();
    expect(
      screen.getByText('首次生成未成功，相关积分将自动退回；重试已成功生成图片。'),
    ).toBeTruthy();
    expect(screen.getByText('首次生成未成功，重试已成功')).toBeTruthy();
  });

  it('annotates a failed turn while its retry is still running', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'failed',
          workflow_run_id: 'workflow-a',
          failure_summary: '生成服务未能返回可确认的结果。',
          messages: [
            {
              id: 'message-outcome',
              role: 'assistant',
              content: '图片生成失败，本次冻结的积分已全额退回。',
              attachments: [],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
        workflowTasks={[
          {
            ...workflowTask('task-a', 'failed'),
            latest_retry: { workflow_run_id: 'workflow-b', task_id: 'task-b', status: 'running' },
          },
        ]}
        retrySnapshots={{
          'workflow-a': failedWorkflowSnapshot('workflow-a', [
            {
              ...workflowTask('task-a', 'failed'),
              latest_retry: {
                workflow_run_id: 'workflow-b',
                task_id: 'task-b',
                status: 'running',
              },
            },
          ]),
        }}
      />,
    );

    expect(screen.getByText('图片生成失败，本次冻结的积分已全额退回。')).toBeTruthy();
    expect(screen.getByText('正在重试生成图片…')).toBeTruthy();
    expect(screen.getByText('首次生成未成功，正在重试')).toBeTruthy();
  });

  it('annotates a failed turn whose retry also failed', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'failed',
          workflow_run_id: 'workflow-a',
          failure_summary: '生成服务未能返回可确认的结果。',
          messages: [
            {
              id: 'message-outcome',
              role: 'assistant',
              content: '图片生成失败，本次冻结的积分已全额退回。',
              attachments: [],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
        workflowTasks={[
          {
            ...workflowTask('task-a', 'failed'),
            latest_retry: { workflow_run_id: 'workflow-b', task_id: 'task-b', status: 'failed' },
          },
        ]}
        retrySnapshots={{
          'workflow-a': failedWorkflowSnapshot('workflow-a', [
            {
              ...workflowTask('task-a', 'failed'),
              latest_retry: {
                workflow_run_id: 'workflow-b',
                task_id: 'task-b',
                status: 'failed',
              },
            },
          ]),
          'workflow-b': workflowSnapshotFixture('workflow-b', 'failed', [
            workflowTask('task-b', 'failed'),
          ]),
        }}
      />,
    );

    expect(screen.getByText('图片生成失败，本次冻结的积分已全额退回。')).toBeTruthy();
    expect(screen.getByText('重试也未成功。')).toBeTruthy();
    expect(screen.getByText('首次生成未成功，重试也未成功')).toBeTruthy();
  });

  it('leaves failed turns without retry chain information untouched', () => {
    render(
      <Conversation
        {...baseProps()}
        snapshot={{
          ...snapshot(),
          user_status: 'failed',
          workflow_run_id: 'workflow-a',
          failure_summary: '生成服务未能返回可确认的结果。',
          messages: [
            {
              id: 'message-outcome',
              role: 'assistant',
              content: '图片生成失败，本次冻结的积分已全额退回。',
              attachments: [],
              created_at: '2026-08-17T08:00:02.000Z',
            },
          ],
        }}
        workflowTasks={[workflowTask('task-a', 'failed')]}
      />,
    );

    expect(screen.getByText('图片生成失败，本次冻结的积分已全额退回。')).toBeTruthy();
    expect(screen.queryByText('重试已成功生成图片。')).toBeNull();
    expect(screen.queryByText(/首次生成未成功/)).toBeNull();
    expect(screen.getByText('生成服务未能返回可确认的结果。')).toBeTruthy();
  });
});

function baseProps(): ConversationProps {
  return {
    actionPending: false,
    hasPendingComposerImages: false,
    backgroundWorkflows: [],
    error: '',
    loading: false,
    loadingOlder: false,
    onAddClarificationImage: vi.fn(),
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onInterrupt: vi.fn().mockResolvedValue(undefined),
    onLoadOlder: vi.fn().mockResolvedValue(undefined),
    onRetryImage: vi.fn().mockResolvedValue(undefined),
    realtimeStatus: 'live',
    retrySnapshots: {},
    session: null,
    snapshot: null,
    workflowArtifacts: [],
    workflowReviewState: null,
    workflowTasks: [],
  };
}

function clarificationSnapshot(): TurnSnapshot {
  return {
    ...snapshot(),
    pending_confirmation: {
      id: 'confirmation-a',
      type: 'clarification',
      version: 1,
      public_payload: {
        question: '更偏产品还是氛围？',
        options: [
          { id: 'product', label: '产品展示' },
          { id: 'mood', label: '氛围传播' },
        ],
      },
      expires_at: '2026-08-17T08:30:00.000Z',
    },
  };
}

function productFactsSnapshot(): TurnSnapshot {
  return {
    ...snapshot(),
    pending_confirmation: {
      id: 'd73f7787-243d-4606-a106-fb01e3e54cc7',
      type: 'product_facts',
      version: 1,
      public_payload: {
        schema_version: 1,
        mode: 'create_product',
        source_asset_id: '38dbf061-dc97-4e5f-93b4-6dab7dd76d1d',
        source_version: 'a'.repeat(64),
        candidate_facts: {
          product_name: '白色水杯',
          primary_colors: ['白色'],
          logos: [],
          visible_text: [],
          materials: [],
          must_preserve: ['杯盖', '杯身比例'],
          unknown_fields: ['材质'],
        },
        required_fields: ['product_name', 'visible_text'],
      },
      expires_at: '2026-08-17T08:30:00.000Z',
    },
  };
}

function snapshot(): TurnSnapshot {
  return {
    id: 'turn-a',
    session_id: 'session-a',
    user_status: 'waiting_for_you',
    revision: 1,
    continuation_no: 1,
    agent_trace_id: 'trace-a',
    skill_selection: {
      primary_skill_id: 'skill-a',
      primary_name: '创意海报',
      preset_selections: [],
    },
    model_selection: null,
    generation_preferences: null,
    execution_authorization: null,
    loaded_auxiliary_skills: [],
    run_quote_id: null,
    workflow_run_id: null,
    pending_confirmation: null,
    messages: [],
    last_event_seq: 1,
    created_at: '2026-08-17T08:00:00.000Z',
    ended_at: null,
    activities: [],
  };
}

function textEvent(
  sequence: number,
  type: TurnRealtimeEvent['event_type'],
  payload: Record<string, unknown>,
): TurnRealtimeEvent {
  return {
    schema_version: 1,
    scope: 'turn:turn-a',
    event_seq: sequence,
    event_type: type,
    occurred_at: '2026-08-17T08:00:01.000Z',
    payload: { turn_id: 'turn-a', agent_trace_id: 'trace-a', ...payload },
  };
}

function workflowArtifact(taskId: string, artifactId: string, outputIndex = 0) {
  return {
    id: artifactId,
    task_id: taskId,
    type: 'image',
    visibility: 'private' as const,
    publication_revision: 1,
    output_index: outputIndex,
    created_at: '2026-08-17T08:00:01.000Z',
  };
}

function workflowTask(id: string, status: string, outputCount = 1) {
  return {
    id,
    type: 'image.generate',
    status,
    error_code: status === 'failed' ? 'IMAGE_OUTPUT_RECOVERY_UNKNOWN' : null,
    output_count: outputCount,
    created_at: '2026-08-17T08:00:00.000Z',
    started_at: '2026-08-17T08:00:00.000Z',
    ended_at: status === 'failed' || status === 'succeeded' ? '2026-08-17T08:00:01.000Z' : null,
    latest_attempt: null,
  };
}

function failedWorkflowSnapshot(workflowRunId: string, tasks: WorkflowSnapshot['tasks']) {
  return workflowSnapshotFixture(workflowRunId, 'failed', tasks);
}

function workflowSnapshotFixture(
  workflowRunId: string,
  status: string,
  tasks: WorkflowSnapshot['tasks'],
): WorkflowSnapshot {
  return {
    workflow_run: {
      id: workflowRunId,
      status,
      trigger_mode: 'agent',
      created_at: '2026-08-17T08:00:00.000Z',
      finished_at: null,
    },
    tasks,
    last_event_seq: 1,
    credit_summary: null,
    artifacts: [
      {
        id: 'artifact-b',
        task_id: 'task-b',
        type: 'image',
        visibility: 'private' as const,
        publication_revision: 1,
        output_index: 0,
        created_at: '2026-08-17T08:00:03.000Z',
      },
    ],
  };
}
function publicTurn(id: string, workflowRunId: string, createdAt: string) {
  return {
    id,
    session_id: 'session-a',
    user_status: 'completed' as const,
    revision: 1,
    continuation_no: 1,
    agent_trace_id: 'trace-a',
    skill_selection: null,
    model_selection: null,
    generation_preferences: null,
    execution_authorization: null,
    run_quote_id: null,
    workflow_run_id: workflowRunId,
    pending_confirmation: null,
    last_event_seq: 1,
    created_at: createdAt,
    ended_at: createdAt,
  };
}
