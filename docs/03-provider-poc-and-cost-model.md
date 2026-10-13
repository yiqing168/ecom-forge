# 03 Provider PoC 与成本模型

### 图片传输故障诊断（2026-10-13）

图片 `outcome_unknown` 可附内部 `transport_diagnostic`：区分 `response_headers`、`response_body`、`output_headers`、`output_body` 和宿主 `dispatch` 阶段，记录阶段/总耗时、本地 abort/deadline 标志、可信 HTTP status 与静态白名单异常名/底层网络代码。cause 最多遍历四层并防循环；禁止原始 message、stack、URL、header、prompt 或图片内容。诊断结构由 Provider schema 校验，Worker 持久化到 attempt 安全错误摘要，并在结构化完成日志关联 trace/run/task/attempt 与已取得的 Provider request ID；未取得响应头时明确不能声称拥有上游 request ID。调用开始也记录关联 ID，便于识别未返回或进程退出的请求。

诊断不改变三态、计费或重投规则；连接中断不能推断上游失败或未送达，不增加自动生图重试。中转后台显示成功并不证明本系统已收到结果；旧记录没有底层诊断时不得补造原因。

| 项       | 内容                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 状态     | v0.7 1A 生成动作与 Provider 前积分核对边界回写后可复审                    |
| 基准     | PRD v1.11                                                                 |
| 完成节点 | 与 `01`、`02` 并行，进入可收费功能编码前完成                              |
| 裁决范围 | Provider 能力探测、模型回执、配额、成本、Workflow 候选与 Plan B、PoC 脚本 |
| 不裁决   | 业务状态机、正式表结构、UI 流程                                           |

## 1. 目标

阶段 0 必须用真实 API 验证首批模型，而不是只看文档或宣传页。未通过能力契约的模型不得进入可收费路由。

1A 最低要求：

- 1 个图片生成模型通过 PoC。
- 1 个指令编辑模型通过 PoC。
- 能记录真实单次成本、错误分类、配额和回执行为。
- 能产出模型能力契约，供模型注册表和 Skill 使用。

## 2. Provider 候选范围

| 类型              | 候选                                  | 阶段 0 目标                                                            |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| 海外图片/编辑模型 | 支持 OpenAI Images 协议的合规中转通道 | 验证接入速度、成本、回执、参考图和编辑质量                             |
| 国内图片/编辑模型 | 即梦、通义万相、可灵等                | 验证企业资质、地区限制、风控、配额和 API 稳定性                        |
| Agent 大脑模型    | OpenAI/Claude/国内对话模型等          | 验证 tool-calling、结构化输出、上下文窗口、延迟、token 成本和降级      |
| 内容审核          | 数美、网易易盾、阿里绿网等            | 阶段 0 必须完成至少一套文本/图片审核链路 PoC，作为 1A 生成闭环上线门禁 |
| 视频模型          | 可灵、Runway、Pika 等                 | 阶段 1B 前单独 PoC，不进入 1A 收费路由                                 |

最终接入列表由本文件的 PoC 结果和产品确认共同决定。

S11 首个真实 Agent Brain 支持管理员配置的合规中转通道：

