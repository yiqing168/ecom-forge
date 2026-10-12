import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentStack } from '@/features/agent-workbench/attachment-stack';
import type { ExampleAsset } from '@/features/agent-workbench/data';

afterEach(cleanup);

function asset(index: number): ExampleAsset {
  return {
    category: '测试',
    id: `asset-${index}`,
    imageUrl: `/demo/result-${(index % 4) + 1}.jpg`,
    label: `参考图 ${index}`,
    prompt: `提示词 ${index}`,
    tags: '测试',
  };
}

describe('AttachmentStack', () => {
  it('shows a direct add action when empty', () => {
    const onAdd = vi.fn();
    render(<AttachmentStack attachments={[]} onAdd={onAdd} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('暂无附件').className).toContain('is-empty');
  });

  it('expands on an attachment and removes that exact item', () => {
    const onRemove = vi.fn();
    render(
      <AttachmentStack attachments={[asset(1), asset(2)]} onAdd={vi.fn()} onRemove={onRemove} />,
    );
    fireEvent.mouseEnter(screen.getByTitle('参考图 1'));
    expect(screen.getByLabelText('2 个附件').className).toContain('is-expanded');
    fireEvent.click(screen.getByRole('button', { name: '移除参考图 1' }));
    expect(onRemove).toHaveBeenCalledWith('asset-1');
  });

  it('opens composer attachments in the shared image gallery', async () => {
    render(
      <AttachmentStack attachments={[asset(1), asset(2)]} onAdd={vi.fn()} onRemove={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '查看参考图 1' }));
    expect(await screen.findByLabelText('图片查看器')).toBeTruthy();
    expect(screen.getByTitle('上一张图片')).toBeTruthy();
    expect(screen.getByTitle('下一张图片')).toBeTruthy();
  });

  it('keeps overflow attachments reachable through management', () => {
    const onAdd = vi.fn();
    render(
      <AttachmentStack
        attachments={Array.from({ length: 8 }, (_, index) => asset(index + 1))}
        onAdd={onAdd}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button', { name: /移除参考图/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '管理另外 2 个附件' }));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
