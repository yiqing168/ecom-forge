import type { Route } from '@playwright/test';

export const agentMockIds = {
  brainModel: '41000000-0000-4000-8000-000000000001',
  confirmation: '61000000-0000-4000-8000-000000000001',
  imageModel: '42000000-0000-4000-8000-000000000001',
  preset: '51000000-0000-4000-8000-000000000001',
  session: '11000000-0000-4000-8000-000000000001',
  skill: '40000000-0000-4000-8000-000000000001',
  trace: '31000000-0000-4000-8000-000000000001',
  turn: '21000000-0000-4000-8000-000000000001',
  userMessage: '71000000-0000-4000-8000-000000000001',
  assistantMessage: '72000000-0000-4000-8000-000000000001',
  quote: '62000000-0000-4000-8000-000000000001',
  workflowRun: '63000000-0000-4000-8000-000000000001',
} as const;

const now = '2026-08-17T08:00:00.000Z';

type TurnMode =
  | 'completed'
  | 'clarification'
  | 'reconnect'
  | 'thinking'
  | 'stopped'
  | 'markdown'
  | 'brain_failure'
  | 'failed';

export const brainFailureSummary =
  '推理模型请求过于频繁，本轮已停止；请稍后重新发送，或更换推理模型';

export const markdownReply =
  '## 海报方向\n\n保留照片的真实光线，让**人物与远山**成为画面重点。\n\n1. **编辑杂志感**：克制留白与清晰层级。\n2. **线条实验**：沿人物视线展开。\n\n> 可以继续调整方向，也可以直接生成。\n\n| 方向 | 构图 | 色彩 | 文字 |\n| --- | --- | --- | --- |\n| 编辑杂志 | 大幅留白 | 从原图提取 | 两级标题 |\n\n```text\n' +
  'composition_reference '.repeat(18) +
  '\n```';

