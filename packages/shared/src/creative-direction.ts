export const CREATIVE_DIRECTION_PROFILE_IDS = [
  'human-story',
  'visual-metaphor',
  'spatial-drama',
  'color-expression',
  'graphic-order',
  'material-experiment',
] as const;

export type CreativeDirectionProfileId = (typeof CREATIVE_DIRECTION_PROFILE_IDS)[number];
export type CreativeDirectionVersion = 1 | 2;
export const CREATIVE_DIRECTION_CURRENT_VERSION = 2 as const;
export const CREATIVE_DIRECTION_AUTO_VERSION = 3 as const;
export type CreativeDirectionSelection =
  | { mode: 'native' }
  | { mode: 'auto'; version: CreativeDirectionVersion | 3 }
  | { mode: 'profile'; profile_id: CreativeDirectionProfileId; version: CreativeDirectionVersion };

export const CREATIVE_DIRECTION_OPTIONS = [
  { id: 'human-story', name: '人文叙事', summary: '动作、人物关系、悬念与幽默' },
  { id: 'visual-metaphor', name: '视觉隐喻', summary: '形状关联、用途反转与意外发现' },
  { id: 'spatial-drama', name: '空间戏剧', summary: '视点、尺度、透视与空间错觉' },
  { id: 'color-expression', name: '色形表现', summary: '色彩、轮廓、节奏与情绪' },
  { id: 'graphic-order', name: '图形秩序', summary: '视觉主张、信息层级与符号提炼' },
  { id: 'material-experiment', name: '材料实验', summary: '材质行为、触感与物理变化' },
] as const satisfies readonly { id: CreativeDirectionProfileId; name: string; summary: string }[];

/** Strict, browser-safe validation of the public selection, not of creative content. */
export function parseCreativeDirectionSelection(value: unknown): CreativeDirectionSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (row.mode === 'native' && keys.length === 1) return { mode: 'native' };
  const version = row.version;
  if (row.mode === 'auto' && keys.length === 2 && (version === 1 || version === 2 || version === 3))
    return { mode: 'auto', version };
  if (version !== 1 && version !== 2) return null;
  if (
    row.mode === 'profile' &&
    keys.length === 3 &&
    CREATIVE_DIRECTION_PROFILE_IDS.some((id) => id === row.profile_id)
  ) {
    return {
      mode: 'profile',
      profile_id: row.profile_id as CreativeDirectionProfileId,
      version,
    };
  }
  return null;
}

export interface SessionCreativeDirectionSnapshot {
  schema_version: 1;
  selection: CreativeDirectionSelection;
  resolved_profile?: Extract<CreativeDirectionSelection, { mode: 'profile' }>;
  resolution_turn_id?: string;
  resolution_step_id?: string;
}

export function createSessionCreativeDirectionSnapshot(
  selection: unknown,
): SessionCreativeDirectionSnapshot {
  const parsed = parseCreativeDirectionSelection(selection ?? { mode: 'native' });
  if (!parsed) throw new Error('SESSION_CREATIVE_DIRECTION_INVALID');
  return { schema_version: 1, selection: parsed };
}

export function parseSessionCreativeDirectionSnapshot(
  value: unknown,
): SessionCreativeDirectionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const allowed = [
    'schema_version',
    'selection',
    'resolved_profile',
    'resolution_turn_id',
    'resolution_step_id',
  ];
  if (row.schema_version !== 1 || Object.keys(row).some((key) => !allowed.includes(key)))
    return null;
  const selection = parseCreativeDirectionSelection(row.selection);
  if (!selection) return null;
  const hasResolution = ['resolved_profile', 'resolution_turn_id', 'resolution_step_id'].some(
    (key) => key in row,
  );
  if (!hasResolution) return { schema_version: 1, selection };
  const profile = parseCreativeDirectionSelection(row.resolved_profile);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    selection.mode !== 'auto' ||
    selection.version !== 3 ||
    profile?.mode !== 'profile' ||
    profile.version !== 2 ||
    typeof row.resolution_turn_id !== 'string' ||
    !uuid.test(row.resolution_turn_id) ||
    typeof row.resolution_step_id !== 'string' ||
    !uuid.test(row.resolution_step_id)
  )
    return null;
  return {
    schema_version: 1,
    selection,
    resolved_profile: profile,
    resolution_turn_id: row.resolution_turn_id,
    resolution_step_id: row.resolution_step_id,
  };
}

export function effectiveCreativeDirection(
  snapshot: SessionCreativeDirectionSnapshot,
): CreativeDirectionSelection {
  return snapshot.resolved_profile ?? snapshot.selection;
}