- Brain 协议族允许 `openai`、`anthropic`、`google`，API 变体分别为 `openai_chat_completions | openai_responses`、`anthropic_messages`、`google_generate_content`。Google 仅用于文本/图片输入的多模态 Agent Brain，不新增生图、视频或审核执行能力。图片/编辑仍只允许 `openai_images`；S12 文本/图片审核仍固定使用 `openai + openai_responses`。视频在对应阶段 SPEC 激活前不得进入可执行收费路由。
- OpenAI Images 的生图 JSON 与改图 multipart 请求统一默认 `quality=high`（2026-10-09 用户确认），由 Provider typed runtime defaults 管理，不新增环境变量、前端参数或管理台选项。质量档与 `size`/清晰度档独立，不修改积分配置；真实模型/中转支持与成本仍需实测，不支持时不得静默改为 `auto` 或低档，也不得因未知结果自动重投。
- `provider_channel` 保存服务端批准的 HTTPS relay base URL、adapter/profile、region 与加密 credential；base URL 只允许来自服务端 relay-origin allowlist，path、header、请求 JSON 和 TLS/网络策略由 adapter 控制，不能成为用户或请求方的任意输入。
- 管理员可在控制面为同一 channel 创建多个精确 model snapshot。每个 snapshot 固定协议变体、model ID/version、能力、价格、配额、PoC 证据和 channel/credential 绑定；别名、版本漂移和按名称猜测均 fail closed。
- Agent Brain 通过 Vercel AI SDK 调用，关闭 SDK retry；每个 AgentBrain step 最多一次网络请求，不让 SDK 接管 S08 工具循环。Responses/Chat/Anthropic/Google 结果必须归一化到现有 strict terminal/tool outcome 契约；缺失可信 usage、解析失败或网络结果未知均按 `outcome_unknown` 收敛。
- Brain 失败诊断必须区分请求异常与响应流内异常；HTTP 200 不代表 SSE 内没有上游错误。仅保存有界、白名单化的异常类别、上游错误类型/代码、底层连接原因码，以及错误正文的 UTF-8 字节数和 digest；不保存原始 message、body、stack、请求参数、Key 或 URL。可沿最多四层 cause 读取安全分类，未知类别仍记录为未分类，不猜测成功或未送达。诊断更细不改变 `outcome_unknown` 的费用、终止和禁止自动重投规则。
- 诊断使用可选结构化 `failureSource=request|stream|response`、`providerErrorType`、`providerErrorCode`、`networkErrorCode`；后三项只输出 adapter 静态白名单命中值，未知值不输出。宿主只依据这些字段、受控 diagnostic code 与可信 HTTP status 选择 `06` 的固定公开摘要，不解析 detail 或原始 message 猜测原因；诊断字段本身不进入公网事件。
- Google Brain 的模型发现沿用 relay 的 OpenAI 格式：Bearer header、`GET /v1/models`、`data[].id`，不切到 Google 原生模型列表。推理独立使用 `google_generate_content` 与 `x-goog-api-key`：标准列表根 `/v1` 映射为 `/v1beta`，显式 relay 路径前缀保留，只替换末尾的 `/v1`。不按模型名猜协议、不自动 fallback，也不发送 OpenAI reasoning effort。仅接入文本/图片输入与工具调用，不调用 Google 生图接口。
- Google 工具调用的 `thoughtSignature` 是不透明协议数据，不是可展示的推理文本。适配器仅保留批准的 Google 签名字段，随有序调用存入服务端 transcript，参与完整性校验，并在后续调用和重启恢复时原样回传；不得写日志、公开响应、摘要或创意提示词。没有签名时不伪造签名、不使用跳过验证占位值。
- 终局工具仍只允许平台注册的 `load_skill` 或 `agent_respond | agent_request_clarification | agent_candidate_plan`。模型选择由用户在已发布 catalog 中确定，整轮固定；不自动 fallback、换模或静默重试。
- actual cost 按各协议可信 usage 与 immutable pricing snapshot 计算；调用前 exposure 继续按保守上界预留。
- S12 审核调用复用 Vercel AI SDK 的 OpenAI Responses provider，但使用独立 moderation adapter：固定无工具 system policy、strict decision schema、最多一次请求且 SDK retry 关闭。它不能进入 Agent 工具循环，也不能接受管理员/用户 prompt、URL、header 或 response schema；文本/图片 capability、模型、credential、策略和成本快照仍由 S12 runtime pointer 裁决。

协议字段依据 OpenAI 官方 Responses API、Function calling 与 Structured outputs 文档核对：

- <https://developers.openai.com/api/reference/resources/responses/methods/create>
- <https://developers.openai.com/api/docs/guides/function-calling>
- <https://developers.openai.com/api/docs/guides/structured-outputs>

S07 开始真实 adapter 编码前必须冻结协议/厂商、精确模型版本、审核服务、relay origin/region、账号资质、回调/轮询能力和受控预算。未完成选择时只允许实现 Provider Gateway/fake/恢复底座，不能以通用任意 URL adapter 或宣传页参数代替真实 PoC。

## 3. 能力契约

每个模型必须形成版本化能力契约：

```json
{
  "provider": "string",
  "model_id": "string",
  "model_version": "string",
  "capability_contract_version": "string",
  "capabilities": ["text_to_image", "image_to_image", "image_edit"],
  "supported_ratios": ["1:1", "3:4", "16:9"],
  "supported_resolutions": ["1024x1024"],
  "max_reference_images": 3,
  "max_prompt_characters": 32000,
  "supports_async": true,
  "supports_webhook": false,
  "supports_polling": true,
  "provider_request_id_field": "string",
  "timeout_seconds": 300,
  "rate_limit": {
    "rpm": 60,
    "concurrency": 5
  },
  "region_restrictions": [],
  "business_verification": {
    "real_name_required": true,
    "enterprise_verified": false,
    "contract_status": "not_started | reviewing | approved"
  },
  "content_policy_summary": "string",
  "pricing": {
    "currency": "CNY",
    "unit_cost": "0.00",
    "billing_unit": "per image"
  },
  "status": "poc_passed | poc_failed | disabled | free_test_only"
}
```

