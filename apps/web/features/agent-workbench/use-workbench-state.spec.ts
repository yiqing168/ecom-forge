import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCreditAccount, getCurrentUser } from '@/lib/auth-api';
import { readPrototypeSession, writePrototypeSession } from '@/lib/prototype-session';

import { useWorkbenchState } from './use-workbench-state';

vi.mock('@/lib/auth-api', () => ({ getCurrentUser: vi.fn(), getCreditAccount: vi.fn() }));

describe('useWorkbenchState session isolation', () => {
  const account = (id: string) => ({
    access: { can_create: true, can_upload: true, can_charge: true, restriction_reason: null },
    user: { id, email: `${id}@example.com`, display_name: id, email_verified: true },
  });
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(getCurrentUser).mockResolvedValue({
      access: { can_create: true, can_upload: true, can_charge: true, restriction_reason: null },
      user: { id: 'user-a', email: 'test@example.com', display_name: 'Test', email_verified: true },
    });
    vi.mocked(getCreditAccount).mockResolvedValue({
      balance: '100',
      frozen: '0',
      available: '100',
      currency: 'credits',
      as_of: '2026-10-03T00:00:00Z',
    });
  });

  it('hydrates each route without writing the previous route into its cache', async () => {
    writePrototypeSession(
      {
        selectedBrainModelId: 'brain-a',
        creativeDirection: { mode: 'profile', profile_id: 'human-story', version: 1 },
      },
      'a',
      'user-a',
    );
    writePrototypeSession(
      { selectedBrainModelId: 'brain-b', creativeDirection: { mode: 'native' } },
      'b',
      'user-a',
    );
    writePrototypeSession({ selectedBrainModelId: 'new-brain' }, null, 'user-a');
    const { result, rerender, unmount } = renderHook<
      ReturnType<typeof useWorkbenchState>,
      { sessionId: string | null }
    >(({ sessionId }: { sessionId: string | null }) => useWorkbenchState(true, sessionId), {
      initialProps: { sessionId: 'a' },
    });
    await waitFor(() => {
      expect(result.current.state.isAuthenticated).toBe(true);
      expect(result.current.hydrated).toBe(true);
    });
    expect(result.current.state.composer.selectedBrainModelId).toBe('brain-a');
    act(() =>
      result.current.changeComposer({
        selectedBrainModelId: 'a-manual',
        selectedBrainModelVersion: 3,
      }),
    );
    rerender({ sessionId: 'b' });
    expect(result.current.state.composer.selectedBrainModelId).toBe('brain-b');
    expect(result.current.state.composer.creativeDirection).toEqual({ mode: 'native' });
    expect(readPrototypeSession('a', 'user-a').creativeDirection).toEqual({
      mode: 'profile',
      profile_id: 'human-story',
      version: 1,
    });
    expect(readPrototypeSession('a', 'user-a').selectedBrainModelId).toBe('a-manual');
    expect(readPrototypeSession('b', 'user-a').selectedBrainModelId).toBe('brain-b');
    expect(result.current.state.isAuthenticated).toBe(true);
    rerender({ sessionId: null });
    expect(result.current.state.composer.selectedBrainModelId).toBe('new-brain');
    rerender({ sessionId: 'a' });
    expect(result.current.state.composer.selectedBrainModelId).toBe('a-manual');
    expect(result.current.state.composer.selectedBrainModelVersion).toBe(3);
    expect(result.current.state.composer.creativeDirection).toEqual({
      mode: 'profile',
      profile_id: 'human-story',
      version: 1,
    });
    unmount();

    const refreshed = renderHook(() => useWorkbenchState(true, 'a'));
    await waitFor(() => expect(refreshed.result.current.hydrated).toBe(true));
    expect(refreshed.result.current.state.composer.selectedBrainModelId).toBe('a-manual');
  });

  it('clears a new creation without affecting historical preferences', async () => {
    writePrototypeSession({ selectedBrainModelId: 'brain-a' }, 'a', 'user-a');
    const { result, rerender } = renderHook<
      ReturnType<typeof useWorkbenchState>,
      { restore: boolean; sessionId: string | null }
    >(
      ({ restore, sessionId }: { restore: boolean; sessionId: string | null }) =>
        useWorkbenchState(restore, sessionId),
      { initialProps: { restore: true, sessionId: 'a' } },
    );
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    rerender({ restore: false, sessionId: null });
    expect(result.current.state.composer.selectedBrainModelId).toBeNull();
    expect(result.current.state.composer.creativeDirection).toEqual({ mode: 'auto', version: 3 });
    expect(readPrototypeSession('a', 'user-a').selectedBrainModelId).toBe('brain-a');
  });

  it('does not read or overwrite account drafts before authentication resolves', async () => {
    writePrototypeSession({ selectedBrainModelId: 'saved-a' }, 'a', 'user-a');
    let resolveAuth!: (value: ReturnType<typeof account>) => void;
    vi.mocked(getCurrentUser).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
    );
    const { result } = renderHook(() => useWorkbenchState(true, 'a'));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.state.composer.selectedBrainModelId).toBeNull();
    expect(readPrototypeSession('a', 'user-a').selectedBrainModelId).toBe('saved-a');
    await act(async () => {
      resolveAuth(account('user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.state.composer.selectedBrainModelId).toBe('saved-a');
  });

  it('switches accounts without copying the old selection into the new account', async () => {
    writePrototypeSession({ selectedBrainModelId: 'saved-a' }, 'a', 'user-a');
    writePrototypeSession({ selectedBrainModelId: 'saved-b' }, 'a', 'user-b');
    const { result } = renderHook(() => useWorkbenchState(true, 'a'));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => result.current.changeComposer({ selectedBrainModelId: 'a-edited' }));
    vi.mocked(getCurrentUser).mockResolvedValueOnce(account('user-b'));
    await act(async () => result.current.refreshAccount());
    expect(result.current.state.userId).toBe('user-b');
    expect(result.current.state.composer.selectedBrainModelId).toBe('saved-b');
    expect(readPrototypeSession('a', 'user-a').selectedBrainModelId).toBe('a-edited');
    expect(readPrototypeSession('a', 'user-b').selectedBrainModelId).toBe('saved-b');
  });

  it('keeps only the current guest draft on login, not a previous account cache', async () => {
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error('anonymous'));
    writePrototypeSession({ selectedBrainModelId: 'previous-account' }, null, 'user-a');
    const { result } = renderHook(() => useWorkbenchState(true));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() =>
      result.current.changeComposer({
        selectedBrainModelId: 'guest-choice',
        prompt: 'current guest prompt',
      }),
    );
    await act(async () => result.current.refreshAccount());
    expect(result.current.state.composer.selectedBrainModelId).toBe('guest-choice');
    expect(result.current.state.composer.prompt).toBe('current guest prompt');
    expect(readPrototypeSession(null, 'user-a').selectedBrainModelId).toBe('guest-choice');
    expect(JSON.stringify(readPrototypeSession(null, 'user-a'))).not.toContain(
      'current guest prompt',
    );
  });

  it('discards an older authentication response after a later refresh completes', async () => {
    let resolveOld!: (value: ReturnType<typeof account>) => void;
    vi.mocked(getCurrentUser).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { result } = renderHook(() => useWorkbenchState(true));
    vi.mocked(getCurrentUser).mockResolvedValueOnce(account('user-b'));
    await act(async () => result.current.refreshAccount());
    await act(async () => {
      resolveOld(account('user-a'));
      await Promise.resolve();
    });
    expect(result.current.state.userId).toBe('user-b');
    expect(result.current.state.accountDisplayName).toBe('user-b');
  });
});
