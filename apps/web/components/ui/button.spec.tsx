import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './button';

afterEach(cleanup);

describe('Button', () => {
  it('applies the selected visual variant and invokes the command', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} variant="inverse">
        新建创作
      </Button>,
    );

    const button = screen.getByRole('button', { name: '新建创作' });
    expect(button.className).toContain('bg-[var(--inverse)]');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not invoke disabled commands', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        开始创作
      </Button>,
    );

    fireEvent.click(screen.getByRole('button', { name: '开始创作' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
