import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExampleGallery } from './example-gallery';
import { showcaseExamples } from './showcase-data';

afterEach(cleanup);

const availableSkills = showcaseExamples.map((example) => ({
  primary_skill_id: `${example.skillSlug}@9.0.0`,
}));

describe('ExampleGallery real outputs', () => {
  it('renders complete static artwork with accessible labels and reserved dimensions', () => {
    render(<ExampleGallery availableSkills={availableSkills} onSelect={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '创作精选' })).toBeInstanceOf(HTMLElement);
    expect(screen.getAllByRole('img')).toHaveLength(4);
    for (const image of screen.getAllByRole('img')) {
      expect(image.getAttribute('src')).toContain('/showcase/');
      expect(image.className).toContain('object-contain');
      expect(image.parentElement?.className).toContain('aspect-[3/4]');
    }
  });

  it('previews without starting generation and selects a Skill only on explicit action', async () => {
    const onSelect = vi.fn();
    render(<ExampleGallery availableSkills={availableSkills} onSelect={onSelect} />);
    const example = showcaseExamples[0]!;
    const trigger = screen.getByRole('button', {
      name: `预览${example.label}：${example.skillName}`,
    });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    const imageSrc = within(dialog).getByRole('img').getAttribute('src')!;
    expect(new URL(imageSrc, window.location.origin).pathname).toBe(example.imageUrl);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '使用此 Skill' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(example);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('allows previews but no creation action without an available catalog entry', () => {
    render(<ExampleGallery availableSkills={[]} onSelect={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^预览/ })[0]!);
    expect(screen.getByRole('dialog')).toBeInstanceOf(HTMLElement);
    expect(screen.queryByRole('button', { name: '使用此 Skill' })).toBeNull();
  });

  it('supports changing batches and shows an actionable image-error state', () => {
    render(<ExampleGallery availableSkills={availableSkills} onSelect={vi.fn()} />);
    const before = screen.getAllByRole('img')[0]!.getAttribute('src');
    fireEvent.click(screen.getByRole('button', { name: '换一批' }));
    expect(screen.getAllByRole('img')[0]!.getAttribute('src')).not.toBe(before);
    fireEvent.error(screen.getAllByRole('img')[0]!);
    expect(screen.getByRole('status').textContent).toContain('图片暂时无法显示');
    fireEvent.click(screen.getByRole('button', { name: '换一批' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('restores focus to the preview trigger when closed', async () => {
    render(<ExampleGallery availableSkills={[]} onSelect={vi.fn()} />);
    const trigger = screen.getAllByRole('button', { name: /^预览/ })[0]!;
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
