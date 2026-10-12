import {
  CREATIVE_DIRECTION_AUTO_VERSION,
  parseCreativeDirectionSelection,
} from '@ecom-forge/shared/creative-direction';

import {
  getSkillAttachmentRoleOptions,
  resolveAttachmentRole,
} from '@/features/agent-workbench/attachment-roles';
import type { ComposerValue } from '@/features/agent-workbench/composer-types';
import { attachmentMentionKey } from '@/features/agent-workbench/mention-key';
import type { AgentCatalogState } from '@/features/agent-workbench/use-agent-catalogs';
import type { CreateTurnInput } from '@/lib/agent-api';

export class TurnPayloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TurnPayloadError';
  }
}

export function buildTurnPayload(input: {
  catalogs: AgentCatalogState;
  composer: ComposerValue;
  sessionId?: string;
  createBindingId?: (resourceId: string) => string;
}): CreateTurnInput {
  const { catalogs, composer } = input;
  const creativeDirection = parseCreativeDirectionSelection(
    composer.creativeDirection === undefined
      ? { mode: 'auto', version: CREATIVE_DIRECTION_AUTO_VERSION }
      : composer.creativeDirection,
  );
  if (!creativeDirection) {
    throw new TurnPayloadError('CREATIVE_DIRECTION_INVALID', '设计师选择已失效，请重新选择');
  }
  if (
    catalogs.status !== 'ready' ||
    !catalogs.skills ||
    !catalogs.brainModels ||
    !catalogs.imageModels
  ) {
    throw new TurnPayloadError('CATALOG_UNAVAILABLE', '创作目录尚未加载完成，请稍后重试');
  }
  const skill = catalogs.skills.items.find(
    (item) => item.primary_skill_id === composer.selectedSkillId,
  );
  if (!skill) throw new TurnPayloadError('SKILL_SELECTION_REQUIRED', '请选择一个 Skill 后再发送');
  const presetSelections = skill.preset_slots.flatMap((slot) => {
    const presetId = composer.selectedPresetIds[slot.slot];
    if (slot.required && !presetId) {
      throw new TurnPayloadError('PRESET_SELECTION_REQUIRED', `请选择${slot.label}`);
    }
    if (!presetId) return [];
    if (!slot.options.some((option) => option.preset_id === presetId)) {
      throw new TurnPayloadError('SKILL_SELECTION_INVALID', '所选风格已更新，请重新选择');
    }
    return [{ slot: slot.slot, preset_id: presetId }];
  });
  const brain = catalogs.brainModels.items.find(
    (item) => item.id === composer.selectedBrainModelId && item.availability === 'available',
  );
  const image = catalogs.imageModels.items.find(
    (item) => item.id === composer.selectedImageModelId && item.availability === 'available',
  );
  if (!brain || !image) {
    throw new TurnPayloadError('MODEL_SELECTION_REQUIRED', '请选择可用的推理模型和图片模型');
  }
  if (
    (composer.selectedBrainModelVersion != null &&
      composer.selectedBrainModelVersion !== brain.version_no) ||
    (composer.selectedImageModelVersion != null &&
      composer.selectedImageModelVersion !== image.version_no)
  ) {
    throw new TurnPayloadError('MODEL_CATALOG_STALE', '此会话原选模型已更新，请重新选择模型');
  }
  if (catalogs.brainModels.catalog_revision !== catalogs.imageModels.catalog_revision) {
    throw new TurnPayloadError('MODEL_CATALOG_STALE', '模型目录已更新，请刷新后重新选择');
  }
  const createBindingId = input.createBindingId ?? ((resourceId: string) => resourceId);
  const bindings = new Map<string, string>();
  const attachments = composer.attachments.map((attachment, position) => {
    if (!attachment.resourceType || !attachment.resourceVersion) {
      throw new TurnPayloadError(
        'REFERENCE_NOT_AVAILABLE',
        '示例图片仅用于启发，请上传图片或从资产库选择后再发送',
      );
    }
    const roleOptions = getSkillAttachmentRoleOptions(skill);
    const resolvedRole = resolveAttachmentRole(skill, composer.attachmentRoles[attachment.id]);
    if (roleOptions && resolvedRole === null) {
      throw new TurnPayloadError('ATTACHMENT_ROLE_REQUIRED', '请在附件区选择每张素材的用途');
    }
    const role =
      skill.domain === 'commerce' && position === 0
        ? ('product' as const)
        : (resolvedRole ?? ('composition_reference' as const));
    const bindingId = createBindingId(attachment.id);
    bindings.set(attachment.id, bindingId);
    return {
      binding_id: bindingId,
      resource_type: attachment.resourceType,
      resource_id: attachment.id,
      resource_version: attachment.resourceVersion,
      role,
      position,
    };
  });
  if (
    getSkillAttachmentRoleOptions(skill)?.some((option) => option.role === 'identity_anchor') &&
    attachments.filter((attachment) => attachment.role === 'identity_anchor').length !== 1
  ) {
    throw new TurnPayloadError(
      'ATTACHMENT_ROLE_REQUIRED',
      '人像焕新需要且仅需要一张素材作为身份主图',
    );
  }
  const requiresImage = skill.required_inputs.some((requirement) =>
    ['product_image', 'identity_anchor', 'semantic-reference', 'authorized-scene-photo'].includes(
      requirement,
    ),
  );
  if (!input.sessionId && requiresImage && attachments.length === 0) {
    throw new TurnPayloadError('REFERENCE_REQUIRED', '这个 Skill 需要至少一个图片附件');
  }
  const mention_bindings = composer.referencedAttachmentIds.map((attachmentId) => {
    const attachment = composer.attachments.find((item) => item.id === attachmentId);
    const bindingId = bindings.get(attachmentId);
    if (!attachment || !bindingId) {
      throw new TurnPayloadError('REFERENCE_NOT_AVAILABLE', '引用附件已移除，请重新选择');
    }
    return { mention_key: attachmentMentionKey(attachment.label), binding_id: bindingId };
  });
  return {
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    message: composer.prompt.trim(),
    attachments,
    mention_bindings,
    skill_selection: {
      primary_skill_id: skill.primary_skill_id,
      preset_selections: presetSelections,
    },
    model_selection: {
      catalog_revision: catalogs.brainModels.catalog_revision,
      brain: { catalog_entry_id: brain.id, version_no: brain.version_no },
      image: { catalog_entry_id: image.id, version_no: image.version_no },
    },
    generation_preferences: {
      schema_version: 2,
      output_kind: 'image',
      aspect_ratio: composer.aspectRatio,
      resolution_tier: composer.resolutionTier,
      creative_direction: creativeDirection,
    },
  };
}
