import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposerProps } from './composer';
import type { AgentCatalogState } from './use-agent-catalogs';
import {
  AgentApiError,
  type CreateTurnInput,
  type PublicTurn,
  type SessionDetail,
  type SessionPreview,
} from '@/lib/agent-api';
import { readPrototypeSession, writePrototypeSession } from '@/lib/prototype-session';

import { AgentWorkbench } from './workbench';

const runtime = vi.hoisted(() => ({
  catalogs: null as (AgentCatalogState & { reload: () => void }) | null,
  pathname: '/workspace/session/a',
  session: null as SessionDetail | null,
  push: vi.fn(),
  archive: vi.fn<() => Promise<void>>(),
  submit: vi.fn<(input: CreateTurnInput) => Promise<{ session_id: string; turn_id: string }>>(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => runtime.pathname,
  useRouter: () => ({ push: runtime.push, replace: vi.fn() }),
}));
vi.mock('@/lib/auth-api', () => ({
  getCurrentUser: () =>
    Promise.resolve({
      access: { can_create: true },
      user: { id: 'user-a', display_name: 'Test user', email_verified: true },
    }),
  getCreditAccount: () => Promise.resolve({ balance: '100' }),
}));
vi.mock('./use-agent-catalogs', () => ({ useAgentCatalogs: () => runtime.catalogs }));
vi.mock('./use-agent-sessions', () => ({
  useAgentSessions: () => ({ items: [], reload: vi.fn(), archive: runtime.archive }),
}));
vi.mock('./use-agent-conversation', () => ({
  useAgentConversation: () => ({
    session: runtime.session,
    snapshot: null,
    submit: runtime.submit,
    submitting: false,
  }),
}));
vi.mock('@/features/realtime/use-workflow-realtime', () => ({
  useWorkflowRealtimeCollection: () => ({ snapshots: {} }),
}));
vi.mock('@/components/layout/app-shell', () => ({
  AppShell: ({
    children,
    secondaryNavigation,
  }: {
    children: ReactNode;
    secondaryNavigation?: ReactNode;
  }) => (
    <>
      {secondaryNavigation}
      {children}
    </>
  ),
}));
vi.mock('./auth-dialog', () => ({ AuthDialog: () => null }));
vi.mock('./attachment-picker-dialog', () => ({ AttachmentPickerDialog: () => null }));
vi.mock('./session-history', () => ({
  SessionSidebar: ({ onArchive }: { onArchive: (session: SessionPreview) => Promise<void> }) => (
    <button
      onClick={() =>
        void onArchive({
          id: 'a',
          title: 'Session A',
          revision: 1,
          updated_at: '2026-10-10T00:00:00.000Z',
          last_message_preview: '',
          last_turn_id: null,
          last_turn_status: null,
        })
      }
    >
      Archive A
    </button>
  ),
  SessionHistory: () => null,
}));
vi.mock('./workbench-content', async () => {
  const { Composer } = await import('./composer');
  return {
    WorkbenchContent: ({ composerProps }: { composerProps: ComposerProps }) => (
      <>
        <Composer {...composerProps} />
        <output data-testid="models">
          {JSON.stringify({
            brain: composerProps.value.selectedBrainModelId,
            image: composerProps.value.selectedImageModelId,
          })}
        </output>
        <button onClick={() => composerProps.onChange({ selectedBrainModelId: 'brain-b' })}>
          Choose brain B
        </button>
        <button onClick={() => composerProps.onChange({ selectedImageModelId: 'image-b' })}>
          Choose image B
        </button>
      </>
    ),
  };
});

afterEach(cleanup);

describe('AgentWorkbench session model selection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.clearAllMocks();
    runtime.pathname = '/workspace/session/a';
    runtime.catalogs = catalogs();
    runtime.session = session('a');
    runtime.archive.mockResolvedValue(undefined);
    runtime.submit.mockImplementation((input: CreateTurnInput) =>
      Promise.resolve({
        session_id: input.session_id ?? 'created',
        turn_id: 'created-turn',
      }),
    );
  });

  it('restores A/B independently, preserves a manual draft, and sends that session selection', async () => {
    writePrototypeSession(
      { selectedBrainModelId: 'brain-b', selectedImageModelId: 'image-b' },
      null,
      'user-a',
    );
    const { rerender } = render(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    await submitMessage();
    expect(runtime.submit.mock.lastCall?.[0]).toMatchObject({
      session_id: 'a',
      model_selection: {
        brain: { catalog_entry_id: 'brain-a' },
        image: { catalog_entry_id: 'image-a' },
      },
    });

    runtime.pathname = '/workspace/session/b';
    // The previous session detail must not be used while B is loading.
    rerender(<AgentWorkbench view="session" />);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' }).disabled).toBe(
      true,
    );
    expect(readPrototypeSession('b', 'user-a').selectedBrainModelId).toBeNull();
    runtime.session = session('b');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('b', 'b');

    runtime.pathname = '/workspace/session/a';
    runtime.session = session('a');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    fireEvent.click(screen.getByRole('button', { name: 'Choose brain B' }));
    await expectModels('b', 'a');

    // Paging, reconnection and SSE all refresh detail without resetting the input choice.
    runtime.session = { ...session('a'), turns: [turn('b'), turn('a')] };
    rerender(<AgentWorkbench view="session" />);
    await expectModels('b', 'a');
    runtime.pathname = '/workspace/session/b';
    runtime.session = session('b');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('b', 'b');
    runtime.pathname = '/workspace/session/a';
    runtime.session = session('a');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('b', 'a');
    await submitMessage();
    expect(runtime.submit.mock.lastCall?.[0]).toMatchObject({
      session_id: 'a',
      model_selection: {
        brain: { catalog_entry_id: 'brain-b', version_no: 1 },
        image: { catalog_entry_id: 'image-a' },
      },
    });
  });

  it('locks the submitted designer and preserves exact historical version across sessions', async () => {
    runtime.session!.turns[0]!.generation_preferences = {
      creative_direction: { mode: 'profile', profile_id: 'visual-metaphor', version: 1 },
    };
    const pinnedSession = runtime.session;
    const { rerender } = render(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    expect(screen.getByRole('button', { name: '设计师：视觉隐喻' })).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: '设计师：视觉隐喻' }).disabled,
    ).toBe(true);
    await submitMessage();
    expect(runtime.submit.mock.lastCall?.[0].generation_preferences.creative_direction).toEqual({
      mode: 'profile',
      profile_id: 'visual-metaphor',
      version: 1,
    });
    runtime.pathname = '/workspace/session/b';
    runtime.session = session('b');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('b', 'b');
    expect(screen.getByRole('button', { name: '设计师：Skill 原生' })).toBeDefined();
    runtime.pathname = '/workspace/session/a';
    runtime.session = pinnedSession;
    rerender(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    expect(screen.getByRole('button', { name: '设计师：视觉隐喻' })).toBeDefined();
    expect(readPrototypeSession('b', 'user-a').creativeDirection).toEqual({ mode: 'native' });
  });

  it('uses the server selection instead of a corrupt cached designer', async () => {
    writePrototypeSession({ creativeDirection: null }, 'a', 'user-a');
    render(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    expect(screen.queryByText('设计师选择已失效，请重新选择')).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: '设计师：Skill 原生' }).disabled,
    ).toBe(true);
    await submitMessage();
    expect(runtime.submit.mock.lastCall?.[0].generation_preferences.creative_direction).toEqual({
      mode: 'native',
    });
  });

  it('does not carry a new-session model into history or overwrite history on refresh', async () => {
    runtime.pathname = '/workspace/session/new';
    runtime.session = null;
    const { rerender, unmount } = render(<AgentWorkbench view="session-new" />);
    await expectModels('a', 'a');
    fireEvent.click(screen.getByRole('button', { name: 'Choose brain B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose image B' }));
    await expectModels('b', 'b');
    runtime.pathname = '/workspace/session/a';
    runtime.session = session('a');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    unmount();
    render(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
  });

  it('blocks submission while catalogs or session details are unavailable', async () => {
    runtime.session = null;
    runtime.catalogs = { ...catalogs(), status: 'error' };
    const { rerender } = render(<AgentWorkbench view="session" />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '创作输入' })).toBeDefined());
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' }).disabled).toBe(
      true,
    );
    runtime.catalogs = catalogs();
    rerender(<AgentWorkbench view="session" />);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' }).disabled).toBe(
      true,
    );
    expect(runtime.submit).not.toHaveBeenCalled();
    runtime.session = session('a');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' }).disabled).toBe(
      false,
    );
  });

  it('retains an invalid version on refresh until the user explicitly reselects', async () => {
    runtime.catalogs!.brainModels!.items[0]!.version_no = 2;
    const { unmount } = render(<AgentWorkbench view="session" />);
    await waitFor(() => expect(screen.getByText(/原选模型已不可用或版本已变更/)).toBeDefined());
    fireEvent.change(screen.getByRole('textbox', { name: '创作输入' }), {
      target: { value: 'Test brief' },
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(true);
    unmount();
    render(<AgentWorkbench view="session" />);
    await waitFor(() => expect(screen.getByText(/原选模型已不可用或版本已变更/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Choose brain B' }));
    await submitMessage();
    expect(runtime.submit).toHaveBeenCalledOnce();
    expect(runtime.submit.mock.lastCall?.[0].model_selection.brain.catalog_entry_id).toBe(
      'brain-b',
    );
  });

  it('does not navigate away when an archived session finishes after switching', async () => {
    const pending = Promise.withResolvers<void>();
    runtime.archive.mockReturnValue(pending.promise);
    const { rerender } = render(<AgentWorkbench view="session" />);
    await expectModels('a', 'a');
    fireEvent.click(screen.getByRole('button', { name: 'Archive A' }));
    expect(runtime.archive).toHaveBeenCalledOnce();
    runtime.pathname = '/workspace/session/b';
    runtime.session = session('b');
    rerender(<AgentWorkbench view="session" />);
    await expectModels('b', 'b');
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(runtime.push).not.toHaveBeenCalled();
  });

  it.each(['success', 'model-error'] as const)(
    'ignores a late %s from another session without changing the current draft or models',
    async (outcome) => {
      const pending = Promise.withResolvers<{ session_id: string; turn_id: string }>();
      runtime.submit.mockReturnValue(pending.promise);
      const { rerender } = render(<AgentWorkbench view="session" />);
      await expectModels('a', 'a');
      await submitMessage();
      runtime.pathname = '/workspace/session/b';
      runtime.session = session('b');
      rerender(<AgentWorkbench view="session" />);
      await expectModels('b', 'b');
      fireEvent.change(screen.getByRole('textbox', { name: '创作输入' }), {
        target: { value: 'B unsent draft' },
      });
      await act(async () => {
        if (outcome === 'success') pending.resolve({ session_id: 'a', turn_id: 'created-turn' });
        else pending.reject(new AgentApiError('MODEL_CATALOG_STALE', 409, 'Old session error'));
        await pending.promise.catch(() => undefined);
      });
      await expectModels('b', 'b');
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' }).value).toBe(
        'B unsent draft',
      );
      expect(screen.queryByText('Old session error')).toBeNull();
      expect(readPrototypeSession('b', 'user-a').selectedBrainModelId).toBe('brain-b');
    },
  );
});

async function expectModels(brain: string, image: string) {
  await waitFor(() =>
    expect(screen.getByTestId('models').textContent).toBe(
      JSON.stringify({ brain: `brain-${brain}`, image: `image-${image}` }),
    ),
  );
}

async function submitMessage() {
  const calls = runtime.submit.mock.calls.length;
  fireEvent.change(screen.getByRole('textbox', { name: '创作输入' }), {
    target: { value: 'Test brief' },
  });
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
  await waitFor(() => expect(runtime.submit).toHaveBeenCalledTimes(calls + 1));
}

function catalogs(): AgentCatalogState & { reload: () => void } {
  const model = (suffix: string, category: 'brain' | 'image') => ({
    id: `${category}-${suffix}`,
    public_slug: `${category}-${suffix}`,
    category,
    version_no: 1,
    display_name: `${category} ${suffix}`,
    description: '',
    public_capabilities: {},
    user_selectable: true,
    is_default: suffix === 'a',
    availability: 'available' as const,
    pricing_summary: [],
  });
  return {
    status: 'ready',
    error: '',
    reload: vi.fn(),
    brainModels: { catalog_revision: 7, items: [model('a', 'brain'), model('b', 'brain')] },
    imageModels: { catalog_revision: 7, items: [model('a', 'image'), model('b', 'image')] },
    videoModels: { catalog_revision: 7, items: [] },
    skills: {
      catalog_version: 'test-v1',
      response_version: '1',
      generation_policy: { schema_version: 2, policy_version: 'test-v1' },
      items: [
        {
          primary_skill_id: 'creative-poster@1.0.0',
          slug: 'creative-poster',
          version: '1.0.0',
          name: 'Test poster',
          description: '',
          domain: 'creative',
          category: 'social-content',
          required_inputs: [],
          preset_slots: [],
        },
      ],
    },
  };
}

function session(id: string): SessionDetail {
  return {
    session: {
      id,
      title: id,
      revision: 1,
      primary_skill_slug: 'creative-poster',
      preset_selections: [],
      created_at: '2026-10-03T00:00:00Z',
      updated_at: '2026-10-03T00:00:00Z',
    },
    turns: [turn(id)],
    messages: [],
    older_cursor: null,
    active_turn_id: null,
  };
}

function turn(id: string): PublicTurn {
  return {
    id: `turn-${id}`,
    session_id: id,
    user_status: 'completed',
    revision: 1,
    continuation_no: 1,
    agent_trace_id: null,
    skill_selection: null,
    generation_preferences: null,
    execution_authorization: null,
    model_selection: {
      catalog_revision: 7,
      brain: { catalog_entry_id: `brain-${id}`, version_no: 1, display_name: id },
      image: { catalog_entry_id: `image-${id}`, version_no: 1, display_name: id },
    },
    run_quote_id: null,
    workflow_run_id: null,
    pending_confirmation: null,
    created_at: '2026-10-03T00:00:00Z',
    ended_at: '2026-10-03T00:00:01Z',
    last_event_seq: 1,
  };
}
