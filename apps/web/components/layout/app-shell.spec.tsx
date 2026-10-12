import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/components/layout/app-shell';

afterEach(cleanup);

function renderShell({
  authenticated = true,
  secondaryNavigation,
}: { authenticated?: boolean; secondaryNavigation?: ReactNode } = {}) {
  const onNavigate = vi.fn();
  render(
    <AppShell
      account={{ balance: '66.00', displayName: '新用户' }}
      navigation={{ activeItem: '作品', isAuthenticated: authenticated, onNavigate }}
      secondaryNavigation={secondaryNavigation}
      topBar={{
        onLogin: vi.fn(),
        onOpenAccount: vi.fn(),
        onOpenGeneration: vi.fn(),
        title: '商品',
      }}
    >
      <main>页面内容</main>
    </AppShell>,
  );
  return onNavigate;
}

describe('AppShell', () => {
  it('composes navigation, top bar and page content', () => {
    renderShell();
    expect(screen.getByText('页面内容')).toBeInstanceOf(HTMLElement);
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
    const mainNavigation = screen.getByRole('navigation', { name: '主要导航' });
    expect(
      within(mainNavigation)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['创作', '生成', '资产', '作品']);
    expect(screen.getAllByRole('button', { name: '资产' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '生成' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '商品' })).toBeNull();
    expect(screen.queryByRole('button', { name: '任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '画布' })).toBeNull();
    expect(screen.getByText('66.00 积分')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('新')).toBeInstanceOf(HTMLElement);
  });

  it('forwards navigation commands', () => {
    const onNavigate = renderShell();
    fireEvent.click(screen.getAllByRole('button', { name: '作品' })[0]!);
    expect(onNavigate).toHaveBeenCalledWith('作品');
  });

  it('keeps the original mobile menu and commands after the brand update', () => {
    const onNavigate = renderShell();
    expect(screen.getAllByRole('img', { name: '象塑' }).length).toBeGreaterThan(0);
    const buttons = within(screen.getByRole('navigation', { name: '移动端主要导航' })).getAllByRole(
      'button',
    );
    expect(buttons.map((button) => button.textContent)).toEqual([
      '创作',
      '生成',
      '资产',
      '作品',
      '我的',
    ]);
    for (const [index, label] of ['创作', '生成', '资产', '作品', '更多'].entries()) {
      fireEvent.click(buttons[index]!);
      expect(onNavigate).toHaveBeenLastCalledWith(label);
    }
  });

  it('renders optional secondary navigation for workspace mode', () => {
    renderShell({ secondaryNavigation: <aside aria-label="会话栏">历史会话</aside> });
    expect(screen.getByRole('complementary', { name: '会话栏' })).toBeInstanceOf(HTMLElement);
  });
});
