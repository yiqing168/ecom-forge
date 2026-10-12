import type { ExampleAsset } from '@/features/agent-workbench/data';
import type { CreativeDirectionSelection } from '@ecom-forge/shared/creative-direction';
import type { AttachmentRole, ModelCatalogItem, SkillCatalogItem } from '@/lib/agent-api';

export type AgentMode = 'image' | 'video';
export type ImageRatio = 'auto' | '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
export type VideoDuration = '5 秒' | '10 秒';
export type VideoResolution = '1080P' | '720P';
export type ResolutionTier = '1k' | '2k' | '4k';

export type ComposerCatalog = {
  brainModels: ModelCatalogItem[];
  error: string;
  imageModels: ModelCatalogItem[];
  skills: SkillCatalogItem[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  videoModels: ModelCatalogItem[];
};

export type ComposerValue = {
  /** Null retains an invalid cached selection until the user explicitly chooses again. */
  creativeDirection?: CreativeDirectionSelection | null | undefined;
  agentMode: AgentMode;
  aspectRatio: ImageRatio;
  attachmentRoles: Record<string, AttachmentRole>;
  attachments: ExampleAsset[];
  prompt: string;
  referencedAttachmentIds: string[];
  resolutionTier: ResolutionTier;
  selectedBrainModelId: string | null;
  selectedBrainModelVersion?: number | null;
  selectedImageModelId: string | null;
  selectedImageModelVersion?: number | null;
  selectedPresetIds: Record<string, string>;
  selectedSkillId: string | null;
  videoDuration: VideoDuration;
  videoResolution: VideoResolution;
};
