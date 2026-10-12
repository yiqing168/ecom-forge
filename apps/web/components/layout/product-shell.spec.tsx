import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readPrototypeSession, writePrototypeSession } from '@/lib/prototype-session';
import { ProductShell } from './product-shell';

const push = vi.hoisted(() => vi.fn());
const router = { push, replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/auth-api', () => ({
  getCurrentUser: () => Promise.resolve({ user: { id: 'user-a', display_name: 'A' } }),
  getCreditAccount: () => Promise.resolve({ balance: '100' }),
}));
vi.mock('./app-shell', () => ({
  AppShell: ({
    children,
    navigation,
  }: {
    children: ReactNode;
    navigation: { onNavigate: (label: string) => void };
  }) => (
    <>
      <button onClick={() => navigation.onNavigate('创作')}>创作</button>
      {children}
    </>
  ),
}));
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  push.mockClear();
});
afterEach(cleanup);

it('clears only the authenticated user new-creation preferences when returning from a product page', async () => {
  writePrototypeSession({ selectedBrainModelId: 'a-draft' }, null, 'user-a');
  writePrototypeSession({ selectedBrainModelId: 'a-session' }, 'session-a', 'user-a');
  writePrototypeSession({ selectedBrainModelId: 'b-draft' }, null, 'user-b');
  render(
    <ProductShell activeItem="资产" title="资产库">
      <div>Loaded assets</div>
    </ProductShell>,
  );
  await waitFor(() => expect(screen.getByText('Loaded assets')).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: '创作' }));
  expect(push).toHaveBeenCalledWith('/');
  expect(readPrototypeSession(null, 'user-a').selectedBrainModelId).toBeNull();
  expect(readPrototypeSession('session-a', 'user-a').selectedBrainModelId).toBe('a-session');
  expect(readPrototypeSession(null, 'user-b').selectedBrainModelId).toBe('b-draft');
});
