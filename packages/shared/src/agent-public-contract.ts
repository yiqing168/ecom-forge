// Only fixed, user-safe explanations belong here, never provider diagnostics.
export const AGENT_BRAIN_FAILURE_SUMMARIES = {
  rateLimit: '推理模型请求过于频繁，本轮已停止；请稍后重新发送，或更换推理模型',
  timeout: '推理模型响应超时，本轮已停止；请稍后重新发送，或更换推理模型',
  network: '与推理模型的连接异常，未取得完整响应；请稍后重新发送，或更换推理模型',
  context: '本次内容超过推理模型容量；请减少图片或对话内容后重新发送',
  configuration: '推理模型通道配置异常，本轮已停止；请更换推理模型或联系管理员',
  quota: '推理模型通道额度不足，本轮已停止；请更换推理模型或联系管理员',
  request: '推理模型未接受本次请求，本轮已停止；请更换推理模型，若仍失败请联系管理员',
  service: '推理模型服务暂时异常，本轮已停止；请稍后重新发送，或更换推理模型',
  response: '推理模型返回内容不完整或格式异常，本轮已停止；请重新发送，或更换推理模型',
  stream: '推理模型响应中途异常结束，未取得完整结果；请稍后重新发送，或更换推理模型',
  content: '推理模型未通过本次内容检查，本轮已停止；请调整描述或图片后重新发送',
  unknown: '未取得推理模型的完整响应，具体原因尚未确认；请稍后重新发送，或更换推理模型',
} as const;

export const AGENT_IMAGE_FAILURES = {
  failed: {
    public_error_code: 'AGENT_IMAGE_GENERATION_FAILED',
    summary: '图片生成失败，本次冻结的积分已全额退回；请重新发起生成',
  },
  unknownReleased: {
    public_error_code: 'AGENT_IMAGE_OUTCOME_UNKNOWN_RELEASED',
    summary: '图片生成结果未能确认，本次冻结的积分已全额退回；重新生成可能产生重复图片',
  },
} as const;

export const AGENT_PUBLIC_SUMMARIES = [
  ...Object.values(AGENT_BRAIN_FAILURE_SUMMARIES),
  ...Object.values(AGENT_IMAGE_FAILURES).map((failure) => failure.summary),
  '当前尝试已停止，请补充信息或调整要求后重试',
  '当前对话的模型预算已用尽，请开始新的请求',
  '生成计划暂时不能安全提交，请稍后重试',
  '相同能力被重复调用，当前尝试已停止',
  '所选 Skill 已更新，请刷新后重新选择',
  '当前对话预算已用尽，请开始新的请求',
  '当前状态不允许使用该能力',
  '当前选择的技能不支持这类生成操作，请在底部切换主技能后重试',
  '本次生成所需积分超过当前可用余额，未开始生成；请减少生成数量或联系管理员补充积分后重试',
  '当前并发任务已满；请稍后重新发起',
  '当前价格暂不可用；请稍后重试',
  '创作助手暂时不可用，请稍后重试',
  '所选生图模型暂时不可用，请稍后重试或选择其他生图模型',
  '所选知识内容超过当前运行限制，请减少范围后重试',
  '创作方案未能形成完整结构，本轮已停止，请重新发送要求',
  '本次处理未能恢复，已停止，请重新发送需求',
  '创作助手暂时无法生成安全回复，请稍后重试',
  '模型连续返回无效输出，已停止本轮处理，请重新发送需求',
  '当前请求内容超过模型上下文限制，请减少内容后重试',
  '本轮工具调用批次不符合要求，已停止，请重新发送要求',
  '相同图片查看请求重复过多，当前尝试已停止',
  '内容未通过安全审核，无法继续生成。',
  '内容安全审核暂时无法完成，请稍后重试。',
  // These already-persisted public variants remain replayable.
  '积分余额不足；请充值后重新发起',
  '生成要求还不够明确，请补充描述后重试',
  '已选择只处理最近上传的照片，本次计划仍包含其他上传组；请重新说明要处理的照片',
  '引用内容当前不可用，请移除后重试',
  '生成计划暂时无法安全执行，请稍后重试',
  '平台规则正在更新，请稍后重试',
  '当前模型暂不可用，请更换模型或稍后重试',
  '当前入口不能修改该内容，请创建新图片',
  '创作能力已更新，请重新选择后再试',
  '还需要补充一些创作要求',
  '生成步骤暂时无法安全组合，请调整要求后重试',
  '暂时无法获取积分价格，请稍后重试',
  '生成计划暂时无法安全执行，请调整要求后重试',
] as const;

export const AGENT_PUBLIC_ERROR_CODES = [
  ...Object.values(AGENT_IMAGE_FAILURES).map((failure) => failure.public_error_code),
  'AGENT_LOOP_LIMIT_EXCEEDED',
  'AGENT_REPEATED_TOOL_CALL',
  'AGENT_NO_PROGRESS_LOOP',
  'AGENT_REPEATED_TOOL_ERROR',
  'AGENT_BUDGET_EXCEEDED',
  'AGENT_CONTEXT_UNAVAILABLE',
  'AGENT_COMPILER_UNAVAILABLE',
  'AGENT_MODEL_UNAVAILABLE',
  'AGENT_TOOL_NOT_ALLOWED',
  'INSUFFICIENT_CREDITS',
  'CONCURRENCY_LIMIT_EXCEEDED',
  'COST_MODEL_UNAVAILABLE',
  'AGENT_CONFIRMATION_NOT_AVAILABLE',
  'AGENT_CONFIRMATION_EXPIRED',
  'SKILL_VERSION_DRIFT',
  'SKILL_RESOURCE_LIMIT_EXCEEDED',
  'REFERENCE_NOT_AVAILABLE',
  'CONTENT_SAFETY_UNAVAILABLE',
  'CONTENT_SAFETY_BLOCKED',
] as const;

export const AGENT_GUARDRAIL_TYPES = [
  'round_budget',
  'tool_budget',
  'repeated_tool_call',
  'no_progress',
  'repeated_error',
  'token_budget',
  'invalid_model_output',
  'cost_budget',
  'pricing_drift',
  'public_text_policy',
  'content_safety',
] as const;

export type AgentPublicSummary = (typeof AGENT_PUBLIC_SUMMARIES)[number];
export type AgentPublicErrorCode = (typeof AGENT_PUBLIC_ERROR_CODES)[number];
export type AgentGuardrailType = (typeof AGENT_GUARDRAIL_TYPES)[number];
