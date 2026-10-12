export interface AdminPrincipal {
  id: string;
  identifierHint: string;
  displayName: string;
  status: 'active';
}

export interface AdminSession {
  principal: AdminPrincipal;
  permissions: string[];
  scopes: { roleKey: string; scopeType: string; scopeKey: string }[];
  csrf_token: string;
  mfa_level: string;
  recovery_restricted: boolean;
  step_up_expires_at: string | null;
  session_expires_at: string;
}

export interface AdminChallenge {
  challenge_id: string;
  challenge_token: string;
  expires_in_seconds: number;
  methods: ('totp' | 'recovery')[];
}

export class AdminApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export async function adminRequest<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-Admin-CSRF', csrfToken);
  const response = await fetch(`/api/v1/admin${path}`, {
    ...init,
    credentials: 'include',
    headers,
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = payload?.error?.code ?? 'ADMIN_REQUEST_FAILED';
    throw new AdminApiError(code, response.status, payload?.error?.message ?? code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function loadAllAdminPages<T>(
  request: (path: string) => Promise<{ items: T[]; next_cursor?: string | null }>,
  path: string,
  maxPages = 20,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const url = new URL(path, 'http://admin.local');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await request(`${url.pathname}${url.search}`);
    items.push(...page.items);
    cursor = page.next_cursor ?? null;
    if (!cursor) return items;
    if (seen.has(cursor)) throw new AdminApiError('ADMIN_CURSOR_INVALID', 400, 'cursor loop');
    seen.add(cursor);
  }
  throw new AdminApiError('ADMIN_RESULT_SET_TOO_LARGE', 409, 'result set exceeds admin limit');
}

const errorMessages: Record<string, string> = {
  ADMIN_REGISTRATION_REWARD_INVALID: '注册赠送积分必须是大于 0 的整数',
  INVITE_DISABLE_INVALID: '只能禁用未使用、未过期且没有注册占用的邀请码',
  ADMIN_AUTH_INVALID: '管理员账号或密码错误',
  ADMIN_AUTH_RATE_LIMITED: '尝试次数过多，请稍后再试',
  ADMIN_AUTH_UNAVAILABLE: '管理服务暂时不可用，请稍后重试',
  ADMIN_CHALLENGE_INVALID: '验证已失效，请重新登录',
  ADMIN_CSRF_INVALID: '安全校验已失效，请刷新页面后重试',
  ADMIN_CURSOR_INVALID: '分页条件已失效，请重新查询',
  ADMIN_RESULT_SET_TOO_LARGE: '可选记录过多，请先缩小查询范围',
  ADMIN_HOST_INVALID: '当前访问地址不在管理台允许范围内',
  ADMIN_MFA_INVALID: '动态验证码错误或已失效',
  ADMIN_NETWORK_GATE_DENIED: '当前网络不允许访问管理台',
  ADMIN_ORIGIN_INVALID: '请求来源未通过管理台安全校验',
  ADMIN_PERMISSION_DENIED: '当前管理员没有执行此操作的权限',
  ADMIN_REQUEST_FAILED: '管理服务暂时不可用，请稍后重试',
  ADMIN_SESSION_REQUIRED: '管理会话已失效，请重新登录',
  ADMIN_STEP_UP_REQUIRED: '此操作需要重新验证密码和动态验证码',
  ADMIN_STEP_UP_CANCELLED: '已取消安全验证',
  ADMIN_TOTP_INVALID: '动态验证码错误、已使用或已失效，请输入认证器中的下一组验证码',
  ADMIN_RESOURCE_NOT_FOUND: '没有找到对应记录，请刷新列表后重试',
  ADMIN_REVISION_CONFLICT: '记录已被其他操作更新，请刷新后重试',
  ADMIN_WRITE_FAILED: '保存失败，请稍后重试',
  INVITE_PLAINTEXT_UNAVAILABLE: '该邀请码当前不可复制；如仍需发放，请生成新的邀请码',
  BILLING_SKU_MARGIN_BELOW_MINIMUM: '用户积分低于成本与最低毛利要求，请提高积分后重试',
  BILLING_SKU_MODEL_UNSUPPORTED: '所选模型没有可用于定价的能力与成本快照',
  BILLING_SKU_SPEC_AMBIGUOUS: '所选规格不能唯一匹配 Provider 能力，请检查模式和分辨率',
  BILLING_SKU_UNIT_MISMATCH: '计费单位与 Provider 成本规格不一致',
  CONTENT_SAFETY_UNAVAILABLE: '内容安全能力尚未就绪，请先配置可用的 OpenAI 多模态对话模型',
  MODEL_CREDITS_INVALID: '积分配置不完整或格式不正确，请检查全部规格后重试',
  MODEL_CREDITS_NOT_SUPPORTED: '对话模型不需要配置图片或视频积分',
  MODEL_IMAGE_POC_BINDING_INVALID: '模型连接与生图协议不匹配，请检查用途和协议',
  MODEL_IMAGE_POC_CONTRACT_INVALID: '该模型不符合当前生图能力契约',
  MODEL_IMAGE_POC_OUTCOME_UNKNOWN: '生图能力校验结果未知，请稍后重试',
  MODEL_IMAGE_POC_OUTPUT_MISSING: '生图接口没有返回有效图片',
  MODEL_IMAGE_POC_PROVIDER_REJECTED: '生图接口拒绝了固定能力校验，请确认所选模型支持生图和改图',
  MODEL_IMAGE_POC_SPEC_MAPPING_INVALID: '该模型不支持首版所需的图片规格',
  MODEL_IMAGE_POC_SPEC_SET_INVALID: '生图能力规格不完整，请更换模型',
  MODEL_IMAGE_PROBE_FAILED: '该模型未通过生图能力校验',
  MODEL_IMAGE_PROBE_OUTCOME_UNKNOWN: '生图能力校验结果未知，请稍后重试',
  MODEL_IMAGE_PROBE_UNAVAILABLE: '暂时无法校验该模型的生图能力，请检查地址和模型后重试',
  MODEL_MODERATION_PROBE_DECISION_MISMATCH:
    '该模型未通过内容安全能力校验，请更换支持多模态审核的模型',
  MODEL_MODERATION_PROBE_OUTCOME_UNKNOWN: '内容安全能力校验结果未知，请稍后重试',
  MODEL_MODERATION_PROBE_UNAVAILABLE: '暂时无法校验该模型的内容安全能力，请检查地址和模型后重试',
  MODEL_PROTOCOL_PROVIDER_MISMATCH: '图片和视频模型当前仅支持 OpenAI 协议',
  MODEL_CATALOG_DEFAULT_CONFLICT: '该类别已有默认模型，请先调整现有默认项',
  MODEL_CATALOG_NOT_PUBLISHABLE: '模型尚未通过 PoC 或当前阶段不允许发布',
  PROVIDER_CREDENTIAL_REJECTED: 'API Key 无效或没有读取模型列表的权限',
  PROVIDER_MODEL_LIST_EMPTY: '接口没有返回可用模型',
  PROVIDER_MODEL_LIST_INVALID: '接口返回的模型列表格式不兼容',
  PROVIDER_MODEL_LIST_UNAVAILABLE: '暂时无法获取模型列表，请检查接口地址和网络',
  PROVIDER_MODEL_PROBE_TOKEN_INVALID: '模型探测结果已失效，请重新获取模型列表',
  PROVIDER_MODEL_SELECTION_INVALID: '所选模型已不可用，请重新获取模型列表',
  PRICING_RELEASE_CLOSURE_DRIFT: '发布内容与当前模型或成本配置已不一致，请重新创建发布草稿',
  PRICING_RELEASE_CLOSURE_INVALID: '发布内容不完整，请确认每个图片规格都有且仅有一个已批准积分 SKU',
  PRICING_RELEASE_DEFAULT_INVALID: '每个已选模型类别必须指定一个默认模型',
};

export function adminIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function adminErrorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    const mapped = errorMessages[error.code];
    if (mapped) return mapped;
    const serverMessage = error.message.trim();
    if (serverMessage && serverMessage !== error.code && serverMessage.length <= 200) {
      return serverMessage;
    }
    return '操作暂时无法完成，请稍后重试';
  }
  return '无法连接管理服务，请检查网络后重试';
}
