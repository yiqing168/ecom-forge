'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, LockKeyhole, Palette } from 'lucide-react';
import {
  CREATIVE_DIRECTION_CURRENT_VERSION,
  CREATIVE_DIRECTION_AUTO_VERSION,
  CREATIVE_DIRECTION_OPTIONS,
  parseCreativeDirectionSelection,
  type CreativeDirectionSelection,
  type SessionCreativeDirectionSnapshot,
} from '@ecom-forge/shared/creative-direction';
import { useRef } from 'react';

const options: readonly { selection: CreativeDirectionSelection; name: string; summary: string }[] =
  [
    {
      selection: { mode: 'auto', version: CREATIVE_DIRECTION_AUTO_VERSION },
      name: '自动',
      summary: '首次创作选择，本会话沿用',
    },
    { selection: { mode: 'native' }, name: 'Skill 原生', summary: '沿用当前 Skill 的方法' },
    ...CREATIVE_DIRECTION_OPTIONS.map((profile) => ({
      selection: {
        mode: 'profile' as const,
        profile_id: profile.id,
        version: CREATIVE_DIRECTION_CURRENT_VERSION,
      },
      name: profile.name,
      summary: profile.summary,
    })),
  ];

export function CreativeDirectionMenu({
  disabled,
  onChange,
  value,
  locked = false,
  snapshot,
}: {
  disabled?: boolean;
  onChange: (value: CreativeDirectionSelection) => void;
  value?: CreativeDirectionSelection | null | undefined;
  locked?: boolean;
  snapshot?: SessionCreativeDirectionSnapshot | undefined;
}) {
  const keyboardInteraction = useRef(false);
  const selection = parseCreativeDirectionSelection(
    snapshot?.selection ??
      (value === undefined ? { mode: 'auto', version: CREATIVE_DIRECTION_AUTO_VERSION } : value),
  );
  const currentKey = selectionKey(selection);
  const baseName =
    options.find((option) => selectionKey(option.selection) === currentKey)?.name ?? '重新选择';
  const resolvedName = CREATIVE_DIRECTION_OPTIONS.find(
    (item) => item.id === snapshot?.resolved_profile?.profile_id,
  )?.name;
  const name = selection?.mode === 'auto' && resolvedName ? `自动 · ${resolvedName}` : baseName;
  return (
    <DropdownMenu.Root
      key={locked ? 'locked' : 'editable'}
      modal={false}
      {...(locked ? { open: false } : {})}
    >
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={`设计师：${name}`}
          className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1 text-[12px] font-medium text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 sm:px-1.5"
          disabled={disabled || locked}
          onKeyDown={() => {
            keyboardInteraction.current = true;
          }}
          onPointerDown={() => {
            keyboardInteraction.current = false;
          }}
          title={
            locked
              ? `本会话设计师已固定，请新建会话更换${selection?.mode === 'auto' && selection.version !== 3 ? '（历史自动策略）' : ''}`
              : `设计师：${name}`
          }
          type="button"
        >
          <Palette aria-hidden="true" size={15} />
          <span className="hidden sm:inline">设计师：</span>
          {name}
          {locked ? (
            <LockKeyhole aria-hidden="true" size={12} />
          ) : (
            <ChevronDown aria-hidden="true" className="hidden sm:block" size={12} />
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          aria-label="设计师"
          className="z-[70] max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-md)]"
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            if (!keyboardInteraction.current) event.preventDefault();
          }}
          onKeyDown={() => {
            keyboardInteraction.current = true;
          }}
          onPointerDown={() => {
            keyboardInteraction.current = false;
          }}
          sideOffset={8}
        >
          <DropdownMenu.RadioGroup
            onValueChange={(key) => {
              const option = options.find((item) => selectionKey(item.selection) === key);
              if (option) onChange(option.selection);
            }}
            value={currentKey}
          >
            {options.map((option) => (
              <DropdownMenu.RadioItem
                className="relative flex min-h-12 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 pr-8 outline-none data-[highlighted]:bg-[var(--soft)] data-[state=checked]:bg-[var(--primary-soft)]"
                key={selectionKey(option.selection)}
                value={selectionKey(option.selection)}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.name}</span>
                  <span className="block text-xs text-[var(--muted-foreground)]">
                    {option.summary}
                  </span>
                </span>
                <DropdownMenu.ItemIndicator className="absolute right-2.5 text-[var(--primary)]">
                  <Check aria-hidden="true" size={15} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function selectionKey(selection: CreativeDirectionSelection | null) {
  return selection?.mode === 'profile' ? selection.profile_id : (selection?.mode ?? 'invalid');
}
