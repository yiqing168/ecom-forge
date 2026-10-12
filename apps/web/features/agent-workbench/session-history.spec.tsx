import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionHistory, SessionSidebar, type SessionPreview } from './session-history';

afterEach(cleanup);

const sessions: SessionPreview[] = ['第一会话', '第二会话'].map((title, index) => ({
  id: `session-${index}`,
  title,
  revision: 1,
  last_message_preview: '',
  last_turn_id: null,
  last_turn_status: 'completed',
  updated_at: '2026-10-10T00:00:00.000Z',
}));

function props() {
  return {
    activeId: sessions[0]!.id,
    error: '',
    loading: false,
    loadingMore: false,
    mutationId: null,
    nextCursor: null,
    onArchive: vi.fn(() => Promise.resolve()),
    onLoadMore: vi.fn(),
    onNewSession: vi.fn(),
    onQueryChange: vi.fn(),
    onRename: vi.fn(() => Promise.resolve()),
    onSelect: vi.fn(),
    query: '',
    sessions,
  };
}

describe('session selection and search', () => {
  it('marks the actual selected button and highlights the full row when the active session changes', () => {
    const input = props();
    const { rerender } = render(<SessionSidebar {...input} />);
    const first = screen.getByText('第一会话').closest('button')!;
    const second = screen.getByText('第二会话').closest('button')!;
    expect(first.getAttribute('aria-current')).toBe('page');
    expect(first.parentElement?.className).toContain('bg-[var(--primary-soft)]');
    expect(second.getAttribute('aria-current')).toBeNull();

    rerender(<SessionSidebar {...input} activeId={sessions[1]!.id} />);
    expect(first.getAttribute('aria-current')).toBeNull();
    expect(first.parentElement?.className).not.toContain('bg-[var(--primary-soft)]');
    expect(second.getAttribute('aria-current')).toBe('page');
    fireEvent.click(first);
    expect(input.onSelect).toHaveBeenCalledWith(sessions[0]);
  });

  it('keeps desktop search controlled and forwards the unchanged query', () => {
    const input = props();
    render(<SessionSidebar {...input} query="已有查询" />);
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索会话' });
    expect(search.value).toBe('已有查询');
    fireEvent.change(search, { target: { value: '第二会话' } });
    expect(input.onQueryChange).toHaveBeenCalledWith('第二会话');
  });

  it('shows the same selection and search in the mobile history and closes after selection', () => {
    const input = props();
    const onOpenChange = vi.fn();
    render(<SessionHistory {...input} onOpenChange={onOpenChange} open />);
    const dialog = within(screen.getByRole('dialog'));
    const first = dialog.getByText('第一会话').closest('button')!;
    expect(first.getAttribute('aria-current')).toBe('page');
    expect(first.parentElement?.className).toContain('bg-[var(--primary-soft)]');
    fireEvent.change(dialog.getByRole('textbox', { name: '搜索会话' }), {
      target: { value: '第一会话' },
    });
    expect(input.onQueryChange).toHaveBeenCalledWith('第一会话');
    fireEvent.click(first);
    expect(input.onSelect).toHaveBeenCalledWith(sessions[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
