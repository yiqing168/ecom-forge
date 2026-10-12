import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';

afterEach(cleanup);

describe('Input', () => {
  it('renders with an accessible label', () => {
    render(<Input aria-label="商品名称" />);
    expect(screen.getByLabelText('商品名称')).toBeInstanceOf(HTMLInputElement);
  });

  it('forwards input changes', () => {
    render(<Input aria-label="商品名称" defaultValue="连衣裙" />);
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '运动鞋' } });
    expect(screen.getByLabelText<HTMLInputElement>('商品名称').value).toBe('运动鞋');
  });

  it('preserves disabled semantics', () => {
    render(<Input aria-label="商品名称" disabled />);
    expect(screen.getByLabelText<HTMLInputElement>('商品名称').disabled).toBe(true);
  });
});

describe('Checkbox', () => {
  it('toggles through keyboard-compatible button semantics', () => {
    render(<Checkbox aria-label="选择图片" />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择图片' }));
    expect(screen.getByRole('checkbox').getAttribute('data-state')).toBe('checked');
  });

  it('supports controlled state', () => {
    render(<Checkbox aria-label="选择图片" checked />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
  });

  it('does not toggle when disabled', () => {
    render(<Checkbox aria-label="选择图片" disabled />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox').getAttribute('data-state')).toBe('unchecked');
  });
});

describe('Badge', () => {
  it('renders content', () => {
    render(<Badge>草稿</Badge>);
    expect(screen.getByText('草稿')).toBeInstanceOf(HTMLSpanElement);
  });

  it('maps known statuses to semantic tones', () => {
    render(<StatusBadge status="失败" />);
    expect(screen.getByText('失败').className).toContain('danger-soft');
  });

  it('falls back safely for unknown statuses', () => {
    render(<StatusBadge status="未知状态" />);
    expect(screen.getByText('未知状态').className).toContain('neutral-foreground');
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive technology', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts stable dimensions', () => {
    const { container } = render(<Skeleton className="h-10 w-20" />);
    expect(container.firstElementChild?.className).toContain('h-10');
  });

  it('forwards data attributes', () => {
    const { container } = render(<Skeleton data-testid="loading-row" />);
    expect(container.querySelector('[data-testid="loading-row"]')).not.toBeNull();
  });
});

describe('Tabs', () => {
  function renderTabs(defaultValue = 'templates') {
    render(
      <Tabs defaultValue={defaultValue}>
        <TabsList aria-label="发现内容">
          <TabsTrigger value="templates">模板</TabsTrigger>
          <TabsTrigger value="references">参考图</TabsTrigger>
        </TabsList>
        <TabsContent value="templates">模板内容</TabsContent>
        <TabsContent value="references">参考图内容</TabsContent>
      </Tabs>,
    );
  }

  it('selects the default tab', () => {
    renderTabs();
    expect(screen.getByRole('tab', { name: '模板' }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches panels on activation', () => {
    renderTabs();
    const trigger = screen.getByRole('tab', { name: '参考图' });
    fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
    expect(trigger.getAttribute('aria-selected')).toBe('true');
  });

  it('supports an alternate initial value', () => {
    renderTabs('references');
    expect(screen.getByRole('tab', { name: '参考图' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Select', () => {
  function renderSelect(disabled = false) {
    render(
      <Select defaultValue="square" disabled={disabled}>
        <SelectTrigger aria-label="图片比例">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="square">1:1</SelectItem>
          <SelectItem value="portrait">3:4</SelectItem>
        </SelectContent>
      </Select>,
    );
  }

  it('exposes combobox semantics and its selected value', () => {
    renderSelect();
    expect(screen.getByRole('combobox', { name: '图片比例' }).textContent).toContain('1:1');
  });

  it('preserves disabled semantics', () => {
    renderSelect(true);
    expect(screen.getByRole<HTMLButtonElement>('combobox').disabled).toBe(true);
  });

  it('accepts a custom class without losing base styles', () => {
    render(
      <Select defaultValue="square">
        <SelectTrigger aria-label="图片比例" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="square">1:1</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole('combobox').className).toContain('w-48');
  });
});

describe('IconButton', () => {
  it('requires and exposes an accessible name', () => {
    render(
      <TooltipProvider>
        <IconButton aria-label="删除附件" icon={<span aria-hidden="true">x</span>} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: '删除附件' })).toBeInstanceOf(HTMLButtonElement);
  });

  it('forwards click behavior', () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <IconButton aria-label="删除附件" icon={<span>x</span>} onClick={onClick} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <IconButton aria-label="删除附件" disabled icon={<span>x</span>} onClick={onClick} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
