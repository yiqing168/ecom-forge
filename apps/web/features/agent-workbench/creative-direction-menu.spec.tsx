import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreativeDirectionMenu } from './creative-direction-menu';

afterEach(cleanup);

describe('designer menu', () => {
  it('supports keyboard selection with six profiles, automatic and native options', () => {
    const onChange = vi.fn();
    render(<CreativeDirectionMenu onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button', { name: '设计师：自动' }), { key: 'Enter' });
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(8);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /视觉隐喻/ }));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'profile',
      profile_id: 'visual-metaphor',
      version: 2,
    });
  });
  it('disables interaction while submission or recovery is pending', () => {
    render(<CreativeDirectionMenu disabled onChange={vi.fn()} value={{ mode: 'native' }} />);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: '设计师：Skill 原生' }).disabled,
    ).toBe(true);
  });
  it('keeps invalid cache visible and lets the user choose automatic again', () => {
    const onChange = vi.fn();
    render(<CreativeDirectionMenu onChange={onChange} value={null} />);
    fireEvent.keyDown(screen.getByRole('button', { name: '设计师：重新选择' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /自动/ }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'auto', version: 3 });
  });
  it('displays a historical v1 selection without changing it until explicit reselection', () => {
    const onChange = vi.fn();
    const value = {
      mode: 'profile' as const,
      profile_id: 'visual-metaphor' as const,
      version: 1 as const,
    };
    render(<CreativeDirectionMenu onChange={onChange} value={value} />);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: '设计师：视觉隐喻' }), { key: 'Enter' });
    expect(
      screen.getByRole('menuitemradio', { name: /视觉隐喻/ }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /视觉隐喻/ }));
    expect(onChange).toHaveBeenCalledWith({ ...value, version: 2 });
  });

  it('clears an open menu across lock changes without changing control mode', () => {
    const onChange = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { rerender } = render(<CreativeDirectionMenu onChange={onChange} />);
      fireEvent.keyDown(screen.getByRole('button', { name: '设计师：自动' }), { key: 'Enter' });
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(8);

      rerender(<CreativeDirectionMenu locked onChange={onChange} />);
      expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '设计师：自动' }).disabled).toBe(
        true,
      );

      rerender(<CreativeDirectionMenu onChange={onChange} />);
      expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
      expect(onChange).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByRole('button', { name: '设计师：自动' }), { key: 'Enter' });
      fireEvent.click(screen.getByRole('menuitemradio', { name: /视觉隐喻/ }));
      expect(onChange).toHaveBeenCalledWith({
        mode: 'profile',
        profile_id: 'visual-metaphor',
        version: 2,
      });
    } finally {
      warn.mockRestore();
    }
  });
});

it('shows the authoritative resolved designer while preventing a session change', () => {
  const onChange = vi.fn();
  render(
    <CreativeDirectionMenu
      locked
      onChange={onChange}
      value={{ mode: 'native' }}
      snapshot={{
        schema_version: 1,
        selection: { mode: 'auto', version: 3 },
        resolved_profile: { mode: 'profile', profile_id: 'material-experiment', version: 2 },
        resolution_turn_id: '10000000-0000-4000-8000-000000000001',
        resolution_step_id: '10000000-0000-4000-8000-000000000002',
      }}
    />,
  );
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '设计师：自动 · 材料实验' });
  expect(button.disabled).toBe(true);
  expect(button.title).toContain('新建会话');
  fireEvent.keyDown(button, { key: 'Enter' });
  expect(screen.queryByRole('menuitemradio')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