该契约进入 `models.capability_contract_json`，字段细节由 `05` 裁决。

### 媒体规格与 Provider rate card v2

S07 已实现的 `media@v1` 单一 `provider_unit_cost_cny` 只用于既有历史快照和测试夹具。它不能表达同一模型 1K/2K/4K、不同图片操作、视频分辨率/时长/音频的差异成本。S14 新建并准备进入产品目录的媒体模型必须使用 `media@v2 + media_rate_card@v2`；历史 v1 row 保持可读，不原地升级。

图片标准档统一为 `1k|2k|4k`。2026-10-09 按用户提供的尺寸表修正：档位表示总像素预算，不表示固定短边；1K 为 `1024²`，2K 为 `2048²`，4K 为 `3840×2160`。比例先约分为互质的 `a:b`，以 `k=16×floor(sqrt(P/(a×b))/16)` 计算共同缩放单位，输出 `a×k` 与 `b×k`，保持精确比例和 16 像素步长。最大边长 3840、最小面积 655360 及宿主最大像素限制均须满足，否则 Provider 前拒绝，不为适应限制偷偷缩图。当前产品提供的 `1:1|3:4|4:3|16:9|9:16` 三档结果必须逐项匹配用户尺寸表；不加入未开放比例的特殊尺寸分支，不声称该公式复现表中 4K 超宽例外。算法、typed 常量与请求绑定只在 Provider 层维护，Compiler 按像素计费复用同一计算函数，Web/Brain/Worker 不复制公式。

该表仅作为用户确认的尺寸规则，不代替当前模型/中转的真实支持证据；模型 ID 仍按管理员配置原样发送，不按清晰度自动追加 `-4k`。相同操作的 1K 真实基线证据允许 2K/4K 规格执行，不把该证据描述成高档位实测通过。管理台保存新价格时可创建当前内置规格的新快照，但必须复核相同模型/通道/凭据的 passed 基线且 1K 规格完全一致；仅复用基线证据并记录来源，不改写历史模型/PoC/目录快照，不沿用旧 3K 积分。

宿主将当前 `storageMaxImagePixels` 作为 Compiler context 的 `policies.max_image_pixels` 传入，并随报价策略快照和 input signature 固定。所有 media-v2 图片节点（按张或按像素计费）都必须在报价、预留前用同一尺寸函数校验实际比例和档位；超限返回 `model_not_approved / image_dimensions_unavailable`，不得缩图或生成 quote。非图片上下文可不提供该字段。Dispatcher 仍复核当前限制，但只为本次选定的规格和比例构造绑定，不能让未选中的高档位或比例阻断合法低档位请求。

能力契约使用 strict discriminated union。每个可执行规格必须有稳定 `spec_key`，并由编译期 adapter registry 映射为允许的 Provider 参数；运营台只能提交服务端批准的 relay base URL，不能填写任意 URL、header 或 request JSON。图片规格示例：

```json
{
  "schema_version": 2,
  "contract_kind": "media",
  "media_kind": "image",
  "capabilities": ["image.generate", "image.edit", "upscale"],
  "specs": [
    {
      "kind": "image",
      "spec_key": "generate-quality-2k",
      "operation": "image.generate",
      "mode": "quality",
      "resolution_tier": "2k",
      "aspect_ratios": ["1:1", "3:4", "4:3", "16:9"],
      "max_outputs": 4,
      "max_reference_images": 3,
      "transparent_background": false,
      "output_formats": ["png", "webp"]
    }
  ]
}
```

视频规格示例只用于 S14 建档和 S16 PoC，不表示 1A 已开放执行：

```json
{
  "kind": "video",
  "spec_key": "generate-standard-1080p-audio",
  "operation": "video.generate",
  "mode": "standard",
  "resolution_tier": "1080p",
  "aspect_ratios": ["16:9", "9:16"],
  "fps": [24, 30],
  "audio": true,
  "duration": { "mode": "range", "min_seconds": 5, "max_seconds": 10, "step_seconds": 1 },
  "max_outputs": 1,
  "max_reference_images": 2
}
```

