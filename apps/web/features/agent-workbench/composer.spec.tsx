import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Composer, type ComposerValue } from '@/features/agent-workbench/composer';

afterEach(cleanup);

const attachment = {
  category: '服装',
  id: 'asset-dress',
  imageUrl: '/demo/dress.jpg',
  label: '连衣裙原图',
  prompt: '时装大片',
  tags: '时装 / 原图',
  resourceType: 'asset' as const,
  resourceVersion: 'content-version-1',
};

const brainModelId = '11111111-1111-4111-8111-111111111111';
const imageModelId = '22222222-2222-4222-8222-222222222222';

const initialValue: ComposerValue = {
  agentMode: 'image',
  aspectRatio: '1:1',
  attachmentRoles: {},
  attachments: [attachment],
  prompt: '',
  referencedAttachmentIds: [],
  resolutionTier: '1k',
  selectedBrainModelId: brainModelId,
  selectedImageModelId: imageModelId,
  selectedPresetIds: { style: 'clean-studio@1.0.0' },
  selectedSkillId: 'commerce-main@1.0.0',
  videoDuration: '5 秒',
  videoResolution: '1080P',
};

const catalog = {
  brainModels: [model(brainModelId, 'brain')],
  error: '',
  imageModels: [model(imageModelId, 'image')],
  skills: [
    {
      primary_skill_id: 'commerce-main@1.0.0',
      slug: 'commerce-main',
      version: '1.0.0',
      name: '电商创作',
      description: '创建电商图片',
      domain: 'commerce' as const,
      category: 'commerce',
      required_inputs: ['product_image'],
      preset_slots: [
        {
          slot: 'style',
          label: '展示方式',
          required: true,
          max_selections: 1,
          options: [
            {
              preset_id: 'clean-studio@1.0.0',
              name: '纯净棚拍',
              description: '干净白底',
            },
          ],
        },
      ],
    },
  ],
  status: 'ready' as const,
  videoModels: [],
};

function Harness({ onReference = vi.fn(), onSubmit = vi.fn() }) {
  const [value, setValue] = useState(initialValue);
  return (
    <Composer
      catalog={catalog}
      onAddAttachment={vi.fn()}
      onChange={(change) => setValue((current) => ({ ...current, ...change }))}
      onReferenceAttachment={onReference}
      onRemoveAttachment={vi.fn()}
      onReloadCatalog={vi.fn()}
      onSubmit={onSubmit}
      value={value}
    />
  );
}

