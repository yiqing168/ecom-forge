import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveAgentSession,
  listAgentSessions,
  renameAgentSession,
  type SessionPreview,
} from '@/lib/agent-api';

import { useAgentSessions } from './use-agent-sessions';

vi.mock('@/lib/agent-api', () => ({
  archiveAgentSession: vi.fn(),
  listAgentSessions: vi.fn(),
  renameAgentSession: vi.fn(),
}));

describe('useAgentSessions', () => {
  beforeEach(() => {
    vi.mocked(listAgentSessions).mockReset();
    vi.mocked(renameAgentSession).mockReset();
    vi.mocked(archiveAgentSession).mockReset();
  });

  it('merges keyset pages without duplicate sessions', async () => {
    vi.mocked(listAgentSessions)
      .mockResolvedValueOnce({ items: [session('one')], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({
        items: [session('one', 2), session('two')],
        next_cursor: null,
      });
    const { result } = renderHook(() => useAgentSessions(true));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => result.current.loadMore());
    expect(result.current.items.map((item) => item.id)).toEqual(['one', 'two']);
    expect(result.current.items[0]?.revision).toBe(2);
  });

  it('reuses the rename idempotency key after an ambiguous failure', async () => {
    vi.mocked(listAgentSessions).mockResolvedValue({ items: [session('one')], next_cursor: null });
    vi.mocked(renameAgentSession)
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce({
        id: 'one',
        title: '新标题',
        revision: 2,
        updated_at: '2026-08-17T08:01:00.000Z',
      });
    const { result } = renderHook(() => useAgentSessions(true));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await expect(act(async () => result.current.rename(session('one'), '新标题'))).rejects.toThrow(
      '连接中断',
    );
    await act(async () => result.current.rename(session('one'), '新标题'));
    expect(vi.mocked(renameAgentSession).mock.calls[0]?.[2]).toBe(
      vi.mocked(renameAgentSession).mock.calls[1]?.[2],
    );
    expect(result.current.items[0]).toMatchObject({ title: '新标题', revision: 2 });
  });

  it('waits for a pending search before requesting another page', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof listAgentSessions>>>();
    vi.mocked(listAgentSessions)
      .mockResolvedValueOnce({ items: [session('one')], next_cursor: 'old-cursor' })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ items: [session('three')], next_cursor: null });
    const { result } = renderHook(() => useAgentSessions(true));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => result.current.setQuery('filtered'));
    expect(result.current.loading).toBe(true);
    await act(async () => result.current.loadMore());
    expect(listAgentSessions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listAgentSessions).toHaveBeenCalledTimes(2));
    await act(async () => result.current.loadMore());
    expect(listAgentSessions).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve({ items: [session('two')], next_cursor: 'search-cursor' });
      await pending.promise;
    });
    await act(async () => result.current.loadMore());
    expect(listAgentSessions).toHaveBeenLastCalledWith({
      cursor: 'search-cursor',
      query: 'filtered',
      limit: 20,
    });
    expect(result.current.items.map((item) => item.id)).toEqual(['two', 'three']);
  });
});

function session(id: string, revision = 1): SessionPreview {
  return {
    id,
    title: `会话 ${id}`,
    revision,
    last_message_preview: '',
    last_turn_id: null,
    last_turn_status: null,
    updated_at: '2026-08-17T08:00:00.000Z',
  };
}