Provider 成本必须使用与能力规格一一对应的 rate card：

```json
{
  "schema_version": 2,
  "contract_kind": "media_rate_card",
  "currency": "CNY",
  "rate_cards": [
    {
      "rate_key": "generate-quality-2k-per-image",
      "spec_key": "generate-quality-2k",
      "billing_unit": "image",
      "unit_cost_cny": "0.40"
    },
    {
      "rate_key": "generate-standard-1080p-audio-per-second",
      "spec_key": "generate-standard-1080p-audio",
      "billing_unit": "second",
      "unit_cost_cny": "0.80",
      "min_units": 5,
      "max_units": 10,
      "step_units": 1
    }
  ],
  "overhead_cny": {
    "tool": "0.00",
    "storage": "0.02",
    "traffic": "0.01",
    "agent_brain": "0.03"
  },
  "failure_rate": "0.05",
  "unknown_rate": "0.01",
  "refund_rate": "0.02",
  "risk_reserve_rate": "0.10",
  "gross_margin_target": "0.50",
  "credit_cny_anchor": "0.01"
}
```

`billing_unit` 只允许 `image | second | segment | megapixel`。`second` 必须有正整数 min/max/step；`segment` 必须有精确 `segment_seconds`，不得把 Provider 只支持的 5 秒固定段伪装成任意秒数；`image` 可按输出张数相乘；`megapixel` 必须使用明确 band，不允许从文件名猜测。一个 `spec_key` 必须恰好有一个有效 rate card，缺价、重复价、单位不匹配或能力未覆盖均禁止进入产品价格 release。

Provider rate card 是平台成本真相，不是用户扣积分表。S14 的 billable SKU 读取该快照、叠加风险与毛利门禁后形成独立用户积分售价；运营可以在高于门禁时选择产品售价，但不能覆盖或伪造 Provider 成本。

### Agent 大脑模型补充契约

Agent 大脑模型不直接产生产物，但负责理解意图、选择 Skill 知识、组合当前已注册工具，以及决定回答、追问或提出候选计划。工程层只裁决模型准入、action space、权限、预算、恢复和最终副作用，因此 Agent Brain 必须与生成模型一样进入模型注册、成本、配额和熔断治理，同时使用独立 strict schema，不能给现有图片模型契约塞入无意义的 token/tool 字段。

`models.capability_contract_json` 的 Agent Brain 形态固定为：

```json
{
  "schema_version": 1,
  "contract_kind": "agent_brain",
  "capabilities": ["agent.brain"],
  "input_modalities": ["text", "image"],
  "tool_protocol": "native_function_calling",
  "terminal_protocol": "strict_json_schema | terminal_tools",
  "supports_usage_tokens": true,
  "max_context_tokens": 272000,
  "max_output_tokens": 8192,
  "max_tool_calls_per_response": 4
}
```

规则：

- `input_modalities` 必须包含 `text`；声明 `image` 只表示模型具备多模态输入能力，不授权读取任何图片。实际图片仍必须由服务端 ownership guard 和 ToolPolicy 绑定，S10 前 S08 不向 Brain 发送图片正文、二进制或签名 URL。
- `tool_protocol` 只接受原生 function/tool calling；`terminal_protocol` 允许 adapter 将终局表达为 strict JSON schema 或显式 terminal tools，但最终必须归一为 S08 的同一严格判别联合。
- 2026-10-02 模型工具输入精简遵循 `02`：保持固定工具列表、description/schema 与顺序，不因 phase 或 Skill 动态改写。wire schema 允许省略宿主常量与可从选中节点重算的 scope 记账字段，adapter 补齐后仍使用原完整运行时 schema 校验，不能从普通文字推断工具或权限。规划草稿空提示词可移除，正式提示词不可为空；结构修复诊断提供安全的字段、类型/上下界及移除未知字段指引，不记录原始参数。可省略不等于 Provider 原生 strict constrained decoding，不能由 Zod strictObject 推定 relay 支持 strict 或强制 tool_choice。
- `supports_usage_tokens=true` 是真实 route 硬门禁。adapter 必须归一出可验证的 input/cached-input/output token；无法可靠归一时当前 turn fail closed，不能估一个“差不多”的 usage 后继续。
- `max_tool_calls_per_response` 是模型单次响应能力上限，运行时仍取它、S08 系统硬上限和运营配置的最小值。模型支持并行 tool calls 不代表运行时并行执行；S08 仍整批 preflight 后按声明顺序串行执行。

