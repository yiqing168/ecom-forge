'use client';

import { ArrowUpRight, History, WandSparkles } from 'lucide-react';
import type { RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { Composer, type ComposerProps } from '@/features/agent-workbench/composer';
import { Conversation, type ConversationProps } from '@/features/agent-workbench/conversation';
import type { ShowcaseExample } from '@/features/agent-workbench/showcase-data';
import { ExampleGallery } from '@/features/agent-workbench/example-gallery';
import { cn } from '@/lib/cn';

export type WorkbenchView = 'home' | 'session' | 'session-new';

type WorkbenchContentProps = {
  composerProps: ComposerProps;
  composerRef: RefObject<HTMLDivElement | null>;
  conversationProps: ConversationProps;
  onSelectExample: (example: ShowcaseExample) => void;
  view: WorkbenchView;
};

function ComposerPanel({
  className,
  composerProps,
  composerRef,
}: Pick<WorkbenchContentProps, 'composerProps' | 'composerRef'> & { className?: string }) {
  return (
    <div className={className} ref={composerRef}>
      <Composer {...composerProps} />
    </div>
  );
}

function SkillShortcuts({ composerProps }: Pick<WorkbenchContentProps, 'composerProps'>) {
  const shortcutSkills = composerProps.catalog.skills;

  return (
    <div aria-label="常用 Skill" className="mt-3 flex flex-wrap justify-center gap-2">
      {shortcutSkills.map((skill) => {
        const selected = composerProps.value.selectedSkillId === skill.primary_skill_id;
        return (
          <Button
            aria-label={`使用 Skill：${skill.name}`}
            aria-pressed={selected}
            className={cn(
              'h-11 min-h-11 border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--foreground)] shadow-none',
              selected &&
                'border-[var(--brand)] bg-[var(--primary-soft)] text-[var(--primary-strong)]',
            )}
            key={skill.primary_skill_id}
            onClick={() =>
              composerProps.onChange({
                agentMode: 'image',
                attachmentRoles: {},
                selectedPresetIds: {},
                selectedSkillId: skill.primary_skill_id,
              })
            }
            type="button"
            variant="ghost"
          >
            <WandSparkles aria-hidden="true" size={16} strokeWidth={1.8} />
            {skill.name}
          </Button>
        );
      })}
    </div>
  );
}

export function WorkbenchContent({
  composerProps,
  composerRef,
  conversationProps,
  onSelectExample,
  view,
}: WorkbenchContentProps) {
  if (view === 'session') {
    return (
      <>
        <Conversation {...conversationProps} />
        <div className="fixed inset-x-0 bottom-[68px] z-20 bg-[var(--background)]/96 px-4 py-3 lg:bottom-0 lg:left-[408px]">
          <ComposerPanel
            className="mx-auto max-w-[960px]"
            composerProps={{ ...composerProps, compact: true }}
            composerRef={composerRef}
          />
        </div>
      </>
    );
  }

  if (view === 'session-new') {
    return (
      <div className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 pb-24 sm:px-7">
        <section className="content-enter w-full max-w-[960px] text-center">
          <h1 className="text-[30px] font-bold leading-[1.2] sm:text-[36px]">你好，想创作什么？</h1>
          <ComposerPanel
            className="mt-8 text-left"
            composerProps={composerProps}
            composerRef={composerRef}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-64px)] w-full max-w-[1180px] flex-col px-4 pb-10 pt-[clamp(48px,8vh,82px)] sm:px-7">
      <section className="content-enter mx-auto w-full max-w-[960px] text-center">
        <h1 className="text-[32px] font-bold leading-[1.35] sm:text-[36px]">象塑</h1>
        <p className="mx-auto mt-2.5 max-w-[620px] text-[16px] leading-7 text-[var(--muted-foreground)]">
          重塑物象，万千风格
        </p>
        <ComposerPanel
          className="mt-8 text-left"
          composerProps={composerProps}
          composerRef={composerRef}
        />
        <SkillShortcuts composerProps={composerProps} />
      </section>
      <div className="content-enter-delayed">
        <ExampleGallery availableSkills={composerProps.catalog.skills} onSelect={onSelectExample} />
      </div>
      <div className="mt-auto flex items-center justify-center gap-5 pt-9 text-xs text-[var(--subtle-foreground)]">
        <span className="flex items-center gap-1.5">
          <History aria-hidden="true" size={14} />
          草稿自动保存
        </span>
        <button
          className="flex cursor-pointer items-center gap-1.5 hover:text-[var(--foreground)]"
          type="button"
        >
          查看使用说明
          <ArrowUpRight aria-hidden="true" size={13} />
        </button>
      </div>
    </div>
  );
}
