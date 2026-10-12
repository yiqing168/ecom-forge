import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SkillCatalogItem } from '@/lib/agent-api';
import type { ComposerValue } from './composer';
import type { ConversationProps } from './conversation';
import { WorkbenchContent } from './workbench-content';

vi.mock('./example-gallery', () => ({ ExampleGallery: () => null }));
afterEach(cleanup);

const skills: SkillCatalogItem[] = Array.from({ length: 10 }, (_, index) => ({
  primary_skill_id: `source-study-${index}@1.0.0`,
  slug: `source-study-${index}`,
  version: '1.0.0',
  name: `创作方法 ${index + 1}`,
  description: 'Source-specific creative method',
  domain: 'creative',
  category: 'creative',
  required_inputs: [],
  preset_slots: [],
}));

const conversationProps: ConversationProps = {
  actionPending: false,
  backgroundWorkflows: [],
  error: '',
  hasPendingComposerImages: false,
  loadingOlder: false,
  loading: false,
  onAddClarificationImage: vi.fn(),
  onConfirm: () => Promise.resolve(),
  onInterrupt: () => Promise.resolve(),
  onLoadOlder: () => Promise.resolve(),
  onRetryImage: () => Promise.resolve(),
  realtimeStatus: 'live',
  retrySnapshots: {},
  session: null,
  snapshot: null,
  workflowArtifacts: [],
  workflowReviewState: null,
  workflowTasks: [],
};

function Harness({
  items = skills,
  onChange = vi.fn(),
}: {
  items?: SkillCatalogItem[];
  onChange?: (change: Partial<ComposerValue>) => void;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<ComposerValue>({
    agentMode: 'image',
    aspectRatio: 'auto',
    attachmentRoles: { source: 'semantic_reference' },
    attachments: [],
    prompt: '',
    referencedAttachmentIds: [],
    resolutionTier: '1k',
    selectedBrainModelId: null,
    selectedImageModelId: null,
    selectedPresetIds: { old: 'old-style@1.0.0' },
    selectedSkillId: null,
    videoDuration: '5 秒',
    videoResolution: '1080P',
  });
  return (
    <WorkbenchContent
      composerProps={{
        catalog: {
          brainModels: [],
          error: '',
          imageModels: [],
          skills: items,
          status: 'ready',
          videoModels: [],
        },
        onAddAttachment: vi.fn(),
        onChange: (change) => {
          onChange(change);
          setValue((current) => ({ ...current, ...change }));
        },
        onReferenceAttachment: vi.fn(),
        onRemoveAttachment: vi.fn(),
        onReloadCatalog: vi.fn(),
        onSubmit: vi.fn(),
        value,
      }}
      composerRef={composerRef}
      conversationProps={conversationProps}
      onSelectExample={vi.fn()}
      view="home"
    />
  );
}

function openMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: /选择 Skill/ }));
  return screen.getByRole('menu');
}

describe('home Skill shortcuts', () => {
  it('shows the requested application name and description on the existing home', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { level: 1, name: '象塑' })).toBeDefined();
    expect(screen.getByText('重塑物象，万千风格')).toBeDefined();
    expect(screen.getByRole('textbox', { name: '创作输入' })).toBeDefined();
  });

  it('shows the full catalog in the same order as the dropdown, including items beyond eight', () => {
    render(<Harness />);
    const shortcuts = screen.getAllByRole('button', { name: /^使用 Skill：/ });
    expect(shortcuts.map((item) => item.textContent)).toEqual(skills.map((skill) => skill.name));
    const options = within(openMenu()).getAllByRole('menuitem');
    expect(options.map((item) => item.textContent)).toEqual(skills.map((skill) => skill.name));
  });

  it('synchronizes selection in both directions and clears obsolete input roles and presets', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '使用 Skill：创作方法 10' }));
    expect(onChange).toHaveBeenLastCalledWith({
      agentMode: 'image',
      attachmentRoles: {},
      selectedPresetIds: {},
      selectedSkillId: skills[9]!.primary_skill_id,
    });
    expect(screen.getByRole('button', { name: '选择 Skill：创作方法 10' })).toBeDefined();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: '创作方法 2' }));
    expect(
      screen.getByRole('button', { name: '使用 Skill：创作方法 2' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: '使用 Skill：创作方法 10' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('removes a hidden entry from both controls when the server catalog reloads', () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '使用 Skill：创作方法 10' }));
    rerender(<Harness items={skills.slice(0, 9)} />);
    expect(screen.queryByRole('button', { name: '使用 Skill：创作方法 10' })).toBeNull();
    expect(screen.getByRole('button', { name: '选择 Skill：未选择' })).toBeDefined();
    expect(within(openMenu()).queryByRole('menuitem', { name: '创作方法 10' })).toBeNull();
  });

  it('does not invent shortcuts when the public catalog is empty', () => {
    render(<Harness items={[]} />);
    expect(screen.queryAllByRole('button', { name: /^使用 Skill：/ })).toHaveLength(0);
    expect(within(openMenu()).getByRole('menuitem', { name: '暂无可用 Skill' })).toBeDefined();
  });
});