`models.pricing_json` 的 Agent Brain 形态固定为：

```json
{
  "schema_version": 1,
  "contract_kind": "agent_brain_tokens",
  "currency": "CNY",
  "request_base_cost_cny": "0.00",
  "input_per_million_tokens_cny": "decimal",
  "cached_input_per_million_tokens_cny": "decimal",
  "output_per_million_tokens_cny": "decimal"
}
```

`models.quota_json` 的 Agent Brain 形态固定为：

```json
{
  "schema_version": 1,
  "contract_kind": "agent_brain",
  "rpm": 60,
  "concurrency": 10,
  "hourly_budget_cny": "decimal",
  "daily_budget_cny": "decimal",
  "max_turn_llm_rounds": 6,
  "max_turn_input_tokens": 272000,
  "max_turn_output_tokens": 8192,
  "max_turn_estimated_cost_cny": "decimal",
  "terminal_timeout_ms": 45000,
  "circuit_sample_size": 20,
  "circuit_failure_rate": "decimal",
  "circuit_unknown_rate": "decimal",
  "circuit_open_ms": 60000
}
```

`max_context_tokens` and `max_turn_input_tokens` represent the effective active context window for a Brain request. The current production window is `272000` tokens; it is not a single-message limit and is not a cumulative input budget. Automatic compaction is triggered at `217600` tokens (80% of the window). Cumulative `inputTokenTotal` remains usage and cost telemetry only.

2026-10-02: Brain rounds and cumulative output are allocated by the host's task-sized policy (`02`), not the historical fixed 8192/6 quota fields. Those frozen values remain readable for audit. Single-call output is bounded by registered model capability and host policy (default 8192). The monetary turn quota remains an independent hard ceiling: increasing output allowance never waives cost reservation, hourly/daily quotas or unknown-delivery protections. Multi-node authoring uses real per-node calls and paired private transcript checkpoints; only complete coverage may reach Compiler. Adapters retain safe finish-reason/parse/schema diagnostics and available reasoning-token counts, but never raw rejected arguments in trace.

The platform's 272K ceiling is a cost policy, not a claim that every Provider uses the same long-context pricing threshold. Historical model snapshots retain their registered capacity and remain readable; each actual request is capped by the minimum of the current platform window, model capacity and quota input window. New model-configuration defaults use 272K, and environment overrides cannot raise the platform ceiling.

#### S08 transcript 请求与容量边界 (2026-09-07)

- P1 不更换模型请求读源；P2 使用 portable native-message projection：每次调用显式提供本次完整有效上下文。保持平台、工具及核心 Skill 前缀，规划与创意写作共用语义历史，不因为可缓存而拆成两套记忆。
- adapter 在成功写作轮返回的 `candidate_plan` 中携带 `02` 的内部 `authoring_output`：保存已验证 `agent_author_prompts@1` 参数及安全 Provider call ID，再返回确定性合并计划。结果解析器校验 prompt 与计划节点逐一一致，缺失/多余/重复 key 或不一致则拒绝。普通 planning/旧格式 fake 可无此字段；新格式的写作捕获不能以该兼容性为由丢掉原始参数。字段不进入日志、usage、SSE，也不改变模型请求、费用或重试规则。
- `previous_response_id`、Provider 专属 prompt cache key/retention 设置和 opaque 协议状态持久化不属于 P1/P2。基础前缀稳定和可信 cached-input usage 计数仍必须交付；缓存 miss 不改变调用动作或权限，也不触发重试。
- P3 如需续传，须另行完成该实际 endpoint/relay 的能力、存储与保留期 PoC 和安全复审。`api_variant=openai_responses` 只是协议标签，既不证明支持也不证明不支持续传；不得为续传自动启用 Provider 内容存储。
- P3 校验至少包括同 user/session、endpoint、credential identity/version、model snapshot、policy/tools/Skill、相关请求选项、图片物化投影和 history generation，以及上次实际 normalized input + 已接受输出是本次输入的严格前缀。仅比较 sequence cursor 不足。响应引用只能随已验证语义输出原子提交；unknown、拒绝输出、压缩、删除或前缀不匹配均使它不可复用。
- 不能证明兼容时直接使用 portable 请求。续传明确在执行前被拒绝时，才可按既有同模型 not-dispatched 重试预算重新构造请求；超时/断连/未知状态不能走自动全量重发。历史恢复绝不扩大生图 Provider 的重投权限，也不保证跨请求恢复隐藏推理。