export function createAgentApiMock() {
  let archived = false;
  let eventSeq = 1;
  let realtimeConnections = 0;
  let mode: TurnMode = 'completed';
  let revision = 1;
  let generationPreferences: Record<string, unknown> | undefined;
  let title = '秋季上新海报';
  let userMessage = '给我一个秋季上新海报方向';
  let assistantMessage = '我会先整理视觉方向；正式生图将在图片执行管线启用后进行。';
  let markdownDraft: string | null = null;
  let markdownRun = false;
  const markdownStartedAt = new Date().toISOString();
  const commentaryId = '72000000-0000-4000-8000-000000000002';
  const commentary = '我先查看照片中的人物与远山，再整理适合这张照片的海报方向。';
  const markdownActivity = {
    activity_id: '71000000-0000-4000-8000-000000000001',
    activity_type: 'context_reading',
    display_summary: '正在分析参考图片',
  };

  return async (route: Route): Promise<boolean> => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/v1/skills' && request.method() === 'GET') {
      await json(route, {
        data: {
          catalog_version: 's11-e2e-v1',
          response_version: '1',
          generation_policy: {
            schema_version: 2,
            policy_version: 's11-e2e-policy-v1',
          },
          items: [
            {
              primary_skill_id: agentMockIds.skill,
              slug: 'creative-poster',
              version: '1.0.0',
              name: '创意海报',
              description: '为社交传播场景组织画面方向与文案层级',
              domain: 'creative',
              category: 'social-content',
              required_inputs: [],
              preset_slots: [
                {
                  slot: 'style',
                  label: '视觉风格',
                  required: true,
                  max_selections: 1,
                  options: [
                    {
                      preset_id: agentMockIds.preset,
                      name: '清透杂志感',
                      description: '克制留白、自然光线与清晰内容层级',
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      return true;
    }

    if (path === '/api/v1/model-catalog' && request.method() === 'GET') {
      const category = url.searchParams.get('category');
      const item =
        category === 'brain'
          ? model(agentMockIds.brainModel, 'brain', '创作推理模型')
          : category === 'image'
            ? model(agentMockIds.imageModel, 'image', '高清图片模型')
            : null;
      await json(route, { catalog_revision: 7, items: item ? [item] : [] });
      return true;
    }

    if (path === '/api/v1/agent/sessions' && request.method() === 'GET') {
      const query = url.searchParams.get('query')?.normalize('NFKC').trim().toLowerCase() ?? '';
      const item = sessionPreview();
      await json(route, {
        data: {
          items: !archived && (!query || title.toLowerCase().includes(query)) ? [item] : [],
          next_cursor: null,
        },
      });
      return true;
    }

    if (path === '/api/v1/agent/turns' && request.method() === 'POST') {
      const payload = request.postDataJSON() as {
        message?: string;
        generation_preferences?: Record<string, unknown>;
      };
      generationPreferences = payload.generation_preferences;
      userMessage = payload.message?.trim() || '新的创作请求';
      title = userMessage.slice(0, 40);
      archived = false;
      revision += 1;
      if (userMessage.includes('[brain-failure]')) {
        mode = 'brain_failure';
        eventSeq = 1;
        assistantMessage = '';
      } else if (userMessage.includes('[markdown]')) {
        mode = 'markdown';
        markdownRun = true;
        eventSeq = 1;
        assistantMessage = '';
        markdownDraft = null;
      } else if (userMessage.includes('[clarify]')) {
        mode = 'clarification';
        eventSeq = 1;
        assistantMessage = '';
      } else if (userMessage.includes('[reconnect]')) {
        mode = 'reconnect';
        eventSeq = 1;
        realtimeConnections = 0;
        assistantMessage = '';
      } else if (userMessage.includes('[thinking]')) {
        mode = 'thinking';
        eventSeq = 1;
        assistantMessage = '';
      } else {
        mode = 'completed';
        eventSeq = 2;
        assistantMessage = '方向已经整理完成；正式生图将在图片执行管线启用后进行。';
      }
      await json(
        route,
        {
          data: {
            session_id: agentMockIds.session,
            turn_id: agentMockIds.turn,
            user_message_id: agentMockIds.userMessage,
            agent_trace_id: agentMockIds.trace,
            user_status: 'thinking',
            revision,
            continuation_no: 1,
            event_scope: `turn:${agentMockIds.turn}`,
            last_event_seq: 1,
          },
        },
        201,
      );
      return true;
    }

    if (
      path === `/api/v1/agent/turns/${agentMockIds.turn}/confirm` &&
      request.method() === 'POST'
    ) {
      mode = 'completed';
      eventSeq = 2;
      revision += 1;
      assistantMessage = '收到补充信息，我会按清透杂志感继续整理创意方向。';
      await json(route, { data: { status: 'accepted' } }, 202);
      return true;
    }

    if (
      path === `/api/v1/agent/turns/${agentMockIds.turn}/interrupt` &&
      request.method() === 'POST'
    ) {
      mode = 'stopped';
      eventSeq = 2;
      revision += 1;
      await json(route, { data: { status: 'stopped' } }, 202);
      return true;
    }

    if (path === `/api/v1/agent/turns/${agentMockIds.turn}` && request.method() === 'GET') {
      await json(route, { ok: true, data: turnSnapshot() });
      return true;
    }

    if (path === `/api/v1/agent/sessions/${agentMockIds.session}` && request.method() === 'GET') {
      await json(route, { data: sessionDetail() });
      return true;
    }

    if (path === `/api/v1/agent/sessions/${agentMockIds.session}` && request.method() === 'PATCH') {
      const payload = request.postDataJSON() as { title?: string };
      title = payload.title?.normalize('NFKC').trim() || title;
      revision += 1;
      await json(route, {
        data: { id: agentMockIds.session, title, revision, updated_at: now },
      });
      return true;
    }

    if (
      path === `/api/v1/agent/sessions/${agentMockIds.session}/archive` &&
      request.method() === 'POST'
    ) {
      archived = true;
      revision += 1;
      await json(route, {
        data: { id: agentMockIds.session, revision, archived_at: now },
      });
      return true;
    }

    if (path === '/api/v1/events' && request.method() === 'GET') {
      const scope = url.searchParams.get('scope');
      const cursor = Number(url.searchParams.get('last_event_seq') ?? 0);
      realtimeConnections += 1;
      if (mode === 'brain_failure') {
        mode = 'failed';
        eventSeq = 2;
        const eventType = 'turn.failed';
        await route.fulfill({
          contentType: 'text/event-stream',
          body: `id: 2\nevent: ${eventType}\ndata: ${JSON.stringify({
            schema_version: 1,
            scope,
            event_seq: 2,
            event_type: eventType,
            occurred_at: now,
            payload: {
              turn_id: agentMockIds.turn,
              agent_trace_id: agentMockIds.trace,
              public_error_code: 'AGENT_MODEL_UNAVAILABLE',
              summary: brainFailureSummary,
              user_status: 'failed',
            },
          })}\n\n`,
        });
        return true;
      }
      if (mode === 'markdown') {
        const event = (seq: number, type: string, payload: Record<string, unknown>) =>
          `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ schema_version: 1, scope, event_seq: seq, event_type: type, occurred_at: markdownStartedAt, payload: { turn_id: agentMockIds.turn, agent_trace_id: agentMockIds.trace, ...payload } })}\n\n`;
        if (cursor < 3) {
          markdownDraft = '## 海报方向\n\n保留照片的真实光线';
          eventSeq = 3;
          await route.fulfill({
            contentType: 'text/event-stream',
            body:
              event(2, 'turn.activity_started', { ...markdownActivity, status: 'started' }) +
              event(3, 'turn.response_draft_delta', {
                step_id: agentMockIds.trace,
                draft_seq: 1,
                text_delta: markdownDraft,
              }),
          });
        } else {
          // Give the browser a visible intermediate frame before the terminal event.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          mode = 'completed';
          assistantMessage = markdownReply;
          markdownDraft = null;
          eventSeq = 7;
          await route.fulfill({
            contentType: 'text/event-stream',
            body:
              event(4, 'turn.message_delta', {
                message_id: commentaryId,
                delta_seq: 1,
                is_final: true,
                text_delta: commentary,
              }) +
              event(5, 'turn.activity_finished', { ...markdownActivity, status: 'succeeded' }) +
              event(6, 'turn.message_delta', {
                message_id: agentMockIds.assistantMessage,
                delta_seq: 1,
                is_final: true,
                text_delta: markdownReply,
              }) +
              event(7, 'turn.completed', {
                message_id: agentMockIds.assistantMessage,
                user_status: 'completed',
              }),
          });
        }
        return true;
      }
      if (mode === 'reconnect' && realtimeConnections === 1) {
        await route.fulfill({
          body: `event: heartbeat\ndata: ${JSON.stringify({ scope, last_event_seq: eventSeq })}\n\n`,
          contentType: 'text/event-stream',
          status: 200,
        });
        return true;
      }
      if (mode === 'reconnect' && realtimeConnections >= 2 && cursor === 1) {
        mode = 'completed';
        eventSeq = 2;
        assistantMessage = 'SSE_RECOVERED_ASSISTANT_MESSAGE';
      }
      if (cursor < eventSeq && (mode === 'completed' || mode === 'stopped')) {
        const eventType = mode === 'completed' ? 'turn.completed' : 'turn.cancelled';
        const payload = {
          turn_id: agentMockIds.turn,
          agent_trace_id: agentMockIds.trace,
          ...(mode === 'completed'
            ? { message_id: agentMockIds.assistantMessage, user_status: 'completed' }
            : { reason: 'user_requested', user_status: 'stopped' }),
        };
        await route.fulfill({
          body: `id: ${eventSeq}\nevent: ${eventType}\ndata: ${JSON.stringify({
            schema_version: 1,
            scope,
            event_seq: eventSeq,
            event_type: eventType,
            occurred_at: now,
            payload,
          })}\n\n`,
          contentType: 'text/event-stream',
          status: 200,
        });
        return true;
      }
      await route.fulfill({
        body: `event: heartbeat\ndata: ${JSON.stringify({ scope, last_event_seq: eventSeq })}\n\n`,
        contentType: 'text/event-stream',
        status: 200,
      });
      return true;
    }

    return false;
  };

  function sessionPreview() {
    return {
      id: agentMockIds.session,
      title,
      revision,
      last_message_preview: assistantMessage || userMessage,
      last_turn_id: agentMockIds.turn,
      last_turn_status: userStatus(),
      updated_at: now,
    };
  }

  function sessionDetail() {
    const snapshot = turnSnapshot();
    return {
      session: {
        id: agentMockIds.session,
        title,
        revision,
        primary_skill_slug: 'creative-poster',
        preset_selections: [{ slot: 'style', preset_id: agentMockIds.preset, name: '清透杂志感' }],
        creative_direction_snapshot: {
          schema_version: 1,
          selection: generationPreferences?.creative_direction ?? { mode: 'native' },
          ...(userMessage.includes('[designer-resolved]')
            ? {
                resolved_profile: {
                  mode: 'profile',
                  profile_id: 'material-experiment',
                  version: 2,
                },
                resolution_turn_id: agentMockIds.turn,
                resolution_step_id: agentMockIds.trace,
              }
            : {}),
        },
        created_at: now,
        updated_at: now,
      },
      messages: snapshot.messages,
      turns: [snapshot],
      active_turn_id:
        mode === 'thinking' ||
        mode === 'clarification' ||
        mode === 'markdown' ||
        mode === 'brain_failure'
          ? agentMockIds.turn
          : null,
      older_cursor: null,
    };
  }

  function turnSnapshot() {
    const status = userStatus();
    return {
      id: agentMockIds.turn,
      session_id: agentMockIds.session,
      user_status: status,
      revision,
      continuation_no: 1,
      agent_trace_id: agentMockIds.trace,
      skill_selection: {
        primary_skill_id: agentMockIds.skill,
        primary_name: '创意海报',
        preset_selections: [{ slot: 'style', preset_id: agentMockIds.preset, name: '清透杂志感' }],
      },
      model_selection: {
        catalog_revision: 7,
        brain: {
          catalog_entry_id: agentMockIds.brainModel,
          version_no: 1,
          display_name: '创作推理模型',
        },
        image: {
          catalog_entry_id: agentMockIds.imageModel,
          version_no: 1,
          display_name: '高清图片模型',
        },
      },
      generation_preferences: {
        schema_version: 2,
        output_kind: 'image',
        aspect_ratio: '1:1',
        resolution_tier: '1k',
        ...generationPreferences,
      },
      execution_authorization: {
        kind: 'generate_action',
      },
      loaded_auxiliary_skills: [],
      run_quote_id: null,
      workflow_run_id: null,
      ...(mode === 'failed' ? { failure_summary: brainFailureSummary } : {}),
      pending_confirmation:
        mode === 'clarification'
          ? {
              id: agentMockIds.confirmation,
              type: 'clarification',
              version: 1,
              public_payload: {
                schema_version: 1,
                question: '这张海报更偏产品展示还是氛围传播？',
                options: [
                  { id: 'product', label: '产品展示' },
                  { id: 'mood', label: '氛围传播' },
                ],
                allow_free_text: true,
                max_response_chars: 500,
              },
              expires_at: '2026-08-17T08:30:00.000Z',
            }
          : null,
      messages: [
        {
          id: agentMockIds.userMessage,
          role: 'user',
          content: userMessage,
          attachments: [],
          created_at: now,
        },
        ...(markdownRun && mode === 'completed'
          ? [
              {
                id: commentaryId,
                role: 'assistant' as const,
                content: commentary,
                attachments: [],
                created_at: markdownStartedAt,
              },
            ]
          : []),
        ...(assistantMessage
          ? [
              {
                id: agentMockIds.assistantMessage,
                role: 'assistant' as const,
                content: assistantMessage,
                attachments: [],
                created_at: markdownRun ? new Date().toISOString() : '2026-08-17T08:00:01.000Z',
              },
            ]
          : []),
      ],
      activities:
        markdownRun && eventSeq >= 3
          ? [
              {
                ...markdownActivity,
                status: mode === 'completed' ? 'succeeded' : 'started',
              },
            ]
          : [],
      response_draft: markdownDraft
        ? { step_id: agentMockIds.trace, draft_seq: 1, text: markdownDraft }
        : null,
      last_event_seq: eventSeq,
      created_at: now,
      ended_at: status === 'completed' || status === 'stopped' || status === 'failed' ? now : null,
    };
  }

  function userStatus() {
    if (mode === 'failed') return 'failed' as const;
    if (mode === 'brain_failure') return 'thinking' as const;
    if (mode === 'clarification') return 'waiting_for_you' as const;
    if (mode === 'reconnect') return 'thinking' as const;
    if (mode === 'thinking') return 'thinking' as const;
    if (mode === 'markdown') return 'thinking' as const;
    if (mode === 'stopped') return 'stopped' as const;
    return 'completed' as const;
  }
}

function model(id: string, category: 'brain' | 'image', displayName: string) {
  return {
    id,
    public_slug: `s11-e2e-${category}`,
    version_no: 1,
    category,
    display_name: displayName,
    description: '测试环境已发布模型',
    public_capabilities: {},
    user_selectable: true,
    is_default: true,
    availability: 'available',
    pricing_summary: [],
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status,
  });
}
