'use client';
import {
  CREATIVE_DIRECTION_AUTO_VERSION,
  parseCreativeDirectionSelection,
  type SessionCreativeDirectionSnapshot,
} from '@ecom-forge/shared/creative-direction';
import { CreativeDirectionMenu } from './creative-direction-menu';

import Image from 'next/image';
import { ArrowUp, Ratio, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { AttachmentStack } from '@/features/agent-workbench/attachment-stack';
import {
  getSkillAttachmentRoleOptions,
  resolveAttachmentRole,
} from '@/features/agent-workbench/attachment-roles';
import {
  AgentMenu,
  ModelMenu,
  ParameterMenu,
  PresetMenu,
  SkillMenu,
} from '@/features/agent-workbench/composer-menus';
import type {
  AgentMode,
  ComposerCatalog,
  ComposerValue,
  ImageRatio,
  VideoDuration,
  VideoResolution,
} from '@/features/agent-workbench/composer-types';
import type { ExampleAsset } from '@/features/agent-workbench/data';
import { attachmentMentionKey } from '@/features/agent-workbench/mention-key';
import type { AttachmentRole } from '@/lib/agent-api';
import { cn } from '@/lib/cn';

export type { AgentMode, ComposerValue, ImageRatio, VideoDuration, VideoResolution };

const MAX_PROMPT_CHARS = 2_000;
const imageRatios: ImageRatio[] = ['auto', '1:1', '3:4', '4:3', '9:16', '16:9'];
const videoDurations: VideoDuration[] = ['5 秒', '10 秒'];
const videoResolutions: VideoResolution[] = ['1080P', '720P'];

export type ComposerProps = {
  catalog: ComposerCatalog;
  compact?: boolean;
  continuation?: boolean;
  creditBalance?: string | null;
  disabled?: boolean;
  error?: string;
  skillLocked?: boolean;
  creativeDirectionSnapshot?: SessionCreativeDirectionSnapshot | undefined;
  onAddAttachment: () => void;
  onChange: (change: Partial<ComposerValue>) => void;
  onReferenceAttachment: (id: string) => void;
  onRemoveAttachment: (id: string) => void;
  onReloadCatalog: () => void;
  onSubmit: () => void;
  value: ComposerValue;
};

export function Composer({
  catalog,
  compact = false,
  continuation = false,
  creditBalance = null,
  disabled = false,
  error,
  onAddAttachment,
  onChange,
  onReferenceAttachment,
  onRemoveAttachment,
  onReloadCatalog,
  onSubmit,
  skillLocked = false,
  creativeDirectionSnapshot,
  value,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRegionRef = useRef<HTMLDivElement>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionMatch = mentionDismissed ? null : value.prompt.match(/(?:^|[^\w@])@([^@\s]*)$/u);
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase('zh-CN') ?? '';
  const mentionOptions = mentionMatch
    ? value.attachments.filter((attachment) =>
        attachment.label.toLocaleLowerCase('zh-CN').includes(mentionQuery),
      )
    : [];
  const activeMention = mentionOptions[activeMentionIndex];
  const mentionOpen = Boolean(mentionMatch && value.attachments.length > 0);

  useEffect(() => setActiveMentionIndex(0), [mentionQuery]);

  useEffect(() => {
    if (!mentionOpen) return undefined;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && mentionRegionRef.current?.contains(event.target)) return;
      closeMentions();
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [mentionOpen]);

  function closeMentions() {
    setMentionDismissed(true);
    setActiveMentionIndex(0);
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setMentionDismissed(false);
    onChange({ prompt: event.target.value });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen && mentionOptions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setActiveMentionIndex(
          (current) => (current + direction + mentionOptions.length) % mentionOptions.length,
        );
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentions();
        return;
      }
      if (event.key === 'Enter' && activeMention) {
        event.preventDefault();
        handleMention(activeMention);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (disabled || value.prompt.length > MAX_PROMPT_CHARS) return;
      onSubmit();
    }
  }

  function handleMention(attachment: ExampleAsset) {
    const mentionStart = value.prompt.lastIndexOf('@');
    onReferenceAttachment(attachment.id);
    onChange({
      prompt: `${value.prompt.slice(0, mentionStart)}${attachmentMentionKey(attachment.label)} `,
    });
    closeMentions();
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handleSkillChange(selectedSkillId: string) {
    onChange({
      agentMode: 'image',
      attachmentRoles: {},
      selectedPresetIds: {},
      selectedSkillId,
    });
  }

  const selectableSkills = catalog.skills;
  const selectedSkillPool = skillLocked ? catalog.skills : selectableSkills;
  const selectedSkill = selectedSkillPool.find(
    (skill) => skill.primary_skill_id === value.selectedSkillId,
  );
  const videoEnabled = catalog.videoModels.some((model) => model.availability === 'available');
  const requiredPresetsSelected =
    selectedSkill?.preset_slots.every(
      (slot) => !slot.required || Boolean(value.selectedPresetIds[slot.slot]),
    ) ?? false;
  const selectedModelsAvailable =
    catalog.brainModels.some(
      (model) =>
        model.id === value.selectedBrainModelId &&
        model.availability === 'available' &&
        (value.selectedBrainModelVersion == null ||
          model.version_no === value.selectedBrainModelVersion),
    ) &&
    catalog.imageModels.some(
      (model) =>
        model.id === value.selectedImageModelId &&
        model.availability === 'available' &&
        (value.selectedImageModelVersion == null ||
          model.version_no === value.selectedImageModelVersion),
    );
  const requiredAttachmentsSelected =
    continuation ||
    !selectedSkill?.required_inputs.length ||
    value.attachments.some((attachment) => attachment.resourceType && attachment.resourceVersion);
  const roleOptions = getSkillAttachmentRoleOptions(selectedSkill);
  const promptTooLong = value.prompt.length > MAX_PROMPT_CHARS;
  const noCredits = creditBalance !== null && /^0+(?:\.0+)?$/.test(creditBalance);
  const attachmentRolesComplete =
    !roleOptions ||
    roleOptions.length === 0 ||
    value.attachments.every(
      (attachment) =>
        resolveAttachmentRole(selectedSkill, value.attachmentRoles[attachment.id]) !== null,
    );
  const canSubmit =
    parseCreativeDirectionSelection(
      value.creativeDirection === undefined
        ? { mode: 'auto', version: CREATIVE_DIRECTION_AUTO_VERSION }
        : value.creativeDirection,
    ) !== null &&
    catalog.status === 'ready' &&
    (value.prompt.trim().length > 0 ||
      value.attachments.some(
        (attachment) => attachment.resourceType && attachment.resourceVersion,
      )) &&
    !promptTooLong &&
    !noCredits &&
    Boolean(selectedSkill) &&
    requiredPresetsSelected &&
    selectedModelsAvailable &&
    requiredAttachmentsSelected &&
    attachmentRolesComplete;

  return (
    <>
      <section
        aria-label="创作输入"
        className={cn(
          'composer-shell relative rounded-lg border bg-[var(--surface)]',
          error || catalog.status === 'error'
            ? 'border-[var(--danger)]'
            : 'border-[var(--border-strong)]',
        )}
      >
        <div className={cn('px-4 pt-3.5', compact ? 'pt-3' : 'sm:px-5 sm:pt-4')}>
          <div className="flex items-start gap-3">
            <AttachmentStack
              attachments={value.attachments}
              onAdd={onAddAttachment}
              onRemove={onRemoveAttachment}
            />
            <div className="relative min-w-0 flex-1" ref={mentionRegionRef}>
              <textarea
                aria-activedescendant={activeMention ? `mention-${activeMention.id}` : undefined}
                aria-controls={mentionOpen ? 'composer-mentions' : undefined}
                aria-describedby={
                  error
                    ? 'composer-error'
                    : promptTooLong
                      ? 'composer-prompt-limit'
                      : noCredits
                        ? 'composer-credit-limit'
                        : undefined
                }
                aria-label="创作输入"
                className={cn(
                  'max-h-[128px] min-w-0 w-full resize-none border-0 bg-transparent text-[15px] leading-[1.75] text-[var(--foreground)] outline-none [field-sizing:content] placeholder:text-[var(--subtle-foreground)]',
                  compact ? 'min-h-[48px]' : 'min-h-[96px]',
                )}
                disabled={disabled}
                maxLength={MAX_PROMPT_CHARS + 1}
                onChange={handleChange}
                onFocus={() => setMentionDismissed(false)}
                onKeyDown={handleKeyDown}
                placeholder={
                  value.agentMode === 'image'
                    ? '描述你想创造的画面、风格和用途…'
                    : '描述视频内容、镜头运动和节奏…'
                }
                ref={textareaRef}
                rows={3}
                value={value.prompt}
              />
              {promptTooLong ? (
                <p
                  aria-live="polite"
                  className="mt-1 text-xs font-medium text-[var(--danger)]"
                  id="composer-prompt-limit"
                >
                  超过2000字符，无法发送
                </p>
              ) : null}
              {noCredits ? (
                <p
                  aria-live="polite"
                  className="mt-1 text-xs font-medium text-[var(--danger)]"
                  id="composer-credit-limit"
                >
                  积分不足，当前余额为 0，无法发送
                </p>
              ) : null}
              {mentionOpen ? (
                <div
                  aria-label="引用当前附件"
                  className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-[min(320px,calc(100vw-64px))] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-md)]"
                  id="composer-mentions"
                  role="listbox"
                >
                  {mentionOptions.length ? (
                    mentionOptions.map((attachment, index) => (
                      <button
                        aria-selected={index === activeMentionIndex}
                        className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none hover:bg-[var(--soft)] focus-visible:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                        id={`mention-${attachment.id}`}
                        key={attachment.id}
                        onClick={() => handleMention(attachment)}
                        role="option"
                        type="button"
                      >
                        <span className="relative size-8 shrink-0 overflow-hidden rounded bg-[var(--soft)]">
                          <Image
                            alt=""
                            className="object-cover"
                            fill
                            sizes="32px"
                            src={attachment.imageUrl}
                            unoptimized={
                              attachment.imageUrl.startsWith('data:') ||
                              attachment.imageUrl.startsWith('/api/v1/')
                            }
                          />
                        </span>
                        <span className="truncate">@{attachment.label}</span>
                      </button>
                    ))
                  ) : (
                    <p className="px-2.5 py-2 text-sm text-[var(--muted-foreground)]">
                      没有匹配的附件
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          {roleOptions && roleOptions.length > 1 && value.attachments.length > 0 ? (
            <div aria-label="素材用途" className="mt-2 flex flex-wrap gap-2">
              {value.attachments.map((attachment) => (
                <label
                  className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--soft)] px-2 py-1 text-xs"
                  key={attachment.id}
                >
                  <span className="max-w-28 truncate text-[var(--muted-foreground)]">
                    {attachment.label}
                  </span>
                  <select
                    aria-label={`选择${attachment.label}的用途`}
                    className="cursor-pointer bg-transparent text-xs font-medium text-[var(--foreground)] outline-none"
                    onChange={(event) => {
                      onChange({
                        attachmentRoles: {
                          ...value.attachmentRoles,
                          [attachment.id]: event.target.value as AttachmentRole,
                        },
                      });
                    }}
                    value={value.attachmentRoles[attachment.id] ?? ''}
                  >
                    <option disabled value="">
                      选择用途
                    </option>
                    {roleOptions.map((option) => (
                      <option key={option.role} value={option.role}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : null}
        </div>

        {error || catalog.error ? (
          <div className="flex items-center justify-between gap-3 px-5 pb-2" id="composer-error">
            <p className="text-[13px] font-medium text-[var(--danger)]">{error || catalog.error}</p>
            {catalog.status === 'error' ? (
              <Button onClick={onReloadCatalog} size="sm" type="button" variant="ghost">
                <RefreshCw aria-hidden="true" size={14} />
                重新加载
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-1 px-2.5 pb-2 sm:px-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center">
            <AgentMenu
              onChange={(agentMode) =>
                onChange({
                  agentMode,
                  selectedSkillId: null,
                  selectedPresetIds: {},
                })
              }
              videoEnabled={videoEnabled}
              value={value.agentMode}
            />
            {value.agentMode === 'image' ? (
              <>
                <ParameterMenu
                  formatValue={(ratio) => (ratio === 'auto' ? '智能比例' : ratio)}
                  icon={<Ratio aria-hidden="true" className="hidden sm:block" size={16} />}
                  label="图片比例"
                  onChange={(aspectRatio) => onChange({ aspectRatio })}
                  options={imageRatios}
                  value={value.aspectRatio}
                />
                <ParameterMenu
                  formatValue={(tier) => tier.toUpperCase()}
                  label="图片清晰度"
                  onChange={(resolutionTier) => onChange({ resolutionTier })}
                  options={['1k', '2k', '4k'] as const}
                  value={value.resolutionTier}
                />
              </>
            ) : (
              <>
                <ParameterMenu
                  label="视频清晰度"
                  onChange={(videoResolution) => onChange({ videoResolution })}
                  options={videoResolutions}
                  value={value.videoResolution}
                />
                <ParameterMenu
                  formatValue={(ratio) => (ratio === 'auto' ? '智能比例' : ratio)}
                  icon={<Ratio aria-hidden="true" className="hidden sm:block" size={16} />}
                  label="视频比例"
                  onChange={(aspectRatio) => onChange({ aspectRatio })}
                  options={imageRatios}
                  value={value.aspectRatio}
                />
                <ParameterMenu
                  label="视频时长"
                  onChange={(videoDuration) => onChange({ videoDuration })}
                  options={videoDurations}
                  value={value.videoDuration}
                />
              </>
            )}
            <SkillMenu
              locked={skillLocked}
              onChange={handleSkillChange}
              skills={catalog.skills}
              value={value.selectedSkillId}
            />
            {selectedSkill && selectedSkill.preset_slots.length > 0 ? (
              <PresetMenu
                locked={skillLocked}
                onChange={(slot, presetId) =>
                  onChange({
                    selectedPresetIds: { ...value.selectedPresetIds, [slot]: presetId },
                  })
                }
                selected={value.selectedPresetIds}
                skill={selectedSkill}
              />
            ) : null}
            <ModelMenu
              brainModelId={value.selectedBrainModelId}
              brainModels={catalog.brainModels}
              imageModelId={value.selectedImageModelId}
              imageModels={catalog.imageModels}
              onBrainChange={(selectedBrainModelId) => onChange({ selectedBrainModelId })}
              onImageChange={(selectedImageModelId) => onChange({ selectedImageModelId })}
            />
            {value.agentMode === 'image' ? (
              <CreativeDirectionMenu
                disabled={disabled}
                locked={skillLocked}
                snapshot={creativeDirectionSnapshot}
                onChange={(creativeDirection) => onChange({ creativeDirection })}
                value={value.creativeDirection}
              />
            ) : null}
          </div>
          <Button
            aria-label="开始创作"
            className="ml-auto rounded-full shadow-none"
            disabled={disabled || !canSubmit}
            onClick={onSubmit}
            size="icon"
          >
            <ArrowUp aria-hidden="true" size={18} strokeWidth={2.2} />
          </Button>
        </div>
      </section>
    </>
  );
}