每步网络调用前按完整有效上下文计算预算，引用或增量传输不减少它代表的模型输入。记 `C = min(平台窗口, quota 输入窗口, model context)`，`I` 为 system/工具/Skill/summary/保留历史/当前 host 更新/物化视觉的总 token，`O` 为该步已允许的最大输出，`F` 为未计入 I 的协议 framing 安全余量；必须满足 `I + O + F <= C`。不得把压缩工具自己的请求排除在预算之外。

当前同窗口示例：`C=272000`、`O=8192`，以 `F=4096` 作为验收夹具的保守余量，则输入硬预算为 `259712`；软阈值取 `min(217600, C-O-F)=217600`，两者间余量 `42112`。`4096` 是待 adapter 实测校准的夹具值，不是假定所有 Provider framing 一样，也不是新增环境变量。更小模型窗口/更大输出必须相应降低阈值；输出或 framing 已无法容纳时调用前拒绝。真实缓存命中、各步 usage 与累计平台成本仍按本节现有可信 usage/Decimal 规则记账，不靠本例估算费用。

`05` 的 64 KiB envelope 与 8 MiB 私有 payload 是存储安全边界，不代表每次允许全部物化进模型。P1 用最大合法 planning/authoring/tool 夹具验证不会丢参数；P2 对引用展开后的真实 token/图片字节再次校验。image inspection 保留元数据及受控资源引用，图片不入 transcript/PostgreSQL；现有单图 20 MiB、turn 物化 64 MiB 边界不变。

三份 JSON 必须按 `contract_kind` 成套出现；S07 已提交的图片/审核模型快照继续使用 media v1 schema，S14 新建媒体生成模型使用本节的 media v2/rate card v2 schema，不能把两类字段拼成宽松可选对象。`packages/provider` 分别导出 media v2 model 与 Agent Brain model 的 strict snapshot schema，同时保留 media v1 历史读取兼容；图片 Gateway 必须拒绝 `agent_brain`，Agent Brain registry 也必须拒绝 media model。

大脑模型成本按 `packages/shared` Decimal 与统一两位 `ROUND_HALF_UP` 计算：

```text
uncached_input_tokens = input_tokens - cached_input_tokens
actual_cost_cny =
  request_base_cost_cny
  + uncached_input_tokens * input_per_million_tokens_cny / 1_000_000
  + cached_input_tokens * cached_input_per_million_tokens_cny / 1_000_000
  + output_tokens * output_per_million_tokens_cny / 1_000_000
```

必须满足 `0 <= cached_input_tokens <= input_tokens`；`output_tokens` 使用 Provider 的可计费总输出口径，含其按输出计费的 reasoning token。Provider 若有该 schema 无法表达的计费单位，必须发布新的 pricing schema version，禁止 adapter 临时塞字段或硬编码价格。

大脑模型降级规则：

- 结构化输出失败允许最多 2 次 schema repair；修复仍由同一受控 action space 约束。
- tool-calling 或 strict terminal output 不稳定时只允许安全回答、追问或显示暂不可用，不得降级成 Controller 固定意图树，也不得进入可收费生成。
- 大脑模型熔断时显示暂不可用；电商任务不得绕过必要商品事实确认，也不得绕过图片 Provider 前的报价、余额核对和 reservation。
- 模型选择必须来自用户已确认的单一 catalog entry，并在 turn/attempt 快照中固定；不写 `fallback_model_id` 捷径，不允许 runtime、control-plane 或 adapter 在该 turn 内选择其他模型。无法调用、超时或 `outcome_unknown` 均 fail closed，后续重试必须由用户发起新的 turn 并重新选择/确认模型。
- 大脑模型 token 成本进入 `agent_traces` 聚合，可由后续 pricing snapshot 决定是否摊入任务成本；S08 本身只记平台成本，不直接写用户积分账本。

## 4. PoC 测试矩阵