describe('Composer', () => {
  it('allows a text-only free creation request without a style control or preset', () => {
    const onSubmit = vi.fn();
    const free = {
      ...catalog.skills[0]!,
      primary_skill_id: 'creative-free-generation@1.0.1',
      slug: 'creative-free-generation',
      name: '自由创作',
      required_inputs: [],
      preset_slots: [],
    };
    render(
      <Composer
        catalog={{ ...catalog, skills: [free] }}
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={vi.fn()}
        onSubmit={onSubmit}
        value={{
          ...initialValue,
          selectedSkillId: free.primary_skill_id,
          selectedPresetIds: {},
          attachments: [],
          prompt: 'A blue ceramic cup on white, viewed from above. No text.',
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /选择风格/ })).toBeNull();
    expect(screen.getByRole('button', { name: /设计师：/ })).toBeDefined();
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('keeps an empty conversation input disabled', () => {
    render(
      <Composer
        catalog={catalog}
        continuation
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={vi.fn()}
        onSubmit={vi.fn()}
        value={{ ...initialValue, attachments: [] }}
      />,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(true);
  });

  it('allows an attachment-only reply without inventing a generation instruction', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' }).value).toBe('');
  });

  it('allows a text reply with attachments', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: '创作输入' }), {
      target: { value: '生成一张主图' },
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(
      false,
    );
  });

  it('blocks sending when the account balance is zero', () => {
    render(
      <Composer
        catalog={catalog}
        creditBalance="0.00"
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={vi.fn()}
        onSubmit={vi.fn()}
        value={{ ...initialValue, prompt: '生成一张图片' }}
      />,
    );

    expect(screen.getByText('积分不足，当前余额为 0，无法发送')).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(true);
  });

  it('keeps submit disabled when the required primary Skill is missing', () => {
    function MissingSkillHarness() {
      const [value, setValue] = useState<ComposerValue>({
        ...initialValue,
        selectedSkillId: null,
      });
      return (
        <Composer
          catalog={catalog}
          onAddAttachment={vi.fn()}
          onChange={(change) => setValue((current) => ({ ...current, ...change }))}
          onReferenceAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onReloadCatalog={vi.fn()}
          onSubmit={vi.fn()}
          value={value}
        />
      );
    }
    render(<MissingSkillHarness />);
    fireEvent.change(screen.getByRole('textbox', { name: '创作输入' }), {
      target: { value: '生成一张主图' },
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(true);
  });

  it('selects a local attachment mention with the keyboard', () => {
    const onReference = vi.fn();
    render(<Harness onReference={onReference} />);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' });
    fireEvent.change(input, { target: { value: '@连' } });
    expect(screen.getByRole('option', { name: '@连衣裙原图' })).toBeInstanceOf(HTMLButtonElement);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onReference).toHaveBeenCalledWith('asset-dress');
    expect(input.value).toContain('@连衣裙原图');
  });

  it('opens mentions when @ follows Chinese text without a space', () => {
    render(<Harness />);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' });
    fireEvent.change(input, { target: { value: '基于@连' } });

    expect(screen.getByRole('option', { name: '@连衣裙原图' })).toBeInstanceOf(HTMLButtonElement);
  });

  it('dismisses mentions with Escape without submitting', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' });
    fireEvent.change(input, { target: { value: '@' } });
    expect(screen.getByRole('listbox')).toBeInstanceOf(HTMLDivElement);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not open an empty mention panel when no attachment exists', () => {
    function EmptyAttachmentHarness() {
      const [value, setValue] = useState<ComposerValue>({
        ...initialValue,
        attachments: [],
      });
      return (
        <Composer
          catalog={catalog}
          onAddAttachment={vi.fn()}
          onChange={(change) => setValue((current) => ({ ...current, ...change }))}
          onReferenceAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onReloadCatalog={vi.fn()}
          onSubmit={vi.fn()}
          value={value}
        />
      );
    }
    render(<EmptyAttachmentHarness />);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' });
    fireEvent.change(input, { target: { value: '@' } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('allows a continuation prompt without a fresh attachment', () => {
    render(
      <Composer
        catalog={catalog}
        continuation
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={vi.fn()}
        onSubmit={vi.fn()}
        value={{ ...initialValue, attachments: [], prompt: '留白少一点' }}
      />,
    );

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(
      false,
    );
  });

  it('anchors attachment mentions to the input and has no referenced check state', () => {
    function ReferencedAttachmentHarness() {
      const [value, setValue] = useState<ComposerValue>({
        ...initialValue,
        prompt: '@',
        referencedAttachmentIds: ['asset-dress'],
      });
      return (
        <Composer
          catalog={catalog}
          onAddAttachment={vi.fn()}
          onChange={(change) => setValue((current) => ({ ...current, ...change }))}
          onReferenceAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onReloadCatalog={vi.fn()}
          onSubmit={vi.fn()}
          value={value}
        />
      );
    }

    render(<ReferencedAttachmentHarness />);
    const listbox = screen.getByRole('listbox');
    expect(listbox.className).toContain('bottom-full');
    expect(screen.getByRole('option', { name: '@连衣裙原图' })).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByRole('option', { name: '@连衣裙原图' }).querySelector('svg')).toBeNull();
  });

  it('dismisses the mention panel when focus moves outside the input region', () => {
    render(<Harness />);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作输入' });
    fireEvent.change(input, { target: { value: '@' } });
    expect(screen.getByRole('listbox')).toBeInstanceOf(HTMLDivElement);

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not expose quantity or cost-authorization controls', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /图片数量/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /执行授权/ })).toBeNull();
  });

  it('offers intelligent ratio alongside fixed ratios', () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByRole('button', { name: '图片比例：1:1' }));

    expect(screen.getByRole('menuitem', { name: '智能比例' })).toBeInstanceOf(HTMLDivElement);
    expect(screen.getByRole('menuitem', { name: '3:4' })).toBeInstanceOf(HTMLDivElement);
  });

  it('hides the video mode until an available video model is published', () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByRole('button', { name: '选择创作 Agent：智能生图 Agent' }));
    expect(screen.queryByRole('menuitem', { name: '智能视频 Agent' })).toBeNull();
  });

  it('lets the user explicitly retry a failed catalog load', () => {
    const onReloadCatalog = vi.fn();
    render(
      <Composer
        catalog={{ ...catalog, error: '模型与 Skill 目录加载失败', status: 'error' }}
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={onReloadCatalog}
        onSubmit={vi.fn()}
        value={initialValue}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onReloadCatalog).toHaveBeenCalledOnce();
  });

  it('shows the session Skill as locked without opening the selector', () => {
    render(
      <Composer
        catalog={catalog}
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={vi.fn()}
        onSubmit={vi.fn()}
        skillLocked
        value={initialValue}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '当前会话 Skill：电商创作，已锁定' }));
    expect(screen.queryByRole('menuitem', { name: '电商创作' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '当前会话风格：纯净棚拍，已锁定' }));
    expect(screen.queryByRole('menuitem', { name: /纯净棚拍/ })).toBeNull();
  });

  it('renders catalog entries without a client-side Skill slug blacklist', () => {
    render(
      <Composer
        catalog={{
          ...catalog,
          skills: [
            ...catalog.skills,
            {
              ...catalog.skills[0]!,
              name: '商品白底精修',
              primary_skill_id: 'commerce-white-background@1.0.0',
              slug: 'commerce-white-background',
            },
          ],
        }}
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={vi.fn()}
        onSubmit={vi.fn()}
        value={initialValue}
      />,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: /选择 Skill/ }));
    expect(screen.getByRole('menuitem', { name: '商品白底精修' })).toBeInstanceOf(HTMLDivElement);
    expect(screen.getByRole('menuitem', { name: /电商创作/ })).toBeInstanceOf(HTMLDivElement);
  });

  it('does not restore a hidden Skill as a valid new-session selection', () => {
    render(
      <Composer
        catalog={catalog}
        onAddAttachment={vi.fn()}
        onChange={vi.fn()}
        onReferenceAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onReloadCatalog={vi.fn()}
        onSubmit={vi.fn()}
        value={{
          ...initialValue,
          selectedPresetIds: {},
          selectedSkillId: 'commerce-white-background@1.0.0',
        }}
      />,
    );

    expect(screen.getByRole('button', { name: '选择 Skill：未选择' })).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始创作' }).disabled).toBe(true);
  });
});

function model(id: string, category: 'brain' | 'image') {
  return {
    id,
    public_slug: category,
    version_no: 1,
    category,
    display_name: category === 'brain' ? '创作助手' : '高清图片',
    description: '可用',
    public_capabilities: {},
    user_selectable: true,
    is_default: true,
    availability: 'available' as const,
    pricing_summary: [],
  };
}
