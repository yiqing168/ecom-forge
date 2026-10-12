import { App } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeneratedInviteList, revealAndCopyInvite } from './invite-management';

afterEach(cleanup);

describe('GeneratedInviteList', () => {
  it('keeps plaintext on the page and supports exact single and batch copy actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <App>
        <GeneratedInviteList
          codes={[
            { id: 'one', prefix: 'ABCD', plaintext_code: 'ABCD-1111' },
            { id: 'two', prefix: 'EFGH', plaintext_code: 'EFGH-2222' },
          ]}
          onClear={vi.fn()}
        />
      </App>,
    );

    expect(screen.getByText('ABCD-1111')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制邀请码 ABCD' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-1111'));

    fireEvent.click(screen.getByRole('button', { name: '复制全部邀请码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-1111\nEFGH-2222'));
  });

  it('clears plaintext only after an explicit action', () => {
    const onClear = vi.fn();
    render(
      <App>
        <GeneratedInviteList
          codes={[{ id: 'one', prefix: 'ABCD', plaintext_code: 'ABCD-1111' }]}
          onClear={onClear}
        />
      </App>,
    );

    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe('revealAndCopyInvite', () => {
  it('reveals one list row and copies only the returned plaintext', async () => {
    const request = vi.fn().mockResolvedValue({ plaintext_code: 'ABCD-1111' });
    const writeText = vi.fn().mockResolvedValue(undefined);

    await revealAndCopyInvite(request, '58a2c31b-c9e6-430f-9d90-8b8ddbe43d94', writeText);

    expect(request).toHaveBeenCalledWith('/invites/58a2c31b-c9e6-430f-9d90-8b8ddbe43d94/reveal', {
      method: 'POST',
      body: '{}',
    });
    expect(writeText).toHaveBeenCalledWith('ABCD-1111');
  });
});