| 能力       | 必测项                                                 | 通过条件                               |
| ---------- | ------------------------------------------------------ | -------------------------------------- |
| 文生图     | 文本提示、比例、分辨率、数量                           | 可稳定返回图片和 Provider 请求 ID      |
| 图生图     | 1-3 张参考图、商品主体保持                             | 输出可访问，参数可追溯                 |
| 指令编辑   | 去吊牌、换背景、保留商品主体                           | 改动符合指令且主体未明显漂移           |
| 异步任务   | 轮询或回调、长耗时、页面关闭后恢复                     | 本地可恢复状态，不重复投递             |
| 错误分类   | 鉴权失败、限流、内容拒绝、超时、余额不足               | 可映射到统一错误码                     |
| 回执       | accepted、完成、失败、未知                             | 能区分 `accepted` 与 `outcome_unknown` |
| 成本       | 单图、编辑、失败、重试、存储、流量                     | 能生成成本报表                         |
| 配额       | QPS、并发、日额度、地区限制                            | 能配置熔断和降级                       |
| Agent 大脑 | 意图、引用绑定、Skill 路由、结构化输出、tool-call 循环 | 能稳定输出 schema，命中预算和循环保护  |

## 5. 回执记录要求

每次真实调用必须保存：

- `provider`。
- `model_id`、`model_version`。
- 本地 `task_attempt_id`。
- `provider_request_id`。
- 请求摘要，不保存敏感密钥。
- 响应摘要。
- 原始错误码、错误消息摘要。
- 开始、受理、完成或超时时间。
- 输入 token/图片/视频数量等计费单位。
- 供应商账单成本或估算成本。

## 6. 成本模型

成本表至少包含：

| 维度     | 说明                                            |
| -------- | ----------------------------------------------- |
| 模型成本 | 按模型、分辨率、时长、次数记录                  |
| 工具成本 | 抠图、放大、背景去除、OCR 等                    |
| 失败成本 | 失败是否计费，失败原因分类                      |
| 重试成本 | 自动重试只允许未送达 Provider；人工重试重新确认 |
| 存储成本 | 原图、产物、缩略图、版本历史、备份              |
| 流量成本 | 预览、下载、分享页访问                          |
| 风险准备 | Provider 波动、退款、申诉、坏账                 |
| 毛利目标 | 建议首版预留不少于 50% 毛利空间                 |

积分价值反推：

```text
单任务真实成本
  + 存储和流量摊销
  + 失败和退款准备金
  + 目标毛利
  -> 人民币售价
  -> 积分单价
  -> 积分消耗配置
```

成本未核算前，只能使用封闭免费测试额度，不开放充值或对外承诺价格。

### 6.1 阶段 0 成本核算工作表

阶段 0 必须维护一份可执行成本核算工作表，建议路径：

```text
artifacts/poc/cost-model.xlsx
artifacts/poc/cost-model.csv
```

工作表最小列：

| 字段                      | 说明                                           |
| ------------------------- | ---------------------------------------------- |
| `skill_id`                | Skill 版本                                     |
| `model_id`                | 模型版本                                       |
| `task_type`               | generate/edit/background_remove/ocr/evaluation |
| `provider_unit_price_cny` | Provider 单次或单单位价格                      |
| `avg_provider_units`      | 平均计费单位                                   |
| `tool_cost_cny`           | 工具成本                                       |
| `storage_cost_cny`        | 存储摊销                                       |
| `traffic_cost_cny`        | 下载、预览和分享流量摊销                       |
| `agent_brain_cost_cny`    | 意图、规划、解释等 LLM 成本摊销                |
| `failure_rate`            | 失败率                                         |
| `unknown_rate`            | `outcome_unknown` 率                           |
| `refund_rate`             | 退款/申诉通过率                                |
| `risk_reserve_rate`       | 风险准备金比例                                 |
| `gross_margin_target`     | 目标毛利率                                     |
| `credit_cny_anchor`       | 1 积分人民币锚定                               |
| `suggested_credits`       | 建议扣费积分                                   |

核算公式：

```text
direct_cost_cny =
  provider_unit_price_cny * avg_provider_units
  + tool_cost_cny
  + storage_cost_cny
  + traffic_cost_cny
  + agent_brain_cost_cny

risk_adjusted_cost_cny =
  direct_cost_cny
  * (1 + failure_rate + unknown_rate + refund_rate + risk_reserve_rate)

price_cny =
  risk_adjusted_cost_cny / (1 - gross_margin_target)

suggested_credits =
  decimal_ceil(price_cny / credit_cny_anchor)
```

阶段 0 默认锚定：

