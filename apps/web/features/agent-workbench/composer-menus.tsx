'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bot, Check, ChevronDown, Images, Lock, Sparkles, Video } from 'lucide-react';
import { useRef, type ComponentProps, type ReactNode } from 'react';

import type { AgentMode } from '@/features/agent-workbench/composer-types';
import { cn } from '@/lib/cn';
import type { ModelCatalogItem, SkillCatalogItem } from '@/lib/agent-api';

const contentClassName =
  'z-[70] max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] min-w-36 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-md)]';
const itemClassName =
  'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm outline-none data-[highlighted]:bg-[var(--soft)]';

type CloseAutoFocusHandler = NonNullable<
  ComponentProps<typeof DropdownMenu.Content>['onCloseAutoFocus']
>;

function useMenuFocusMode() {
  const keyboardInteractionRef = useRef(false);
  const handleCloseAutoFocus: CloseAutoFocusHandler = (event) => {
    if (!keyboardInteractionRef.current) event.preventDefault();
  };

  return {
    handleCloseAutoFocus,
    markKeyboardInteraction: () => {
      keyboardInteractionRef.current = true;
    },
    markPointerInteraction: () => {
      keyboardInteractionRef.current = false;
    },
  };
}

export function ParameterMenu<T extends string>({
  formatValue = (option) => option,
  icon,
  label,
  onChange,
  options,
  value,
}: {
  formatValue?: (value: T) => string;
  icon?: ReactNode;
  label: string;
  onChange: (value: T) => void;
  options: readonly T[];
  value: T;
}) {
  const focusMode = useMenuFocusMode();
  const displayValue = formatValue(value);

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={`${label}：${displayValue}`}
          className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1 text-[12px] font-medium text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] sm:px-1.5"
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          type="button"
        >
          {icon}
          {displayValue}
          <ChevronDown aria-hidden="true" className="hidden sm:block" size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className={contentClassName}
          collisionPadding={12}
          onCloseAutoFocus={focusMode.handleCloseAutoFocus}
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          sideOffset={8}
        >
          <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-medium text-[var(--subtle-foreground)]">
            {label}
          </DropdownMenu.Label>
          {options.map((option) => (
            <DropdownMenu.Item
              className={cn(
                itemClassName,
                value === option && 'bg-[var(--primary-soft)] font-semibold',
              )}
              key={option}
              onSelect={() => onChange(option)}
            >
              <span>{formatValue(option)}</span>
              {value === option ? (
                <Check aria-hidden="true" className="ml-auto text-[var(--primary)]" size={15} />
              ) : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AgentMenu({
  onChange,
  videoEnabled,
  value,
}: {
  onChange: (value: AgentMode) => void;
  videoEnabled: boolean;
  value: AgentMode;
}) {
  const isImage = value === 'image';
  const CurrentIcon = isImage ? Images : Video;
  const label = isImage ? '智能生图 Agent' : '智能视频 Agent';
  const focusMode = useMenuFocusMode();

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={`选择创作 Agent：${label}`}
          className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-1 text-[12px] font-semibold text-[var(--foreground)] outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] sm:px-1.5"
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          type="button"
        >
          <CurrentIcon aria-hidden="true" className="text-[var(--primary)]" size={16} />
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{isImage ? '生图 Agent' : '视频 Agent'}</span>
          <ChevronDown aria-hidden="true" className="hidden sm:block" size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className={cn(contentClassName, 'min-w-52')}
          collisionPadding={12}
          onCloseAutoFocus={focusMode.handleCloseAutoFocus}
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          sideOffset={8}
        >
          <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-medium text-[var(--subtle-foreground)]">
            选择创作 Agent
          </DropdownMenu.Label>
          {(
            [
              { icon: Images, label: '智能生图 Agent', value: 'image' },
              ...(videoEnabled
                ? ([{ icon: Video, label: '智能视频 Agent', value: 'video' }] as const)
                : []),
            ] as const
          ).map((option) => {
            const OptionIcon = option.icon;
            return (
              <DropdownMenu.Item
                className={cn(
                  itemClassName,
                  'min-h-11 gap-2.5',
                  value === option.value && 'bg-[var(--primary-soft)] font-semibold',
                )}
                key={option.value}
                onSelect={() => onChange(option.value)}
              >
                <OptionIcon aria-hidden="true" size={16} />
                <span>{option.label}</span>
                {value === option.value ? (
                  <Check aria-hidden="true" className="ml-auto text-[var(--primary)]" size={15} />
                ) : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function SkillMenu({
  locked = false,
  onChange,
  skills,
  value,
}: {
  locked?: boolean;
  onChange: (value: string) => void;
  skills: SkillCatalogItem[];
  value: string | null;
}) {
  const selectableSkills = skills;
  const selectedSkillPool = locked ? skills : selectableSkills;
  const selectedSkill = selectedSkillPool.find((skill) => skill.primary_skill_id === value);
  const focusMode = useMenuFocusMode();

  if (locked) {
    return (
      <button
        aria-label={`当前会话 Skill：${selectedSkill?.name ?? '不可用'}，已锁定`}
        className="inline-flex min-h-10 shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap rounded-md px-1 text-[12px] font-medium text-[var(--foreground)] sm:px-1.5"
        title="当前会话已固定创作方向；新建会话后可切换"
        type="button"
      >
        <Sparkles aria-hidden="true" className="text-[var(--primary)]" size={16} />
        <span className="hidden md:inline">{selectedSkill?.name ?? 'Skill 不可用'}</span>
        <span className="md:hidden">{selectedSkill?.name ?? 'Skill'}</span>
        <Lock aria-hidden="true" size={12} />
      </button>
    );
  }

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={`选择 Skill：${selectedSkill?.name ?? '未选择'}`}
          className={cn(
            'inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-1 text-[12px] font-medium outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] sm:px-1.5',
            selectedSkill ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]',
          )}
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          type="button"
        >
          <Sparkles
            aria-hidden="true"
            className={selectedSkill ? 'text-[var(--primary)]' : undefined}
            size={16}
          />
          <span className="hidden md:inline">{selectedSkill?.name ?? '使用 Skill'}</span>
          <span className="md:hidden">{selectedSkill?.name ?? 'Skill'}</span>
          <ChevronDown aria-hidden="true" className="hidden sm:block" size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className={cn(contentClassName, 'min-w-52')}
          collisionPadding={12}
          onCloseAutoFocus={focusMode.handleCloseAutoFocus}
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          sideOffset={8}
        >
          <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-medium text-[var(--subtle-foreground)]">
            使用 Skill
          </DropdownMenu.Label>
          {selectableSkills.length === 0 ? (
            <DropdownMenu.Item
              className={cn(itemClassName, 'text-[var(--muted-foreground)]')}
              disabled
            >
              暂无可用 Skill
            </DropdownMenu.Item>
          ) : null}
          {selectableSkills.map((skill) => (
            <DropdownMenu.Item
              className={cn(
                itemClassName,
                'min-h-11 gap-2.5',
                value === skill.primary_skill_id && 'bg-[var(--primary-soft)] font-semibold',
              )}
              key={skill.primary_skill_id}
              onSelect={() => onChange(skill.primary_skill_id)}
            >
              <Sparkles aria-hidden="true" size={16} />
              <span>{skill.name}</span>
              {value === skill.primary_skill_id ? (
                <Check aria-hidden="true" className="ml-auto text-[var(--primary)]" size={15} />
              ) : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function PresetMenu({
  locked = false,
  onChange,
  selected,
  skill,
}: {
  locked?: boolean;
  onChange: (slot: string, presetId: string) => void;
  selected: Record<string, string>;
  skill: SkillCatalogItem;
}) {
  const focusMode = useMenuFocusMode();
  const names = skill.preset_slots.flatMap((slot) => {
    const selectedId = selected[slot.slot];
    const option = slot.options.find((item) => item.preset_id === selectedId);
    return option ? [option.name] : [];
  });
  if (locked) {
    return (
      <button
        aria-label={`当前会话风格：${names.join('、') || '不可用'}，已锁定`}
        className="inline-flex min-h-10 shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded-md px-1 text-[12px] font-medium text-[var(--muted-foreground)] sm:px-1.5"
        title="当前会话已固定创作方向；新建会话后可切换"
        type="button"
      >
        {names.join('、') || '风格不可用'}
        <Lock aria-hidden="true" size={12} />
      </button>
    );
  }
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={`选择风格：${names.join('、') || '未选择'}`}
          className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1 text-[12px] font-medium text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] sm:px-1.5"
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          type="button"
        >
          {names.join('、') || '选择风格'}
          <ChevronDown aria-hidden="true" className="hidden sm:block" size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className={cn(contentClassName, 'min-w-64')}
          collisionPadding={12}
          onCloseAutoFocus={focusMode.handleCloseAutoFocus}
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          sideOffset={8}
        >
          {skill.preset_slots.map((slot) => (
            <DropdownMenu.Group key={slot.slot}>
              <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-medium text-[var(--subtle-foreground)]">
                {slot.label}
              </DropdownMenu.Label>
              {slot.options.map((option) => (
                <DropdownMenu.Item
                  className={cn(
                    itemClassName,
                    'min-h-11',
                    selected[slot.slot] === option.preset_id &&
                      'bg-[var(--primary-soft)] font-semibold',
                  )}
                  key={option.preset_id}
                  onSelect={() => onChange(slot.slot, option.preset_id)}
                >
                  <span className="min-w-0">
                    <span className="block">{option.name}</span>
                    <span className="mt-0.5 block max-w-72 whitespace-normal text-xs font-normal text-[var(--muted-foreground)]">
                      {option.description}
                    </span>
                  </span>
                  {selected[slot.slot] === option.preset_id ? (
                    <Check
                      aria-hidden="true"
                      className="ml-auto shrink-0 text-[var(--primary)]"
                      size={15}
                    />
                  ) : null}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function modelLabel(models: ModelCatalogItem[], id: string | null): string {
  return models.find((item) => item.id === id)?.display_name ?? '选择模型';
}

export function ModelMenu({
  brainModelId,
  brainModels,
  imageModelId,
  imageModels,
  onBrainChange,
  onImageChange,
}: {
  brainModelId: string | null;
  brainModels: ModelCatalogItem[];
  imageModelId: string | null;
  imageModels: ModelCatalogItem[];
  onBrainChange: (id: string) => void;
  onImageChange: (id: string) => void;
}) {
  const focusMode = useMenuFocusMode();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={`选择模型：${modelLabel(imageModels, imageModelId)}`}
          className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1 text-[12px] font-medium text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] sm:px-1.5"
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          type="button"
        >
          <Bot aria-hidden="true" size={15} />
          {modelLabel(imageModels, imageModelId)}
          <ChevronDown aria-hidden="true" className="hidden sm:block" size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className={cn(contentClassName, 'min-w-72')}
          collisionPadding={12}
          onCloseAutoFocus={focusMode.handleCloseAutoFocus}
          onKeyDown={focusMode.markKeyboardInteraction}
          onPointerDown={focusMode.markPointerInteraction}
          sideOffset={8}
        >
          {(
            [
              ['推理模型', brainModels, brainModelId, onBrainChange],
              ['图片模型', imageModels, imageModelId, onImageChange],
            ] as const
          ).map(([label, models, selectedId, onChange]) => (
            <DropdownMenu.Group key={label}>
              <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-medium text-[var(--subtle-foreground)]">
                {label}
              </DropdownMenu.Label>
              {models.map((model) => (
                <DropdownMenu.Item
                  className={cn(
                    itemClassName,
                    'min-h-11',
                    selectedId === model.id && 'bg-[var(--primary-soft)] font-semibold',
                    model.availability !== 'available' && 'cursor-not-allowed opacity-55',
                  )}
                  disabled={model.availability !== 'available'}
                  key={model.id}
                  onSelect={() => onChange(model.id)}
                >
                  <span className="min-w-0">
                    <span className="block">{model.display_name}</span>
                    <span className="mt-0.5 block max-w-72 truncate text-xs font-normal text-[var(--muted-foreground)]">
                      {model.availability === 'available' ? model.description : '暂不可用'}
                    </span>
                  </span>
                  {selectedId === model.id ? (
                    <Check
                      aria-hidden="true"
                      className="ml-auto shrink-0 text-[var(--primary)]"
                      size={15}
                    />
                  ) : null}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