- `credit_cny_anchor = 0.05`，即 1 积分约等于 0.05 元的内部计价锚。
- 可评估区间为 0.05-0.08 元/积分；对外不得宣传积分可兑换现金。
- 首版 `gross_margin_target` 不低于 50%。
- 会员赠送积分必须按该锚定价回看，不得出现赠送价值长期高于会员费的配置。

成本工作表验收：

- 至少覆盖 1 个文生图模型、1 个指令编辑模型、1 个 Agent 大脑模型；S08 接入前可以先完成前两类，Agent 大脑成本随 S08 补齐后才能通过完整阶段 0 定价门禁。
- 图片生成和图片编辑各至少用 20 次受控真实 PoC 调用估算平均成本和失败/unknown 比例；文本/图片审核另覆盖 pass、blocked、unknown 和服务不可用样本。
- `suggested_credits` 必须进入 `pricing_version` 快照。
- 成本变更必须走版本化配置，不得覆盖历史计价。

## 7. Workflow 候选与 Plan B

| 候选                | 优点                                               | 风险                                           | 阶段 0 结论项 |
| ------------------- | -------------------------------------------------- | ---------------------------------------------- | ------------- |
| Redis + BullMQ      | 可控、生态成熟，适合 NestJS 常驻 Worker 和国内部署 | 需要自建恢复、监控和幂等                       | 推荐实现      |
| Vercel Workflow SDK | 与 Vercel 部署栈贴合，适合作为海外部署候选         | 中国访问、能力边界、长任务恢复和成本需真实验证 | 海外备选 PoC  |
| Inngest             | Serverless 友好、事件驱动、重试和可观测性较成熟    | 复杂长任务和成本需验证                         | 待 PoC        |
| Trigger.dev         | 任务编排体验好、适合后台任务                       | 部署和计费需验证                               | 待 PoC        |
| 数据库轮询 Worker   | 最简单，依赖少                                     | 可观测性和扩展性弱                             | Plan B        |

最低 Plan B：

- `tasks` 表保存待执行任务。
- Worker 通过事务抢占任务。
- `task_attempts` 保存每次投递。
- 幂等键防止重复付费调用。
- 定时器扫描超时任务进入异常处理。

## 8. 可执行脚本

阶段 0 至少提供以下脚本：

```text
scripts/poc/provider-image-generate.ts
scripts/poc/provider-image-edit.ts
scripts/poc/provider-webhook-or-polling.ts
scripts/poc/provider-error-classification.ts
scripts/poc/provider-moderation.ts
scripts/poc/cost-report.ts
```

建议命令：

```bash
pnpm poc:provider:image
pnpm poc:provider:edit
pnpm poc:provider:polling
pnpm poc:provider:errors
pnpm poc:provider:moderation
pnpm poc:cost-report
```

脚本输出必须写入：

```text
artifacts/poc/provider-runs/*.json
artifacts/poc/provider-cost-report.md
```

## 9. 验收标准

模型进入可收费路由前必须满足：

- 能真实生成或编辑成功。
- 能获得 Provider 请求 ID 或可等价追踪的回执。
- 能区分未送达、已受理、结果未知。
- 能记录真实成本或可审计估算成本。
- 能证明配额、限流和超时策略。
- 能映射统一错误码。
- 产品确认输出质量和风险可接受。

未满足任一项时，模型状态只能是 `poc_failed`、`disabled` 或 `free_test_only`。

# Final relay protocol addendum (2026-08)

This addendum supersedes the earlier OpenAI-official-only adapter decision in this
document. The first real integration uses administrator-configured relay channels.

- Supported protocol families are exactly `openai` and `anthropic`.
- Supported API variants are `openai_chat_completions`, `openai_responses`,
  `anthropic_messages`, and `openai_images` for image generation/editing.
- A relay channel owns the normalized base URL and encrypted credential. One
  channel may expose multiple model snapshots; a model snapshot selects exactly
  one protocol family and API variant.
- A turn selects exactly one Brain model snapshot and never switches to another
  model within that turn. There is no automatic fallback after dispatch or after
  `outcome_unknown`.
- Brain calls use the Vercel AI SDK with retries disabled. Image generation/editing
  uses the OpenAI Images request contract through the Provider adapter and keeps
  the existing three-state outcome, cost, quarantine, and settlement boundaries.
- Base URLs are not arbitrary request inputs. They must be HTTPS, normalized, and
  allowed by the server-side relay-origin policy; headers and request JSON remain
  adapter-owned.
