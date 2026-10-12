# Portable Skill and image-input boundary

## 数据驱动的 Skill 执行边界（2026-10-08）

新建 turn 的内置 Skill 从工程 manifest 读取 `execution_policy`（version 1、family、max_sources）并随已鉴权 Skill selection 固化，贯穿 Brain、Compiler 和已批准图片任务。family 只表示通用执行语义：`text_generation`、`independent_sources`、`optional_references`、`reference_composition`、`identity_edit`、`product`，不是画风、Skill 名称或工具授权。新增相同执行语义的 Skill 不得向 API/Provider/Worker/Compiler 添加 slug 分支。

- Markdown 裁决构思、材料、颜色、文字和默认版式。当前执行封套只传输入角色和最终 prompt，不重复艺术任务书、不强制某 Skill 的比例或装饰删除。移除 `xieyi_structure` 等专用艺术证明字段；通用摘要、创作说明和最终指令已足以承载模型决定。
- manifest 的 `attachment_roles` 只提供角色与中文标签；`catalog_enabled=false` 隐藏新入口但不删除历史引用。新内置 primary 必须声明 execution_policy；auxiliary 不声明执行规则。所有类型仍经过既有 capability/model spec 准入。
- 工程按 family 校验来源角色、节点/输出数量、身份限制和商品事实；独立源图逐图一节点一输出、照片证据与 prompt 不重复，组合素材一节点。身份保护、R1-R5、跨用户/生命周期/hash 校验、确认商品事实、交易及三态回执不由内容配置放宽。family 未知或 policy 非法拒绝；修改 `max_sources` 不能超过平台九图输入上限。
- 用户明确决定本轮只验收新会话，不实现历史 profile/封套兼容，不修改或清理历史数据。缺 policy 的旧快照不猜测 slug，也不补写新规则；不能据此恢复旧创意执行。外部包依旧通过发布准入和不可变 hash 校验，profile 提示不是执行许可。

正面复审：同一声明贯穿执行链，减少名单遗漏与提示互相覆盖；新增 Skill 只写内容与资源清单。反面复审：禁止 Markdown 注册工具、LLM 修改 policy、读取最新配置替换已批准快照、把艺术规则堆入 family，或删除权限/商品事实门。按以上边界通过方案复审。验收包含陌生 slug 的声明式运行、非法 family/角色/数量拒绝、事实缺失和来源越权失败、稳定工具 schema 及新会话恢复，不调用付费 Provider。

## 会话设计师锁定（2026-10-08，覆盖下方旧版跨 turn 改选规则）

首条提交固定模式和精确方法版本：原生不注入，手选固定一个档案；变更必须新建会话。新增自动策略 v3，方法档案仍为不可变 v1/v2。自动 v3 在普通聊天中保持待选择，仅在已有规划调用提出有效图片计划、且选用的图片已读取后，通过可选平面字段 `creative_direction_profile_id` 选择六个白名单方法之一。宿主在接受规划的原事务内固定为方法 v2，随后 authoring、修复、下一 turn 和恢复使用这个方法；不得随机兜底、题材硬路由或追加模型调用。缺失/无效选择走既有有界格式修复。

会话快照独立于不可变 turn 偏好及 transcript，包含原选择、可选实际方法和规划 turn/step 来源，并覆盖 canonical hash。接受规划必须满足租约、revision、用户归属和未被取代条件；同一会话只能首次解析一次，重放不得替换。历史空快照按全局最新已提交 turn 的偏好锁定，不重写旧 turn 或 hash，不从提示词猜实际方法；旧自动 v1/v2保留原策略，新建会话才能启用 v3。锁定方法不等于锁定构图，限定改图不强制创新。诊断只记录 ID、版本、来源和 hash。

## 通用创作方向层（2026-10-04）

创作方向是用户可选的观察与构思方法，适用于所有已激活图片 Skill。它只影响任务留给模型的创作空间，不覆盖用户要求、Skill 的真实限制、源图保真、商品事实、图片授权或工具政策。六个档案为人文叙事、视觉隐喻、空间戏剧、色形表现、图形秩序、材料实验；不得按照片题材硬编码分派，不使用艺术家署名或复刻固定作品。

选择保存在现有 `generation_preferences_json.creative_direction` 内，由整体 `generation_preferences_hash` 覆盖。省略字段等价于 Skill 原生；前端新草稿默认自动。手选档案和自动策略均有不可变版本，修改方法必须增加版本并保留历史版本解析能力，不能修改同版本正文。Worker 在每次规划、创作、修复和恢复调用中使用该 turn 的选择，不能读取别的会话或最新页面设置。

人格内容由服务端白名单展开，作为动态 runtime context 注入，稳定 system/tool 前缀保持不变。手选只发送一个档案；自动只发送六个短摘要和选择策略，在现有构思/authoring 调用内采用一个主导方向，延续已建立的构思，无额外模型调用。自动模式持久化的是自动策略版本，不宣称记录了模型实际选择的档案 ID；最终候选和生成提示词沿用现有 checkpoint 保存。普通聊天不强制创作，不把角色介绍添加到画面或旁白；改图保留用户未要求改变的部分。生图 Provider 仍只接收最终生成提示词。

结构化诊断仅记录模式、档案 ID、版本和选择摘要 hash，不记录人格正文、用户完整提示词或图片数据。质量提升必须通过同源照片、同 Skill、同模型的原生/手选对比验收，工程门禁通过不能替代艺术效果验收。

2026-10-07 方法 v2：保留全部 v1 档案和自动策略正文，新选择使用 v2。六种方法分别从事件关系、第二层含义、空间关系、色形张力、视觉主张和材料行为决定表达，不以增加细节、换色或改变线条粗细代替构思。开放创作在现有模型调用内比较有实质区别的解释，选取一个有证据且能在画面中成立的主张；限定改图不强制重新构思。逐图 authoring 延续已选主张，把方法转成具体的可见关系及结果，兼顾 Skill 文字层级等要求，而不是把操作计划当成视觉模板。保持内部比较，不要求输出思考过程、固定候选数、固定 Prompt 顺序、新字段或额外调用。自动 v2 仍只展开短摘要，不混合六份全文；原生模式不注入人格。来源事实和禁止改变的区域保持权威，艺术转译只发生在任务允许的部分。本轮不修改任何 Skill，不新增成图评估或自动重生图链路；真实图像质量继续由用户对照验收。

## 会话素材范围决策（2026-09-28）

### 公开过程说明

规划阶段允许模型在同一个响应中输出简短公开说明与非终态知识工具调用（`load_skill` / `inspect_image`）。它作为 `tool_calls.commentary` 保存，最多 2000 字符，只讲可公开的观察结论或下一步行动，不公开 reasoning token、私有指令或工具原始参数。单独的纯文本仍是 `chat_text` 并结束本轮；终态动作和 prompt authoring 仍不允许混排文字。不得强制每一步都有说明，也不得为了说明新增一次模型调用。

说明先经过与正文相同的公开文本保护，再与原生 transcript、模型用量结算和普通 assistant 消息投影同事务写入。以模型输出 item ID 作为说明消息 ID；重放不得重复发布，不改变 turn 的运行状态，也不构造 terminal receipt。超预算、违规文本、调用格式错误不得发布说明或执行工具。接管恢复原始工具批次和说明，不能再次收费或重复写消息。草稿沿现有 SSE 增量预览，正式说明沿现有 `turn.message_delta` 发布；无需新增事件类型。页面把连续同轮的助手内容连贯展示，当前工具状态放在已有说明之后，最终回答使用同一 Markdown 组件。

会话候选是可选素材集合，不代表本轮生成清单。恢复用户上传组时，服务端在候选上冻结 `source_group`（用户消息 ID、UTC 上传时间、是否最近上传组），供 Brain 区分旧主题与最新上传；这些字段不由模型或客户端声明。继续保留授权且有效的历史原图，不以固定关键词或“一律最新一张”代替语义判断。

含上述来源信息的候选计划必须包含 `scope_decision`：`mode` 为 `latest_upload` 或 `conversation_reference`，`input_binding_keys` 为本次实际使用的全部图片引用的去重集合，`output_count` 为全计划的图片总数，`reason_summary` 为简短决策结论。`latest_upload` 不得带入已标为更早上传组的源图；回到旧图、跨组处理或根据历史讨论继续旧主题，使用 `conversation_reference` 并说明用户指代的对象，不以“可读取”“已经看过”“适合组成系列”当作用户要求重做的证据。普通聊天与澄清不要求这个字段，也不自动触发生图。

Provider adapter 在规划进入 prompt authoring 前校验范围声明，Compiler 在报价前再次校验：实际绑定集合及所有图片节点的总张数必须与声明完全一致。成功编译时将已校验的 `scope_decision` 原样保存到 `canonical_plan` 并纳入 `plan_digest`，随报价计划快照冻结；它是范围决策审计证据，不替代服务端引用授权或跨组确认。失败沿现有有界修复循环返回字段路径及具体纠错原因，不自动删除节点，不创建报价/预留，不增加 Provider 自动重投。authoring 不可改变该决策。旧的无来源信息快照仍可恢复，不追写历史；新快照经过 claim/接管保持来源字段不变。结构校验不能证明自然语言语义正确，真实多轮模型验收仍是必要门禁。

自动会话候选若被计划跨两个及以上用户上传组使用，且本轮没有用户显式加入这些图片作为附件/`@` 引用，报价前须通过现有澄清入口确认该计划的去重图片绑定集合及总输出张数；没有确认时不能以模型自报的 `conversation_reference` 或 `reason_summary` 放行。澄清提供“只处理最近上传”和“同时处理这些上传组”的明确选项；只有用户确认后，服务端冻结并校验与该计划一致的 scope digest，才可进入报价。变更绑定或张数须重新澄清；拒绝、过期、取消或历史不匹配的确认不授权。用户已选择“只处理最近上传”而模型仍提交同一跨组范围时，阻断本轮计划，不得再次提出相同的澄清。单上传组、本轮显式附件及纯文本讨论不经过此额外确认；不改变生图授权、费用预留及 Provider 三态规则。

## Planning and prompt authoring handoff (2026-09-05)

Compiler 触发的跨上传组澄清以内部 `scope_confirmation_requested` 回执结束已捕获的 `agent_candidate_plan@1` 或 `agent_author_prompts@1` 调用；不能伪造一个模型未调用的澄清工具。回执绑定同用户、同 turn 的真实 clarification、payload digest 和 scope digest。提示词撰写调用仍不能发布普通回复、商品事实或任意澄清；只有 Compiler 校验后的报价或上述范围确认可以作为成功结果。它不代表图片 Provider 已投递，也不授权未确认的范围。

Image planning and final prompt authoring use separate, budgeted Brain rounds
with the same frozen model, user context, Skill knowledge and authorized images.
The planner owns the operational draft; the author returns only final prompts
keyed by candidate node. The host merges prompts without changing bindings,
counts, ratios, capabilities or other operational fields. No draft may reach
Compiler execution or create a chargeable image workflow. The completed plan
still passes all existing deterministic Compiler checks.

Each round reserves and settles its own LLM exposure, usage and cached-input
tokens. For `transcript_v1`, persist validated drafts and authoring outputs as
private semantic payloads referenced by the session transcript, not inside trace
summaries. Legacy execution and trace-based semantic recovery are not supported
under the scope revision in section 11.0.
Never put drafts or prompts into logs or SSE. An author failure must not fall back
to submitting the draft. Cancellation, deadlines and unknown delivery retain the
existing no-automatic-redispatch behavior.

The adapter must retain the accepted authoring call before merging it. A
`candidate_plan` produced by authoring carries an internal `authoring_output`:
`{name:"agent_author_prompts@1",arguments:<authoredPromptsSchema>,provider_call_id}`.
It preserves the validated prompt array's original order and complete text; the
optional provider identity is sanitized as specified in `05`. The prompt keys
must form a bijection with the merged plan's nodes and every prompt must equal
the corresponding final plan value. Direct planning/legacy outcomes may omit
this field. Transcript capture of an authoring round must require it and must
never infer an original call by extracting prompts from the merged plan. This
field is private runtime data, not a new API/SSE field or an extra model call.

Terminal transcript capture takes the host's actual planning/authoring phase.
It never substitutes a merged plan for a missing authoring call. A successful
model output remains accepted even when subsequent policy or compilation rejects
its action; that rejection is the paired host result, not a rewrite of the model
source. A compiler quote receipt means only that a quote was created, never that
generation was dispatched. Exact receipt and provenance fields are defined in `05`.

Stable knowledge and image message prefixes should remain identical across
rounds; append phase instructions and the operational draft after that prefix.
Provider-reported cached tokens are the only evidence of model cache hits.
Local Skill or image-byte caches are not model KV caches, and do not replace
authorization or content-version checks. Authoring must follow the actual task
and Skill, without a fixed artistic genre, abstraction or deletion rule.

### Creative freedom and execution safety (2026-09-15)

The stable system/tool prefix defines execution and safety boundaries, not a second
catalog of artistic recipes. Append only the selected task's operational hints and
the actual host phase at the tail. In planning with a separate authoring round,
do not also instruct the model to finish the final prompt in that response. In
authoring, preserve the validated operational draft while letting the model develop
the visual choices left open by the user and Skill. A single-pass call still needs
a complete final prompt. Tool schemas, authorization, R1-R5, model limits, frozen
parameters, billing, cancellation and bounded repair remain unchanged.

Distinguish factual copy, user-supplied exact copy and original artistic copy.
Facts require evidence; supplied copy stays verbatim. When the user or selected
Skill authorizes original titles or poetry, the model may compose them and choose
their typography without an extra text-approval step. An explicit no-text request
or a Skill requiring supplied copy still applies. Do not treat artistic metaphor
as a fabricated factual claim or let a shared auxiliary override primary text policy.

Do not reject executable artwork for missing an artistic proof, not repeating a
construction sentence verbatim, or failing an enum-based diversity score. Skill
methods and visual quality checks remain creative guidance, not authorization
gates. Budget increases and claims of improved image quality require measured
usage and controlled visual comparison; this change does not raise budgets.

`SKILL.md` is reusable knowledge, not an ecom-forge execution payload. A portable
Skill uses Codex-compatible frontmatter with only `name` and `description`, followed
by Markdown that describes the creative method, observable evidence, constraints,
quality gates, and revision strategy. It must not require a candidate-plan schema,
platform tool name, Provider/Compiler handoff, internal field, fixed assistant output
format, fixed prompt order, or target prompt length.

The ecom-forge runtime keeps its execution profile in the package manifest. The
profile contains catalog metadata, required capabilities, input and fact hints,
output-count defaults, presets, dependencies, references, and audit data. The Agent
Brain may use the portable Skill as knowledge, while the deterministic compiler,
permission layer, credit layer, queue, and Provider adapters remain authoritative.
This separation lets the same Skill be copied into another Agent without weakening
ecom-forge's transaction, permission, moderation, lineage, or retry boundaries.

For image inputs, a file uploaded by the current authenticated user is considered
authorized for that user's current creative request by default after the server
validates ownership, readable/active lifecycle, supported image type, content hash,
version, and storage access. `source-rights-confirmed` is not a required fact for a
normal user upload and must not be requested as a platform checkbox. Cross-user,
deleted, quarantined, unreadable, storage-missing, version-drifted, or hash-drifted
resources remain rejected. A user may still provide additional rights or usage facts
when the creative request needs them; those facts are not the default technical gate.

For prompt compilation, the Brain should preserve specific user and Skill decisions
that affect visible pixels. It may structure a prompt for clarity, but must not
silently drop material, composition, identity, typography, or revision invariants
to satisfy a global format or character target.

The first-party creative image Skills absorb the portable image-generation method
used by Codex: separate generate from edit intent, assign an explicit role to every
input image, normalize detailed requests without adding requirements, and use the
optional labeled visual scaffold only when it improves clarity. The Brain remains
responsible for turning the selected Skill and inspected source pixels into one
source-specific final prompt. The scaffold is knowledge, not a second execution
protocol; Compiler and the image adapter remain the owners of capability, input,
permission, quote, and dispatch checks.

The image model capability snapshot may declare `max_prompt_characters`. This is a
model-specific admission limit for the final image prompt, not the Agent context
window and not a per-turn token budget. It is frozen with the selected image model.
Missing values on legacy snapshots use the documented compatibility limit; no
layer may silently truncate a prompt.

# 02 Agent 与 Skill 编排契约

| 项       | 内容                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| 状态     | v0.7 1A Brain 解析张数与无费用卡提交路径回写后可复审                                          |
| 基准     | PRD v1.11                                                                                     |
| 完成节点 | 数据库前                                                                                      |
| 裁决范围 | 意图 schema、解析确认 schema、Skill JSON schema、计划编译、引用授权、Agent 与确定性编译器职责 |
| 不裁决   | Provider 成本、数据库表结构、任务状态机、前端最终布局                                         |

## 1. 目标

Agent 可以使用 LLM 理解用户，但不能让 LLM 成为交易、权限和产物修改权的最终裁决者。本文定义从自然语言到可执行计划的安全编排边界。

本项目的 1A Agent 是对话式 Agent，核心服务创意生图、电商从零生成和本会话产物迭代。历史项目 `D:\agent\image` 中已经实现的对话 Agent、tool calling 与 Skill runtime 可参考其架构、渐进加载、运行护栏、Provider 调用和工具审计；参考对象不是无限画布产品形态，也不迁移旧画布业务语义。

参考工程中吸收两类资产。运行机制包括原生 tool loop 与 terminal tools、有界对话 working set、上下文指纹、版本匹配后复用 Skill、`load_skill` 增量读取一跳 reference、紧凑 planning view、共享知识去重、工具进度审计、取消与晚到 Worker 的 CAS。电商知识包括事实账本、商品证据归属、组图证据多样性、平台合规、声明安全、类目风险、真人摄影真实感、信息编排和自检清单；这些内容必须按本项目版本化 Skill schema 重写和评测后发布，不能直接引用旧工程运行目录。

与本轮无关的 canvas node/action batch/direct-edit/自动铺图不迁移；完整 prompt 本地落盘、Skill 缺失时 fallback 正文、slug 别名猜测、自动兜底选择主 Skill，以及由 Skill/模型自行扩大工具或执行策略的做法也不采用。

不额外启动前置意图分类 LLM。意图证据由使用用户所选主 Skill 的正常 Agent Brain step 产出；该 step token 计入平台成本，但不作为用户侧独立收费项目。

核心原则：

- Agent Brain 模型是大脑，负责在用户已选主 Skill 边界内理解意图、按白名单加载辅助知识、组合已注册工具，以及决定回答、追问或提出候选计划。用户选择的是 S14 已发布的产品模型，不接触 Provider、原始 model ID、通道或 Key。
- Tool registry 提供版本化可执行能力；每个工具都必须有 strict schema、side-effect 等级、超时、幂等和服务端 ToolPolicy。
- Skill 是版本化知识包，补充任务方法、审美、领域约束和 SOP；不能注册或授权工具，也不能原地覆盖。
- 工程控制面负责身份、资源归属、预算、状态、恢复、日志和审计；确定性计划编译器只终审候选执行计划、R1-R5、费用和收费动作。
- 每次 `workflow_run` 必须固定引用当时的 Skill、模型、提示词编译结果、计价和规范版本。

## 2. Agent 处理链路

```text
用户输入
  -> 用户选择一个主 Skill，可选其 Preset
  -> 用户确认当前可用的 Brain 模型和本次任务所需的图片/视频模型
  -> 服务端校验并固定 Skill selection + product model selection snapshot
  -> 服务端组装已授权上下文 + 所选主 Skill/辅助知识目录 + 当前 action space
  -> Agent Brain 决定下一步
       -> load_skill / 受控读取工具 -> 安全 observation -> Agent Brain 继续
       -> 普通回答 -> turn 结束
       -> 请求澄清 -> 等待用户确认 -> 新 continuation
       -> 候选执行计划 -> 确定性计划编译 -> 积分核对与预留 -> workflow_run
```

这不是固定意图树：模型可以按对话上下文调整知识和工具组合。任何一步失败时，Agent 只能基于脱敏 observation 换策略、解释、追问或返回跳转卡片，不能直接调用生成 Provider。

### 2.1 Skill 与模型选择

- primary Skill 必选；Preset 是否必选由该 Skill 的 slot 契约决定。Skill 提供知识和工作方法，不选择 Provider、模型或价格。
- S11 页面展示 S14 active catalog 中产品化的 `brain | image | video` 模型。默认模型可以预选，但创建 turn 前必须解析为明确的 catalog entry/version；不得把“默认”字符串留给 Worker 运行时再决定。
- Brain 选择固定到 turn；图片/视频选择固定到候选计划和 quote。一个 turn 可先只使用 Brain，只有候选计划包含相应媒体操作时才要求匹配图片/视频模型。
- 用户选择只提交公开 catalog entry ID、catalog revision 和公开规格；服务端重新检查 active release、rollout、用户权限、Skill required capabilities、PoC、circuit 和完整 SKU，不能信任前端价格或 capability。
- 模型不可用时返回可解释的可选项刷新，不静默换模。只有确认未投递、重新选择并重新报价后，后续新 attempt 才能使用另一个模型；`accepted/outcome_unknown` 后禁止切换模型重投。
- 内测首版 Brain 用户计费方式固定为 `included`：平台仍按 token 记录 Provider CNY 成本和 turn exposure，但不产生独立用户积分流水。`request/token` 用户计费只保留版本化扩展能力，未单独评审前不得发布。

## 3. 意图分类 schema

```json
{
  "intent": "creative_generate | commerce_generate | chat_artifact_edit | external_artifact_edit | raw_asset_generate | unclear | unsupported",
  "domain": "creative | commerce | mixed | unknown",
  "requested_action": "generate | edit | suite | video | upscale | remove_background | unknown",
  "referenced_objects": [
    {
      "kind": "artifact | asset | upload | message_attachment",
      "id": "string",
      "source": "chat | canvas | suite | upload | unknown"
    }
  ],
  "confidence": 0.0,
  "needs_clarification": false,
  "clarification_question": "string | null"
}
```

服务端不得只凭 `source` 文本字段放行，必须按数据库中的产物元数据再次校验。

该 schema 是模型对当前请求的结构化理解与审计证据，不是 Controller/Service 的固定路由树。普通回答、追问、Skill 选择和工具组合仍由 Agent Brain 在当前 action space 内决定；服务端不得按 `intent/requested_action` 写一组穷举 switch 来替代模型决策。新 Skill 或新 Tool 的加入不应要求扩充核心意图枚举才能被模型使用；无法归入既有标签时保留 `unclear/unknown`，由模型追问、回答或提出候选计划，工程只做能力与安全裁决。

## 4. 路由规则

| 用户意图                     | Agent 行为                   | 服务端硬规则                                                                                 |
| ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| 淘宝主图、白底精修、商品视频 | 加载电商 Skill，进入解析确认 | 检查 Skill 阶段和依赖                                                                        |
| 详情页、A+、整套主图物料     | 2B 起加载规范依赖 Skill      | 1A/1B 隐藏或解释未开放                                                                       |
| 修改本会话产物               | 加载指令编辑 Skill           | 校验首发 primary allowlist、`producer_mode=chat`、会话与发布版本；电商产物继承父产物冻结事实 |
| 修改画布/套图产物            | 返回跳转画布卡片             | 执行前硬拦截                                                                                 |
| 新上传商品原图               | 作为新素材从零生成           | 不继承旧产物修改权                                                                           |
| 模糊请求                     | 追问用途或目标平台           | 不生成付费计划                                                                               |
| 纯创意请求                   | 直接形成候选计划             | Brain 解析数量，Compiler/Credit 在 Provider 前核对能力、价格、余额与预留                     |

## 5. 解析确认 schema

电商任务：

```json
{
  "task_domain": "commerce",
  "skill_id": "commerce-white-background@1.0.0",
  "category": "string | null",
  "target_platform": "taobao | tmall | amazon | tiktok | temu | unknown",
  "image_types": ["main"],
  "output_count": 1,
  "output_count_source": "user_explicit | skill_default",
  "special_requirements": [],
  "input_assets": [],
  "required_fact_fields": ["product_identity", "primary_color", "main_logo", "visible_text"],
  "missing_required_fields": [],
  "needs_user_confirmation": true
}
```

创意任务：

```json
{
  "task_domain": "creative",
  "skill_id": "creative-style-transfer@1.0.0",
  "style_reference_assets": [],
  "output_count": 1,
  "output_count_source": "user_explicit | skill_default",
  "aspect_ratio": "1:1",
  "needs_user_confirmation": false,
  "clarification_question": "string | null"
}
```

商品事实确认是电商解析确认的子步骤。Skill 声明需要哪些事实，调用方不得为填满通用字段而强行追问。

解析阈值规则：

- `confidence < 0.65` 时，默认不能直接进入可收费计划，必须追问或降级为人工可读解释。
- `confidence >= 0.65` 但 `missing_required_fields` 非空时，只能进入澄清，不得提交。
- 只有当 `confidence >= 0.85` 且必需字段齐备时，才允许编译器进入报价与提交路径。1A 由服务端直接执行积分核对，不插入费用确认 UI。

## 6. 商品事实确认 schema

```json
{
  "source_asset_id": "asset id",
  "source_version": "hash or version",
  "facts": {
    "product_identity": {
      "value": "string",
      "evidence": ["asset region or user input"],
      "confirmed": true
    },
    "visible_text": {
      "value": ["string"],
      "evidence": ["ocr or user input"],
      "confirmed": true
    },
    "color": {
      "value": "string | null",
      "evidence": [],
      "confirmed": false
    }
  },
  "confirmed_by": "user_id",
  "confirmed_at": "datetime"
}
```

1A 白底精修的阻断最小事实是商品身份和可见文字处置结果；“当前无可见文字”必须由用户显式确认，无法辨认保持 unknown。确认卡同时展示可观察到的主色/关键颜色、主 Logo 或包装标识，但它们未知时不为填满字段强行追问；材质、结构、尺寸等仅在当前 Skill 计划需要或用户提供时升级为必需事实。S12 激活的 Skill `required_facts` 必须与该口径一致。

## 7. Skill JSON schema

```json
{
  "schema_version": 1,
  "kind": "primary",
  "name": "商品白底精修图",
  "slug": "commerce-white-background",
  "version": "1.0.0",
  "category": "commerce",
  "domain": "commerce",
  "stage": "1A",
  "description": "生成白底精修图并保留商品事实风险提示",
  "planning_view": {
    "resource_path": "skills/commerce-white-background/SKILL.md",
    "content_hash": "sha256"
  },
  "required_facts": ["product_identity", "primary_color", "main_logo", "visible_text"],
  "required_capabilities": ["image_edit", "background_remove"],
  "default_output_count": 1,
  "catalog": {
    "visibility": "public",
    "cover_asset_path": "/skill-assets/commerce-white-background/cover.webp"
  },
  "preset_slots": [
    {
      "slot": "style",
      "label": "风格",
      "required": false,
      "max_selections": 1,
      "options": [
        {
          "preset_id": "clean-studio@1.0.0",
          "name": "干净棚拍",
          "description": "克制、清晰的商品棚拍方向",
          "resource_path": "presets/clean-studio.md",
          "preview_asset_path": "/skill-assets/commerce-white-background/clean-studio.webp"
        }
      ]
    }
  ],
  "dependencies": [
    {
      "skill_id": "commerce-visual-art-direction@1.0.0",
      "mode": "required",
      "reason": "共享电商事实、证据与视觉职责边界"
    }
  ],
  "references": [{ "path": "references/fact-checking.md", "purpose": "商品事实核对" }],
  "status": "draft | published | disabled | archived"
}
```

以上 JSON 是 validator 从可移植 `SKILL.md`、package manifest 中的宿主 `skill_profiles`、其声明的 Preset/reference 索引和 package inventory 确定性编译出的数据库 `definition_json`，不是作者维护的第二份 Skill 正文。`planning_view` 只索引已验证的 `SKILL.md` 资源和 hash，不复制正文。相同输入必须生成相同 canonical JSON 与 `definition_hash`。

`kind` 只允许 `primary | auxiliary`。公开 catalog 只列 `kind=primary + visibility=public`；auxiliary 不作为用户主选择。primary 的 `default_output_count` 是 1-16 的版本化生成默认值，未声明时规范化为 1；它必须进入 selection snapshot 和 Compiler context，Brain 只在用户未明确数量时复制该值，Compiler 再按同一快照核验。升级前已入库且尚未执行的 legacy snapshot 若缺少该字段，Runtime 只允许从经完整性校验且仍使用旧版宿主 frontmatter 的 primary `SKILL.md` 恢复一次，并把恢复值冻结为本次 Brain 与 Compiler 共用的执行值；portable `SKILL.md` 不携带该宿主字段，缺少 selection snapshot 值时必须 fail closed，不得猜测为 1。恢复不得改写持久化 snapshot/hash，也不得按 Skill slug 维护旁路表。`planning_view`、Preset、dependencies、`required_facts`、`required_capabilities` 和 references 都是知识与依赖提示，不构成执行授权。Skill 不携带 Provider Key，不选择最终模型，不拥有可执行 DAG，也不是费用真相。模型根据知识提出候选 DAG；S09 Compiler 根据当前 Tool registry、模型准入、引用权限和 S04 计价契约重新裁决。

Preset 规则：

- Preset 是主 Skill 内的版本化知识资源，不是子 Skill、auxiliary、Provider/模型参数，也不注册工具。`preset_id` 必须是精确 `slug@semver`，其资源属于主 Skill 不可变发布包；它计入资源/L1/input-token 预算，但不单独占用 Skill 数量上限。
- 每个 slot 的 `required/max_selections/options` 由主 Skill 定义。必选 slot 缺失、未知 option、重复 slot、超出数量或跨主 Skill preset 均在模型调用前拒绝；runtime 不静默补默认值。
- 用户未选择可选 slot 时保持为空；Agent 不能在运行中替用户选择或替换 Preset。需要变化时创建携带新选择的新 turn。

辅助 Skill 规则：

- primary 可以声明精确版本的一跳 `required | optional` dependencies。用户选定的 primary L1、Preset 与全部 required auxiliary L1 是当前 turn 默认必需且版本稳定的核心知识，在首次 Brain 调用前自动加载；optional auxiliary 初始只暴露安全 L0 元数据，由模型按当前任务通过稳定的 `load_skill@1` 增量加载。required auxiliary 不开放给模型重复加载，候选计划终止动作前只校验其核心知识仍完整存在。
- 拆分必须带来真实的渐进加载或共享收益：仅在部分任务动态需要的知识使用 optional auxiliary/reference；被多个 primary 共同依赖的稳定知识可以使用 required auxiliary。若知识对某个 primary 每次都必须加载且不被其他 primary 共享，必须直接并入该 primary 的 `SKILL.md`，不得为了目录形式拆成 required auxiliary 或每轮必读的专属 reference。
- 复杂且单体化的 primary 可按自身方法链采用稳定编号，让任务目标、输入证据、专业决策、质量门禁和修改方法形成清晰路径。编号数量、章节名称与具体顺序不设全局模板，不得把某个现有 Skill 的“一到十”复制为所有 Skill 的固定骨架；简单 Skill 不为形式强制编号。平台执行边界由宿主和 manifest 负责。
- auxiliary 的 `catalog.visibility` 必须为 `internal`，不得再声明 dependencies 或 Preset；依赖图因此固定为一跳，不形成递归 Skill 树。
- 同一辅助 Skill 被多个路径需要时按 `skill_id + resource_hash` 去重，只注入一次，实际资源仍全部进入 turn context snapshot。

旧工程电商内容采用映射：

| 旧工程内容                                                                                                         | 当前归属                                   | 采用重点                                                   | 计划发布                                            |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------- |
| `marketplace-main-image-set`、`amazon-listing-image-set`、`detail-and-infographic-image`、`product-image-critique` | 公开 primary 候选                          | 版位/组图分工、平台合规、动态销售链、诊断而不执行          | S22/S23；诊断能力按后续 SPEC 激活                   |
| 服饰、美妆、食品、家居、宠物、运动、数码类目 Skill                                                                 | internal auxiliary                         | 买家问题、可见证据、事实与声明风险；不指定最终工具/模型    | S11 成包、S12 首版激活；S22/S23 只升级套图/平台知识 |
| `photorealistic-human-commerce-shoot`                                                                              | internal auxiliary                         | 人物身份、穿戴/接触、景别证据、脸部/皮肤真实感             | S11 成包；S12/S13B 按任务激活，S22 可升级           |
| `commerce-visual-art-direction`                                                                                    | 所有电商 primary 的 required auxiliary     | 各层职责、事实账本、证据组合、创意控制粒度、组图一致性     | S12 首版                                            |
| `campaign-style-lock`                                                                                              | 辅助知识或 Preset 约束，不作为公开 primary | 跨图视觉家族、Comparison Lock、Shot Matrix；不生成画布节点 | S22                                                 |
| detail/human `references/*.md`                                                                                     | L2 reference                               | 复杂信息编排、脸/皮肤、事件姿态、光线镜头按需加载          | 随拥有它的 auxiliary 发布                           |

迁移内容必须删除旧画布字段、节点铺设、`promptBrief` 等旧输出协议，并改写成可被其他 Agent 直接使用的创作知识；宿主所需的 `required_capabilities`、输入绑定和执行 profile 写入 manifest，不能成为 Skill 正文的输出要求或执行授权。旧 `SKILL.policy.json` 只能转为宿主 profile 或知识风险提示，不能成为执行授权。每个正式 Skill 必须有正例、反例、事实缺失、跨类目和 prompt injection golden eval，不能只凭旧工程已有测试直接发布。

## 8. 版本快照

每个 `workflow_run` 必须记录：

- Skill 名称和版本。
- Skill definition snapshot。
- Prompt template version 和编译后的 prompt 摘要。
- 模型 ID、Provider、模型版本和能力契约版本。
- Pricing version 和费用估算明细。
- 商品事实版本。
- 平台规范版本。
- 内容安全策略版本。

快照用于申诉、审计、做同款和回归测试。任何已发布版本不得原地覆盖。

## 9. 计划编译

LLM 输出候选计划：

```json
{
  "skill_version": "commerce-white-background@1.0.0",
  "steps": [
    {
      "tool": "background_remove",
      "inputs": ["asset:123"],
      "expected_output": "transparent_png"
    },
    {
      "tool": "image_edit",
      "inputs": ["previous_output", "facts:456"],
      "expected_output": "white_background_image"
    }
  ]
}
```

确定性编译器必须执行：

1. 校验 Skill 是否已发布且阶段可用。
2. 校验引用对象权限和修改权。
3. 校验 Provider 能力是否通过 PoC。
4. 计算费用估算，并校验平台预算、数量和能力上限。
5. 生成 task 列表、幂等键和依赖关系。
6. 对计划 DAG 执行闭环校验：节点必须可达、依赖必须存在、`expected_output` 引用必须能解析、不得形成自环或悬空引用。
7. 固定所有版本快照。
8. 输出可提交计划或拒绝原因。

Compiler 可以确定性规范化 ID、版本、参数和 DAG，但不能把模型候选计划静默改写成另一种审美目标、构图或创意意图。候选计划不合法时必须返回结构化拒绝/缺失项，由 Agent Brain 决定解释、追问或重新提出候选方案。

## 10. Agent 循环契约

1A 采用受限 tool-calling 循环：模型可以多轮选择知识、组合当前 action space 中的工具、解释失败和请求澄清。每个动作都先经过服务端 registry、strict schema 和 ToolPolicy；只有候选生成计划、收费动作与 Provider generation 必须进入确定性编译器和交易链。

```text
Agent Brain
  -> load knowledge / guarded read -> observation -> Agent Brain
  -> answer / clarify -> stop or wait
  -> candidate plan -> Compiler -> quote/confirmation or safe rejection
```

循环限制：

| 限制项                        |                  1A 默认 | 超限行为                            |
| ----------------------------- | -----------------------: | ----------------------------------- |
| 单 turn 最大 LLM 往返         |                        6 | 停止循环，转为追问或人工可读错误    |
| 单 turn 最大工具调用          |                       12 | 停止循环，写入 guardrail 诊断       |
| 同一 canonical 工具指纹执行   | 最多 2 次；第 3 次前阻断 | 拒绝重复调用，要求 LLM 换策略或追问 |
| 单 turn 最大自动重规划        |                        2 | 停止重规划，解释失败原因            |
| 单 turn Agent 大脑 token 预算 |     由 `03` 模型契约配置 | 超限时摘要上下文；仍超限则追问      |
| 单 turn Agent 大脑成本预算    |               由运营配置 | 超限时停止循环，不进入付费生成      |

重规划规则：

- 编译器拒绝计划时，若原因是缺字段、引用不明或 Skill 不可用，Agent 优先追问或解释，不自动硬凑计划。
- 编译器拒绝计划时，若原因是可修复格式错误，允许最多 3 次 schema repair。
- task 执行失败后，Agent 可以解释失败和提出新方案，但不能自动创建新的可收费任务。
- 内容安全拒绝或商品事实缺失时，Agent 不得替用户改写事实；只能提示用户确认、修改输入或发起申诉。

动作策略分级：

| action class             | 示例                                 | 最终门禁                                                      |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------- |
| `knowledge`              | `load_skill@1`                       | Skill published/stage/path/hash/token policy；不经过 Compiler |
| `read`                   | 读取当前用户已绑定的商品、资产或产物 | ToolPolicy + ownership guard；未注册前不可调用                |
| `candidate_plan`         | 生图、编辑、放大等候选步骤           | S09 Compiler 终审 R1-R5、DAG、模型能力、引用和费用            |
| `generation_side_effect` | 真正调用生图/编辑/视频 Provider      | 不直接暴露给 Agent；只由 quote/reservation/workflow/task 激活 |

S13B 的 `MediaTextInspectionPort@1` 属于 Compiler 固定 profile 后由 Worker 调用的内部媒体能力，不是 Agent Tool，也不进入 L0 action space。它只消费已授权 binding ID/version 和固定策略版本，返回 `pass | blocked | unknown`、位置/风险类别摘要与 evidence digest，禁止接收 URL、路径、脚本、字体或任意二进制参数，也不能被 Skill/Brain 动态注册；任何网络支持实现仍必须遵循 Provider attempt 三态，结果 unknown 时 fail closed。实景拼贴与极简拼贴均不声明独立区域合成能力，复用 `image.edit`：Brain 负责照片专属布局、识别层级、删减和抽象决定，并把 Skill 中适用于当前原图的固定任务知识编译为一份简短、完整、可直接执行的 `creative_prompt`；详细用户请求只做结构化整理，不为满足字数扩写。Compiler 固定逐图 `semantic_reference`，Worker 只添加最短图片角色和平台安全封套，不重复追加固定艺术任务书。极简拼贴由 Provider 一次生成完整 `3:4` 上下双联成品，不裁切、不替换上半图、不拼接图层、不自动重做；结果沿既有 quarantined、内容安全、发布和 lineage 链路处理。

`candidate_plan` 的模型输入只承担不可由运行时推导的创作与语义决定。Skill ID、schema/source、单一已准入 capability 及版本、`expected_output`、无依赖节点的空依赖、Skill 固定输出数，以及“每张当前场景附件独立生成”时的一对一 binding，均由冻结 turn context 确定并在 adapter 边界补齐；不得要求 Brain 重复填写后再因遗漏而废弃整轮。`creative_prompt`、场景关系摘要、需要模型选择的来源/引用和其他不可替代的创作决定仍必须由 Brain 提供，运行时不得臆造。仅供完成页展示的 `creative_note` 可缺省，不得成为 Provider 调用门禁。

`实景拼贴·写意纸境` 的结构、纸墨行为、留白和设色由模型按当前 Skill 与源图决定。创作决定使用通用摘要、创作说明和最终提示词表达，不接受 `xieyi_structure` 等专属工具字段，也不要求施工句逐字进入 `creative_prompt` 或用枚举字段差异数裁决作品是否可执行。每张图独立引用、完整最终提示词、来源与能力校验等执行约束保持不变，视觉质量另做出图评审。

`实景拼贴-水彩`（`watercolor-scene-collage`）是独立的内置 primary，承接用户提供的照片与淡彩水彩微缩对照创作方法。manifest 声明通用 `independent_sources` 执行类型，复用单图 `image.edit`、逐源图 `semantic_reference` 和独立提示词校验；每个生成节点使用一张源照片、输出一张海报，不混合多张照片。上半区摄影保真、下半区淡彩微缩小景、留白、纸感和文字取舍由可复制 Skill 与最终提示词决定，不添加专属创作枚举或固定工具输出格式。Provider 一次生成完整作品，保真是视觉目标，不宣称逐像素拼接；执行封套只说明源图职责与遵循最终提示词。内置包更新后重启 API/Worker 生效，不走外部包审批发布。

2026-10-07 起，`cinematic-story-poster`（叙事电影海报）与 `creative-portrait-renewal`（人像焕新）暂停前端新选用，由 API 目录入口策略从公开选择列表排除，manifest 保持合法的 public primary 定义，不改为 auxiliary。外部同名包仍不得覆盖这些内置 Skill。保留正文、评测、执行 profile 与历史快照，历史会话的解析和产物不删除；本次只隐藏选择入口，不停用历史执行路径，重新开放须另行验收。

Provider 已返回工具调用和可信 usage、但参数未通过 strict schema 时，属于“已送达且输出无效”，不是 transport `outcome_unknown`。adapter 必须保留脱敏字段路径和可信 usage，Worker 原子结算该次 Brain 成本，与空输出等协议错误共用最多 3 次带原因、路径和剩余次数的结构化修复；耗尽则以准确的内部诊断收敛。公开文本安全拒绝单独最多修复一次，不占用或重置普通结构修复次数。公网仍只暴露稳定、安全摘要，不得把结构错误描述成图片 Provider 超时或服务临时波动。

2026-10-09 二轮工具纠错：稳定的模型侧 `source_decision` 使用一个 strict object，`mode` 为 `refine_latest | restart_original`，`output_binding_key/reason_summary` 必填，`original_source_binding_key` 仅在 `restart_original` 时必填，在 `refine_latest` 时禁止。不使用嵌套分支让模型猜字段组合；运行时逐字段验证条件，Compiler 的 canonical 分支和 lineage/ownership 校验不变。动态上下文从同一运行时规则派生本轮允许的 intent，明确 source/scope 决策的必填条件和场景 `semantic_summary` 要求，区分成图修改与原图重做，不按 Skill 名硬编码。第一次参数失败即给出受限字段路径、类型/枚举/范围及该决策的完整合法结构指引；不保存原始错误值、未知字段名或模型文本，不只反馈 `invalid_union`。scope 的重复 binding 和总张数仍可由宿主补齐，mode/reason/来源选择不得猜填。修复次数、费用、预算和未知投递规则不变。

方案正反审查：正面是减少模型侧分支与遗漏后的猜测，并保留稳定工具定义及当前任务的显式约束；反面禁止宽松接受未知字段、替模型选择原图/成图、绕过 canonical 校验、增加重试或记录错误原文。按此边界通过方案审查；原生 Google 与 OpenAI/Anthropic 模拟请求验证初次失败的指导、合法修复、非法分支拒绝与稳定工具缓存，不将模拟通过当作真实模型成功率保证。

Skill 的 `required_capabilities` 仅说明完成任务通常依赖哪些能力，不能要求 runtime 开放工具。未知工具、未注册版本、schema 非法、越权读取和非法状态全部 fail closed；拒绝 observation 只向模型提供稳定错误码、是否可重试和安全下一步。

fail closed 针对动作而非默认杀死整个对话：被拒工具绝不执行，但模型在剩余预算内可以回答、追问或换用另一个已注册工具；连续同错、同参重复或无进展才终止 turn。多工具 outcome 必须整批 preflight 后按模型顺序串行执行；业务写工具必须使用服务端稳定执行键和可重放 receipt，不能依赖模型 `call_id` 防重。

每步日志与死循环防护：

- 每个 turn 必须生成 `agent_trace_id`，每次 LLM 调用、工具候选、工具执行、编译器拒绝、guardrail 触发和用户中断都必须写入 step 日志。
- Agent Brain 必须使用 `03` 冻结的独立 strict capability/pricing/quota 契约：模型提供原生 tool calling 与 strict terminal outcome，runtime 提供裁剪后的 L0 Skill catalog 和当前 ToolContract action space。media model 或自由文本正则“解析工具调用”不能冒充 Agent Brain。
- 工具调用指纹为 `tool_contract_version + tool_name + canonical_json(args) + reference_binding_versions + loaded_skill_resource_hashes` 的 SHA-256。同一 turn 内同一指纹最多执行 2 次；第 3 次执行前必须阻断并要求 LLM 换策略、追问或停止。
- canonicalize 由统一纯函数完成：对象 key 排序、去除 undefined、补齐 schema 默认值、统一空集合、decimal/UUID/绑定 ID 规范化；数组只有 schema 声明为集合时才排序，否则保留业务顺序。
- 进展只由服务端真相计算：turn 状态、有效引用 ID+version、新 Skill snapshot、新确认字段、候选计划 hash 和 compiler 结果。回复措辞或 observation 文本变化不算进展。
- 若连续 3 个已完成 observation 的 progress hash 无新增事实、引用、Skill、确认或状态推进，判定为 `no_progress_loop`。
- 若连续 3 次出现相同 `tool_name + args_hash + error_code`，判定为 `repeated_tool_error_loop`。
- 命中循环保护后不得继续调用收费 Provider，不得自动创建 quote；只能返回可读解释、追问用户或进入人工可诊断错误。
- Agent brain 成本和单次模型能力仍取系统硬上限、不可变 model snapshot、运营配置三者最小值；客户端和 Skill 不得覆盖。预算已用量固定为 trace 的累计 actual estimated cost + 未收敛 reserved exposure。LLM 调用前原子增加 exposure，可信 usage 后原子转为 actual；只有明确未发出才能释放。usage 缺失或投递未知保留 exposure，不自动重投；已返回可信 usage 的截断/非法参数按 actual 结算，允许有界的新修复步骤，不猜测为成功。

2026-10-03 多图预算复核：工作单元 `N` 取当前已鉴权附件、可查看的已鉴权会话图片候选和已接受 operational draft 节点数的较大值，最小 1、最大 32。图片候选只包含本 turn 已冻结的有界索引，不计无限历史。单图基础轮数默认 6；额外节点各增加 1 个写作轮，每张额外可查看图片增加 1 个检查轮，不假定模型必定用满每轮 1–4 个工具的批次能力。工具总额度为运营基础额度加额外可查看图片数，仍受同参重复、无进展和三次结构修复护栏限制。累计输出按有效轮数乘单次输出额度并受运营 ceiling 限制；单次默认 8192，受模型能力、上下文剩余空间和累计剩余额度限制。旧 snapshot 的 rounds/output quota 保留作审计，不原地改写。成本、小时/日额度和 272000 active context 上限不变；接管不会重置任何已用 rounds/tools/tokens/cost。

提示词写作可按节点渐进完成：宿主指定本次 candidate keys，模型只返回这些 key 的完整提示词；接受 `authoring_batch` 后，原始 `agent_author_prompts@1` 参数与 usage 在私有 transcript 中捕获，非最终批次以 `authoring_batch_saved` 配对回执闭合。回执固定该调用参数 digest，恢复从已鉴权 transcript 按序合并，仅修改 creative_prompt；重复、未知、漏写或已完成 key 不接受。最终批次与此前成功批次覆盖原草稿所有节点后，才允许合并计划进入 Compiler/quote。失败或重启不得重写成功批次，也不得从部分结果创建收费 workflow。不得把多个模型输出伪装成单次完整调用。

Authoring 输出在结算/捕获前再次核对宿主指定 key。当当前批次与已接受批次产生完全重复的提示词时，由 Compiler 的纯 profile 策略确认是否违反该 Skill 的唯一性规则；仅该规则可转为共享的有界结构修复。此校验不执行网络/数据库调用。保留成功 checkpoint，只重写当前尚未接受的批次，usage 按 actual 结算，不创建报价/预留，也不重投已接受或结果未知的外部请求。相似但不相同的描述不按重复拒绝；不可由 authoring 修改的创意说明、权限、引用、范围及其他编译拒绝不自动修复。

诊断必须区分 Provider `finish_reason=length`、工具 JSON 解析失败和 schema 校验失败。trace 记录本次 requested output、可信 output usage、可用 reasoning token 统计及安全错误类别，不存原始参数；截断反馈明确告知本次预算与下次实际单次额度，要求完成当前批次的合法参数，不以固定字数限制创作。

step 日志最小字段：

```json
{
  "trace_id": "uuid",
  "turn_id": "uuid",
  "step_no": 1,
  "step_type": "llm_call | tool_call | compiler_check | guardrail | observation | interrupt",
  "actor": "agent | compiler | tool | system | user",
  "skill_id": "string?",
  "tool_name": "string?",
  "args_hash": "sha256?",
  "input_summary": {},
  "output_summary": {},
  "status": "started | succeeded | failed | blocked",
  "error_code": "string?",
  "latency_ms": 0,
  "token_usage": {
    "input_tokens": 0,
    "output_tokens": 0
  },
  "estimated_cost": "decimal?"
}
```

## 11. 上下文工程契约

Agent 上下文由引擎组装，LLM 不直接决定读取哪些私有资源。上下文分层：

| 层               | 内容                                    | 写入方           | LLM 权限             |
| ---------------- | --------------------------------------- | ---------------- | -------------------- |
| system           | 系统规则、R1-R5、安全边界               | 代码/配置        | 只读                 |
| skill            | Skill planning view、版本快照、必要引用 | Skill loader     | 只读                 |
| session_summary  | 会话摘要、用户已确认偏好                | 引擎             | 只读                 |
| recent_messages  | 最近 N 轮消息                           | 引擎             | 只读                 |
| bound_references | 已解析的 `artifact/asset/upload` 绑定   | 服务端引用解析器 | 只读                 |
| product_facts    | 用户确认商品事实                        | 事实确认服务     | 只读                 |
| scratchpad       | 当前 turn 临时推理摘要                  | 引擎             | LLM 可建议，引擎裁剪 |

上下文窗口管理：

- `context_window_tokens` 是每次发送给 Brain 的完整 active context 硬上限；当前生产默认值为 `272000`（272K）。它包括稳定 system/tool policy、Skill 知识、session summary、保留历史、当前输入、observation，以及本次实际物化的视觉输入，不是单条消息上限，也不是跨多轮累计上限。
- `auto_compact_token_limit` 是自动压缩触发阈值；当前生产默认值为 `217600`（272K 的 80%）。`inputTokenTotal` 只用于可信 usage、成本和监控统计，不参与“本轮还能不能继续”的上下文判断。每次采样前和工具结果写回后都必须重新计算 active context。
- 272K 是当前平台成本政策上限，不是所有 Provider 的统一计费阈值。有效窗口取平台配置、模型能力及模型 quota 输入窗口的最小值；配置覆盖不得超过 272K。旧模型快照保留原登记值并允许读取，不原地改写历史，但其实际调用仍受当前平台上限约束。
- 调用前 token 估算不能把图片二进制序列化成文本，也不能把所有厂商图片都按 4096 像素原图统一计费。已识别的 OpenAI 模型使用本地 tokenizer 和对应视觉 patch/tile 规则；Gemini/Anthropic 视觉输入使用各自公开规则及安全余量。未知 tokenizer 使用 UTF-8 字节上界，未知视觉模型使用保守回退，不声称跨厂商精确计数。摘要和主调用使用一致的文本估算。上游可信 usage 仍是结算真相，mock 回归不替代真实 relay 校准。

- 完整消息历史保存在 PostgreSQL；模型输入是由引擎派生的滑动窗口，窗口管理不删除或覆盖历史消息，隐私撤销和到期清理仍遵循 `08`。窗口按模型 snapshot 的 token 上限计算，不按固定消息条数截断。
- 压缩软阈值同时预留本步最大输出和 Provider framing 安全余量；超过阈值时从最新消息向前累计 token，保留预算内最近完整 turn。正常切点只能位于已终局的完整 turn 边界，不得拆开 assistant/tool、确认卡或同一 continuation；当前 active turn 自身超限必须 fail closed，不用 turn-prefix 摘要吞掉尚未完成的状态。
- 被窗口移出的终局 turn 压缩为 strict `session_summary`。若待压缩历史自身超过压缩模型窗口，必须从 summary 边界后的最老连续完整 turn 开始分批摘要，不得跳过中间 turn。重复压缩以 previous summary + 新增终局消息增量更新，摘要必须记录摘要版本、来源消息 ID/digest、覆盖到的终局 turn、生成模型 snapshot 和 usage，不保存 chain-of-thought、原始工具结果或图片二进制。
- `legacy_v1` 压缩输入只包含历史 user/assistant message 和上一版 `session_summary`；`transcript_v1` 按下节包含已闭合的语义历史安全投影。两者均不得概括、改写或替代 primary/required auxiliary/Preset `skill_knowledge`。Skill 稳定前缀独立于会话消息压缩，版本与资源 hash 不变时字节内容和排序必须保持稳定。
- 摘要只可保留用户目标、用户明确偏好、约束、用户已确认决定、待解决问题和继续任务所需的安全引用提示；不得把模型推断、未确认候选、旧附件权限、商品事实或执行授权升级为真相。商品事实、引用权限、模型/Skill 选择和费用仍从服务端快照或当前数据库重读。
- 摘要调用使用同一 turn 已固定的 Agent brain，计入 rounds/token/成本并写 trace。摘要请求裁剪工具 observation，只发送 strict 安全摘要；结果必须通过 schema，普通文本或工具调用均视为非法。
- summary 更新使用 `session_id + expected_summary_version` CAS，`summary_through_turn_id` 只能向已终局 turn 单调前进。压缩结果与 usage/成本收敛及 summary CAS 原子提交；CAS 冲突重读，不能覆盖较新摘要。压缩不可用或失败时，若原上下文仍低于硬上限可继续使用旧 summary + 未压缩窗口；达到硬上限时允许只对本次模型 working set 从最早完整终局 turn 开始逐组回收并重新计数，始终保留当前 active turn。完整 PostgreSQL 消息历史不得删除，`summary_through_turn_id` 不得跳过未摘要消息；当前 active turn 自身仍超限时 fail closed，不把错误文本当摘要，也不拆分 user/assistant/tool 边界。
- 模型上下文顺序固定为稳定 system/tool policy、有边界的会话 primary Skill/required auxiliary/Preset `skill_knowledge`、session summary、最近完整语义历史和追加的服务端上下文更新。`legacy_v1` 的当前输入/observation 由旧格式组装；`transcript_v1` 中它们已经在历史里，不得再次注入。Skill 正文不得硬编码或复制进通用 system prompt；动态摘要不得插到 system/核心 Skill 之前。缓存未命中也必须显式携带完整有效上下文。
- 图片附件默认只进入授权引用索引（opaque binding ID、角色、尺寸、hash、lineage），不携带图片二进制。Brain 需要看像素时只能调用宿主注册的 `inspect_image`，由 Worker 再次校验归属、生命周期、hash、MIME 和尺寸后，在本 turn 的受控 visual working set 中按 `overview/detail` 临时物化；overview 使用更小的等比预览，detail 才使用配置的最大边长（当前默认 4,096 像素）。单个 Worker turn 的物化图片 payload 总字节默认不得超过 64 MiB，单张仍受 20 MiB 存储图片上限约束；同一 binding 从 overview 升级到 detail 时替换旧 payload，不同时保留两份。trace、summary、数据库消息和 SSE 永远不保存图片二进制、路径或签名 URL。
- 产物缩略图进入上下文前必须通过引用绑定和权限校验。
- 每个 continuation 固化只含 ID、版本、hash 和预算的 `context_snapshot`；需要多轮改图时还应固化服务端解析的最新会话产物、原始源图、稳定序号和 lineage 候选，但不得包含图片二进制、签名 URL 或完整 prompt。该候选池是 Brain 的可选上下文，不是默认 Provider 输入；Brain 必须按当前成图是否仍包含完成要求所需的视觉证据，结构化选择 `refine_latest` 细调当前成图或 `restart_original` 回源建立新分支，并给出不含 chain-of-thought 的安全依据摘要。Runtime 不得解析关键词或代替选择，Compiler 只校验该选择、intent、binding 与 lineage 自洽并投递被选中的 binding。所有晚到状态写使用 turn owner/revision CAS。确定性编译前还必须重新校验关键引用和事实版本，不能只信旧 hash；消息摘要不得替代或压缩掉候选快照。
- 若会话未产出已发布图片，候选池从当前 turn 之前最近的同会话用户消息恢复原始图片，重新校验 owner、生命周期、hash 和版本并冻结顺序。只有 `original_source` 而没有 `latest_output` 时不要求 `source_decision`；Compiler 仍校验图片职责、选中 binding、生成 intent、权限和模型能力，不将源图候选直接当作 Provider 输入。失效图片不能被更早一组静默替换。
- 部分生成成功时，若最近的用户源图组与最新产物的真实 lineage 相交，应保留该组全部仍有效的原图及原顺序，不能只恢复成功图片的源图。若最新源图组晚于最近有产物的 workflow，优先恢复该组，不混入旧组产物。候选解析只读取当前 turn 创建前的历史，回溯必须限定用户归属并校验原始 binding 的版本/hash；失效、跨用户或版本漂移的源图不构造 lineage。仅选择没有任何候选产物后代的 `original_source` 重新生成时，不要求虚构 `source_decision`；选择已有成图或其关联原图时仍遵循原有决策与 lineage 校验。
- 长会话中在 9 张源图候选上限内，恢复最早组及最近最多 9 个上传组（含中间组），按上传时间、消息 ID、组内位置排序去重；与最新成图的 lineage 按实际来源重新绑定。查询窗口外的旧组可通过可分页的已有资产入口显式选取，不承诺任意自然语言指代都能从无限历史自动定位。最新上传组失效时不得静默用较早组替代；组内仅部分图片失效时保留其余通过归属、生命周期及 hash/version 校验的图片。最新一组已发布成图最多 16 张，源图最多 9 张，两类候选分别编号。自动候选并集超限时不得截断、错选或阻断纯文本讨论：当前 turn 冻结“自动候选不可用”，不向 Brain 提供部分图片；图片任务引导用户从已有资产库选取目标图作为本轮附件，不要求重新上传。候选和历史提示不是本次生成授权，也不会自动进入 Provider 输入。
- 公开创作过程与正式回复不得暴露模型私有推理。运行中显式 `agent_respond` 工具入参或原生 `chat_text` 的已校验文本前缀可作为可撤销草稿流式预览；reasoning token、候选计划及其他工具参数不得进入公开文本流。草稿不代表成功终态，不参与报价、预留、权限或账本。

指代绑定协议：

```text
用户自然语言 / @引用 / 附件
  -> LLM 输出结构化引用意图
  -> 服务端引用解析器绑定 artifact_id / asset_id / upload_id
  -> 编译器校验权限与修改权
  -> 绑定失败时追问，绝不进入付费链路
```

`todo_json` 写入权：

- `todo_json` 是会话展示状态，由引擎根据 turn、quote、workflow、task 状态单向写入。
- LLM 只能建议待办文案和步骤摘要，不能直接写 `todo_json`。
- `todo_json` 不作为运行时真相；真实状态以 `workflow_run/task/task_attempt/artifact` 为准。

### 11.0 会话语义历史扩展 (2026-09-07)

**范围修订 (2026-09-09，用户明确取消旧会话兼容)**：本次 P1 + P2 只交付新会话的 `transcript_v1/1` 路径，不交付旧消息回填、v1 summary 转换、legacy 双执行、旧 turn 恢复或旧格式回滚。本节和下游文档原有相关迁移/排空义务不再是本次门禁。P1/P2 仍是实现顺序，不要求上线影子运行阶段；新路径完整验证前不启用。新会话自身的幂等、租约、结果未知处理、pending operation 恢复、生命周期和 summary v2 不变。旧会话清理仅限已确认的本地会话范围，不能整库重置或删除资金/业务证据；残留旧会话不得静默进入新执行路径。

本节裁决 S08 transcript 扩展的目标行为，不声明现有代码已实现。内部按 P1 影子记录、P2 完整切读、P3 可选优化串行交付；P1 不是完整记忆改造的验收终点。具体表和迁移由 `05`、实施与切换门槛由 S08 第 17 节裁决。

**唯一历史与职责**

- 每个 session 维护一条有序、持久化的语义历史。`agent_transcript_items` 是新格式的消息/调用/结果真相，`chat_messages` 只是用户投影，trace 只作脱敏诊断；权限、资金、执行进度仍以业务表为准。不能把三者拼成互相冲突的记忆。
- `packages/agent` 拥有 strict item schema、协议配对、上下文投影和循环策略；API/Worker repository 拥有租户校验、短事务追加、owner/revision/continuation fencing；Provider adapter 只把已验证的语义历史转换为其原生消息。Processor 不另写阶段专用循环。
- planning、prompt authoring 和后续工具观察共用此历史。用户消息只追加一次；阶段、剩余预算和服务端事实变化使用带来源和版本的 `host_context`，不得伪装为用户新指令。兼容 `recent_messages/observations/authoring_plan` 的字段只能从同一历史派生，不能继续独立写入。
- 完整持久化不等于每次把全部历史塞入窗口，也不保证恢复模型的隐藏推理。只保存验证通过的语义输出，不保存 chain-of-thought、原始 Provider body、完整系统提示词或完整 Skill 副本。

**一次模型/工具推进**

1. 读取该 turn 的执行格式和同一 session 历史；核验当前资源权限、版本与预算，处理待恢复调用，再生成有界模型视图。
2. 外部模型调用前按既有规则持久化 step 与 exposure。成功输出通过 strict schema 后，完整 assistant 输出/有序调用批次与关联 usage 原子提交，提交前不得执行批次中的任一工具。
3. 工具执行仍由 ToolPolicy、Compiler、Credit 和领域 operation/attempt 裁决。assistant item ID + call ordinal 是协议身份；`operation_key` 是业务幂等身份，两者不能互相替代。
4. 每个调用至多一个语义结果；调用整批先落库，结果在下一次 Brain 调用前落库。首个失败后的未执行成员写明确 `not_executed`，不能伪造成功或丢掉工具协议配对。terminal action 同样闭合其协议结果。
5. replay projector 只读和规范化，不执行工具。崩溃在执行前只恢复原 pending operation；执行后查已提交的领域 receipt/attempt；`accepted/outcome_unknown` 不自动重投。缺少本地结果不证明外部未执行。无法确认的 Brain 回执继续遵守既有 unknown/exposure 规则。
6. 异步生成工具返回已提交的任务/工作流 receipt 即结束本次调用，后续产物状态追加带原 attempt/turn 来源的 host event，不覆盖旧结果，不把迟到产物挂到用户新建的重试分支。

**稳定前缀与上下文**

- 平台 policy、当前已注册工具和 terminal schema/description 按 contract version 固定内容与顺序；同一合同版本下不按阶段、附件未检查状态或 Skill capability 增减工具。动态约束放在尾部 typed context，并由确定性校验执行，工具存在不代表获授权。
- 2026-10-02 工具输入精简：模型只填写语义决策。候选计划的 `schema_version/skill_id/source` 与既有节点默认字段可省略，由宿主补齐后再经过原严格计划校验；显式填写的冲突或未知字段不能被默认值覆盖。`scope_decision.mode/reason_summary` 仍由模型决定，重复的 `input_binding_keys/output_count` 可省略并从所选节点及其张数确定性计算，显式声明不一致仍拒绝。这不授予图片权限、不选择历史图片，也不改变 Compiler、报价或执行授权。
- 每个模型可填写字段的稳定 description 必须说明含义、来源、必填条件和省略行为；动态值、当前可用 binding、阶段和当前 authoring key 只进入尾部上下文。规划草稿中的空白 `creative_prompt` 视为未编写并移除，正式单次计划和 authoring 的提示词仍必须非空。澄清工具只有 `question` 必填，`suggestions` 可省略，不要求模型为普通问题构造空数组。
- 核心 primary/Preset/required auxiliary 在首次调用前按用户已选快照完整加载；后续内置版本只影响新 turn。optional auxiliary/L2 在原加载位置保留受控引用，不能每轮移动到更早的前缀，也不能为缓存强迫模型预加载。
- 投影顺序为稳定 policy/工具、带来源的核心知识、有效 summary checkpoint、有序历史窗口、追加的当前权威更新。相邻步骤中已存在消息不改写、不重复；仅发生事实/预算/phase 变化才追加相应更新。
- 图片保留 binding、版本/hash、角色和 inspection detail。每次物化重新核验归属、生命周期和内容一致性；同 binding/hash 只物化一份。overview 升级 detail、资源失效、删除或知识版本变化都属于投影改变，不能假装仍是完全相同的旧前缀。
- 对需要 call/result 相邻的 wire 协议，可把一个已闭合批次的结果按 ordinal 放在其 assistant 后，期间到达的 host/user event 保持相互顺序放在批次之后；保留原 sequence/provenance 映射。未闭合批次必须先恢复/关闭，不在其间继续调用模型。
- P2 的稳定前缀、正确 token 计数是基础正确性；`previous_response_id`、厂商 cache key/retention 参数和可选 Todo 属于 P3。Todo 可由模型提出而非必填；它不能授权收费或代替业务进度，也不新增固定三轮或嵌套循环。

**压缩与降级**

- 新格式 summary 覆盖连续、已终局、全部协议调用已闭合的历史范围；摘要输入是这些 user/assistant/host/tool item 的安全语义投影及旧 summary，不是 trace 原文。保留用户纠正、目标、决定、未决问题和结果引用，不提炼或改写核心 Skill 知识。
- checkpoint 记录 source sequence 范围、source-content digest、history generation、summary version、来源 turn 和本次模型/usage；digest 必须包含内容或受控 payload 的内容 hash，不是仅散列 ID。发布时校验来源仍完整、权限仍有效，以 session + generation + summary version CAS 与 usage 收敛同事务提交。
- 已取得可信模型用量后，发布时发生 generation/version 冲突或资源权限撤销，只拒绝发布该 checkpoint，仍须幂等结算已知用量并释放对应模型费用预留。继续执行前重新读取并鉴权历史，不得使用被拒绝的摘要。来源完整性、调用归属校验失败或数据库查询失败仍回滚，不得作为普通权限撤销吞掉。
- 累次压缩的 checkpoint 覆盖从首项开始的累计前缀；正文使用旧摘要时，来源 turn、内容 digest 和资源依赖也必须包含旧摘要覆盖范围。每次将摘要送入模型前重新鉴权其全部依赖；摘要不能成为已删除、隔离或撤销资源的旁路。发布须证明范围内全部 turn 已终局且每个 call ordinal 已闭合，不可只检查最后一个 turn 或每批的一个结果。
- 已收到明确模型 usage 后，摘要 CAS 冲突仍须幂等收敛该次模型成本，保留当前 checkpoint 并返回重读结果；不得回滚已知 usage 为未知，也不得为同一次压缩自动再调用模型。压缩轮数与 token 用量计入本 turn 的同一预算，压缩后须再次检查余量才可请求下一步模型。
- 压缩会改变模型投影并推进 generation；普通尾部追加不推进 generation。删除/隔离使旧摘要可能泄露撤销内容时立即使其不可用。并发冲突保留旧 checkpoint 并重读，不跳过未压缩范围；未知调用不得因 CAS 或压缩失败自动再请求一次模型。
- active turn 的目标、当前阶段、未决调用与结果必须保留；超大工具结果在采集时使用有界 strict 数据或受控引用，不按字符切断可执行 JSON。原窗口仍能容纳时保留旧 summary；硬上限时仅允许已有的完整终局组 working-set 降级并记录覆盖缺口，active 本身超限则 fail closed。持久化历史不因窗口不足删除。

### 11.1 Skill 渐进式加载

自由创作是用户文字/提示词主导的通用从零生图入口，不是无主 Skill 的运行旁路。它不配置风格 Preset；首次调用只预载自身简短的通用 L1，不加载专门艺术主 Skill、预置风格或 auxiliary/L2 全文。共享创作知识均为 optional，按请求需要动态加载。用户已明确的主体、构图、风格、文字与约束优先，完整提示词不强制重新构思；设计师方法仅补充用户尚未决定的表达，不覆盖明确决定。工具、身份、资金、内容安全和编译校验保持不变。

阶段 0 采用三层渐进式加载，避免把所有 Skill 文档塞进上下文：

| 层级             | 加载内容                                                                       | 触发条件                                                        |                    上下文预算 |
| ---------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------: |
| L0 catalog       | 已选 primary 与其 optional auxiliary 的 `id/name/description/kind`             | 每个 turn 默认可见                                              |    不超过 Agent 上下文预算 2% |
| L1 planning view | 主 Skill、required/optional auxiliary 的紧凑 planning view、风险边界和引用索引 | primary 与 required auxiliary 自动预载；optional 由模型按需加载 | 单 Skill 默认不超过 4k tokens |
| L2 reference     | `references/*.md`、模板、脚本说明、平台规范片段                                | L1 明确引用且当前任务需要                                       |        按需读取，不得全量预读 |

Skill loader 规则：

- 新会话的第一次 turn 请求必须携带用户选择的精确 primary `slug@version`，并把 primary `slug` 固定为会话创作方向；同一会话后续 turn 必须继续提交该 slug 当前可用的精确版本，不得切换到其他 primary。开始新的创作方向必须新建会话。未选择、会话方向冲突、不可见、非 primary、未发布、阶段不符或版本漂移均在首次 Brain 调用前 fail closed；模型不得自动选择或静默替换主 Skill。内置 Skill 升版后，同一会话的新 turn 使用当前进程加载的同 slug 最新版本，正在执行的 turn 保持原快照。
- 服务端只向模型提供已选 primary 和它声明的 optional auxiliary L0；模型不能枚举全站 Skill，也不能调用另一个 primary。
- turn 创建时冻结 primary、用户所选 Preset、required/optional auxiliary 的精确 resource snapshot 与 hash。runtime 在首次模型调用前自动加载已选 primary L1、Preset 与全部 required auxiliary L1，构成按 `primary version + resource hashes` 稳定复用的核心知识块；Preset 计入资源/input-token 知识预算但不作为独立 Skill 计数。不得预载 optional auxiliary 或 L2。
- required auxiliary 不开放给模型重复加载；optional auxiliary 只能以主 Skill definition 声明的精确版本调用 `load_skill@1`，由模型按当前任务决定。模型重复请求已加载 optional snapshot 仍消耗一次模型 tool-call 配额，但不重复注入正文 token。
- 会话第一轮可以投影一次核心知识加载活动；同一会话后续 turn 静默恢复稳定知识块，不再重复显示“正在加载专业知识”。可选 auxiliary/L2 的真实动态加载继续按调用投影活动。
- Brain 的平台 policy、terminal tools 与业务工具 schema 按 contract version 固定内容和固定顺序组成稳定前缀；L0 catalog、当前消息、会话摘要、已加载知识、tool observation 和剩余预算只进入前缀后的动态消息。不得把每轮变化的 observation/budget 拼入 system prompt，也不得因 Skill 选择动态改写工具 description/schema。缓存未命中不能改变权限、计费或执行语义。
- 进入某个 Skill 后，loader 读取该 Skill 固定版本的 L1 planning view，并记录 `skill_snapshot_hash`。同 turn 不允许用 `latest`、版本范围或另一个版本静默替换。
- `SKILL.md` 可以引用同目录 `references/*.md`，但引用必须显式列在 `references` 清单中，禁止运行时根据正文自由路径遍历。
- 引用深度默认只允许一跳：`SKILL.md -> references/*.md`。若 reference 再引用 reference，必须拆成 catalog 条目或在编译期展开索引，不在运行时递归加载。
- 路径只允许规范化的 `references/[a-z0-9][a-z0-9-]*.md`；absolute path、`..`、反斜杠、URL、percent-encoded path、symlink 逃逸一律拒绝。
- L2 引用文件必须按 `path + content_hash + version` 写入数据库不可变快照，再写 KV 只读缓存；同一 turn 重复读取同一 hash 时只返回缓存摘要。
- Redis miss/故障时从数据库 snapshot 读取；数据库 snapshot 是运行时真相。已存在的 `skill_id + resource_path` 与发布包 hash 不同即版本漂移并 fail closed，禁止 fallback 正文或静默覆盖。
- L1 单 Skill 默认不超过 4k tokens，同时最多 6 个 Skill、12 个 L2 reference；文件大小、单层和总 token 预算任一超限都拒绝，不静默截断成不同语义。
- 运行时上下文只放必要片段和摘要；完整私有 Skill 文档、脚本源码和内部评测样本不直接暴露给用户。

Skill 作者工作区推荐结构：

```text
commerce-white-background-package/
  skill-package.json
  skills/
    commerce-white-background/
      SKILL.md
      presets/
        clean-studio.md
      references/
        taobao-main-image.md
        fact-checking.md
  evals/
    commerce-white-background.jsonl
  assets/
    cover.webp
    clean-studio.webp
```

作者工作区本身不是运行时目录。`pack` 只把 manifest 白名单中的数据资源写入 `.skillpkg`；测试脚本、构建配置、README、Git 元数据和其他开发文件即使存在于工作区，也不得进入安装包。Skill 需要的确定性行为必须由平台已注册 Tool 提供，不能通过包内脚本实现。

`SKILL.md` 是可复制的 Skill 作者入口，frontmatter 只承载通用发现信息，正文是该 Skill 的 L1 planning view。最小 portable frontmatter：

```yaml
name: commerce-white-background
description: 用于商品白底精修、主体保持和可见文字保真；不用于画布节点编辑。
```

`SKILL.md` 可以使用 Codex 支持的可选 `metadata`，但不得加入宿主专用字段。包 manifest 的 `skills[]` 只保存 `skill_id/definition_path/definition_hash` inventory；同一 manifest 的 `skill_profiles[skill_id]` 保存 ecom-forge 的 `display_name/kind/category/domain/stage/catalog/required_facts/required_inputs/required_capabilities/default_output_count/preset_slots/dependencies/references`。其中 `skill_id` 必须严格等于 manifest profile 的 `${slug}@${version}`，并与可移植 frontmatter 的 `name` 对应；`definition_hash` 必须等于规范化完整 `SKILL.md` 的 hash；任一不一致即拒绝整个包。服务端 `definition_json` 只能由已验证的 Markdown、manifest profile、正文资源索引和资源 hash 确定性编译，禁止 last-write-wins 或在两个来源中选一个“看起来合理”的值。

`required_capabilities` 只是依赖提示，不注册、不启用也不授予工具。发布包 strict schema 不接受别名或未知字段；旧 Skill 如需迁移必须发布新版本，不能在运行时静默改写已发布正文。`presets/*.md` 只能由同一主 Skill 的 `preset_slots` 精确声明；auxiliary 不允许该目录。

KV 缓存键约定：

```text
skill:{slug}:{version}:catalog
skill:{slug}:{version}:planning_view
skill:{slug}:{version}:ref:{path_hash}:{content_hash}
skill:{slug}:{version}:eval:{dataset_hash}
```

外部 Skill 的 KV 只缓存不可变发布版本和只读摘要；`draft` 外部 Skill 不进入可收费路由，也不得复用 published 版本的 KV key。内置 Skill 按当前工程内容 hash 缓存，重启后重新建立 key。

### 内置内容更新口径（2026-10-08）

- 已列入资源清单的内置 `SKILL.md`、frontmatter、Preset 或 reference 只改对应文件。本地内容校验和进程加载均从真实字节在内存中重算 definition/resource hash、byte_size 和 package/catalog digest，不回写源 manifest，不要求递增语义版本或修改代码版本清单。新增/删除资源、目录可见性、能力、依赖或 Preset 索引变化才更新 manifest。
- 当前进程使用一次性加载的内容快照；API/Worker 重启后新建 turn 采用当前内容，包括旧会话新轮次。已执行 turn 的实际资源 hash、正文快照和身份记录不改写；API 与 Worker 内容不一致仍按漂移拒绝，不热切换执行中内容。
- 审计与复现按实际 definition/resource/package/catalog hash 区分内容修订，语义版本保留给配置契约升级。校验仍覆盖可移植 frontmatter、引用边界、必需资源和 golden dataset；内容意图变化按风险补评测，普通文字调整不要求同步固定文案断言。
- 内置启动校验与运行加载共享内容目录发现规则，从各包 manifest 读取 Skill、资源、依赖与评测清单；不在 TypeScript 中维护包路径、Skill slug 集合、专属章节或艺术检查项的第二份名单。启动门禁保留结构、安全、唯一身份、执行类型、依赖和 golden dataset 校验；艺术方法和期望检查留在内容及其评测数据中，实际审美验收不由关键词匹配代替。
- 正面审查：沿用已实现的内置启动哈希与运行快照机制，消除手动摘要、版本清单和正文的多点同步；不新增发布流程、数据库字段或工具参数。反面审查：自动摘要不得掩盖外部包 drift，不得自动发现/授权未列入清单的文件，不得用同一进程读到的新正文覆盖正在执行的旧快照。外部 `pack`/安装/发布继续按源 manifest 严格验证哈希与版本。

### 11.1A 内置 Skill 与外部 Skill 的边界

工程内置 Skill 位于 `packages/skills/content/`，属于第一方发布物，不进入管理台的 package/release 状态机。API 和 Worker 启动后从同一工程内容目录读取，manifest 在此路径只提供资源清单和宿主配置，校验与运行均按当前文件重算 hash；修改已列入清单的内容后只需校验并重启 API/Worker，不要求手动更新摘要或记录版本。新的 turn（包括历史会话继续创建的 turn）使用最新内置内容，实际 hash 快照记录修订。内置 Skill 不需要上传、审批、发布、激活或手动切换 catalog。

外部 Skill 包才遵循本节的 quarantine、校验、审批、发布、停用和回滚流程。外部包的精确 ID 不得覆盖内置 Skill；内置 Skill 的运行时内容也不得从外部数据库快照回退。

同一会话的新请求保留用户选择的内置 Skill 身份，使用其最新内容。历史 transcript/summary 中的旧内置资源引用只作为来源证据：必须与同用户、同会话、已结束 turn 的不可变 selection snapshot 及其 hash 精确相符，不能仅凭 slug 接受伪造引用。历史知识正文若已被更新则不再物化，仅保留原工具调用/结果及资源元数据；不得把新正文标成旧 hash，也不得因此阻断新 turn。当前执行仍加载当前 Skill，外部资源的实时授权与停用规则不变。

### 11.2 可安装 Skill 包与维护模型

Skill 扩展必须是“安装不可变包”，不是改 Agent 核心代码、覆盖服务器目录或把 Git 仓库直接变成运行时。S08 冻结纯包格式、校验器和安装领域端口；S14 在独立管理台提供上传、校验、审批、发布、停用和回滚。创作平台只读取公开 catalog，不出现安装入口。

标准包扩展名为 `.skillpkg`，容器格式固定为 ZIP，根目录固定为 `skill-package/`。包摘要基于 canonical manifest 与资源 hash，不依赖 ZIP 时间戳、压缩器或 entry 顺序；官方 `pack` 必须固定 entry 字典序、UTF-8 文件名、Unix `/` 分隔符和归零时间戳，保证同一输入可复现。解包前后都必须防 zip-slip、symlink/hardlink、绝对路径、`..`、反斜杠与大小/文件数炸弹。

```text
skill-package/
  skill-package.json
  skills/<slug>/SKILL.md
  skills/<slug>/presets/*.md
  skills/<slug>/references/*.md
  evals/*.jsonl
  assets/*
```

`skill-package.json` strict schema 固定：`schema_version/package_id/package_version/min_runtime_version/skills/skill_profiles/resources/eval_datasets/assets/source_provenance/license_summary`。`skills` 只列精确 `skill_id`、definition path 与 definition hash；`skill_profiles` 保存宿主运行所需的非正文 profile，且每个 key 必须对应一个 `skills[]` 项。`resources/eval_datasets/assets` 列出每个相对路径、用途、media type、byte size 和 SHA-256。`source_provenance` 只允许 `first_party | legacy_owned | admin_upload` 与非敏感来源摘要；`license_summary` 必须逐项覆盖包内资产和外部方法来源。计算 `package_digest = sha256(canonical_manifest + ordered(path + content_hash))`，另记录 transport archive 的 `archive_sha256`。未知字段、未列文件、重复/case-fold/NFC 冲突路径、manifest/frontmatter/profile 身份或 hash 不一致、动态 URL 资源、二进制 Skill 正文或缺少权利声明均拒绝。

阶段 1A 的硬上限为：压缩包 32 MiB、解包后 128 MiB、256 个 entry、单文本 1 MiB、单图片 16 MiB、解包 10 秒；运营配置只能取更严格值。允许的内容类型仅为 UTF-8/LF Markdown、strict JSON/JSONL，以及经过 magic-byte 校验并会在发布前去元数据重编码的 PNG/JPEG/WebP。HTML、SVG、PDF、字体、嵌套 archive、设备文件和扩展名/MIME/magic-byte 不一致一律拒绝。

安装阶段只允许数据资源。Skill 包不得携带或执行 `package.json` scripts、Node/Python/shell、原生二进制、WASM、容器、网络安装 hook、Provider adapter、ToolContract、数据库 migration 或环境变量。未来确需确定性脚本时，必须作为平台代码中独立评审、编译期注册且沙箱化的 Tool 发布，不能借 Skill 安装扩大执行面。

安装、审批与发布是三条分离的生命周期，不能把“包已通过检查”误当成“当前线上已启用”。流程固定为：

1. 将 archive 写入隔离 quarantine storage，完成 transport hash、大小和 entry 初检；不进入运行目录，也不创建 Skill/catalog row。
2. 创建不可变 validation attempt，通过 `evaluation` 队列交给隔离 evaluator。解析 manifest 与全部内容为 `unknown`，执行 schema、路径、UTF-8/LF、hash、token、依赖一跳、Preset 归属、stage、资源权利、敏感信息和越权指令扫描；manifest/frontmatter 双重声明或不一致必须作为结构错误拒绝。
3. evaluator 在无网络、无 Provider、无用户数据、无生产 Key 的环境运行包自带 eval 与平台强制负例；包内期望结果只是测试输入，不能自行裁决通过。Worker 崩溃由 lease 接管，同一 report ID 只生成一份最终报告。
4. 生成追加写、不可变的 validation report。失败包可在 validator/eval suite 升级后创建新 attempt，但旧报告不覆盖；`ready_for_review` 只表示最新报告通过，不代表已审批或已发布。
5. 审批必须固定 `package_digest + validation_report_id + validation_report_digest + validator_contract_version + platform_eval_suite_digest`。审批事务把已验证文本物化为不可变 `skills/skill_resource_snapshots`，引用事先写好的内容寻址对象；事务内无下载、解包、模型或 Provider 调用。审批不创建或切换 release。
6. release 是完整 catalog 快照，不是 delta。创建 draft 时从一个明确 base release 应用增删改并解析为完整 package/Skill/resource closure；任何缺失、disabled package、版本范围、跨 release 依赖或 hash 漂移都拒绝。
7. 发布只以 expected catalog revision 原子切换 active release，并在同一短事务把旧 active release 标为 retired。新 turn 看到新 release；历史/运行中 turn 继续使用原 selection/resource snapshots。
8. 回滚创建新的单调 release 序号，复用目标旧 release 的完整已审批 manifest 后再原子切换；不重新激活或改写旧 release，不删除已安装版本或历史快照。

版本规则：同一 `slug@version` 或 `package_id@package_version` 若 digest 相同则安装幂等重放；digest 不同必须报冲突，禁止覆盖。一个精确 Skill ID 只能由一个 package record 拥有；其他包需要它时声明精确 dependency，不能把相同 Skill ID 再打包一份。依赖必须由同一 draft release 中的精确已审批版本满足，不能用 `latest`、范围、别名或联网临时下载。package `disabled` 是终局安全熔断：立即从公开 catalog 投影中移除所有直接或间接依赖它的 primary，并拒绝新 turn；恢复必须发布新 package version 和新 release，不能原地重新启用。只要仍被 turn/workflow/eval/release/audit 引用，就不得物理删除。

Skill 工具链必须提供以下稳定命令，所有命令复用 `packages/skills` 的同一 strict schema/canonicalizer，不维护第二套规则：

| 命令                                                               | 作用                                                                       | 安全边界                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm skill:scaffold -- <slug> ...`                                | 创建最小作者工作区和示例 eval                                              | 不访问 DB/Redis/网络；目标目录已存在即失败       |
| `pnpm skill:pack -- --source <dir> --output <file.skillpkg>`       | 生成可复现 archive、manifest、resource hash 与 package digest              | 只收 manifest 白名单；不自动修正文或版本         |
| `pnpm skill:validate -- --archive <file.skillpkg> --report <path>` | 本地运行纯结构校验和 fake 平台负例                                         | 无网络/Provider/生产 Key；退出码反映 pass/fail   |
| `pnpm skill:diff -- --from <old.skillpkg> --to <new.skillpkg>`     | 输出 manifest/Skill/Preset/dependency/resource/eval 的结构化差异和风险等级 | 默认不打印完整私有正文；不自行批准 semver 或发布 |
| `pnpm skill:install -- --archive <file.skillpkg>`                  | 将候选包写入 quarantine 并创建正式 validation attempt                      | 仅 `APP_ENV=local                                | test`；调用与 S14 相同领域 Service，不直接写表 |

`scaffold/pack/validate/diff` 属于作者工具，不产生运行时状态；`install` 只完成候选安装和验证，不隐含 approve/publish。S08 本地验收可通过独立受控命令审批并发布 fixture，但必须显式给 package/report/release ID、expected revision 和 reason；staging/beta/production 一律等待 S14 Admin Auth/MFA/permission。所有 CLI 只接受本地文件路径或 stdin，不接受远程 URL，不绕过 validation/eval/审计；路径不写入通用日志或审计正文。S14 管理 API 只提交已上传的 package artifact ID，不得让管理员输入服务器路径、Git URL、任意下载 URL 或命令。

版本号语义由人审最终裁决：删除/重命名 required input、Preset slot、dependency 或改变不兼容行为至少升 major；新增向后兼容的可选能力通常升 minor；不改变输入/依赖契约的文案和质量修复可升 patch。`skill:diff` 只能给出最低风险提示，不能通过近义文本比较证明行为兼容。

已审批和已发布 package 仍需支持重新验证。validator contract、平台强制 eval suite、许可证政策或安全扫描规则升级时，系统为原 package digest 创建新的 validation attempt，不改写原报告。新 attempt 失败不会篡改历史 turn，但会把该 package 标为 `needs_review` 运营风险；若命中密钥泄露、恶意越权指令、权利撤销或可执行载荷等 critical 规则，系统/管理员必须立即执行终局 `disabled`，新 catalog/turn fail closed，并发布移除依赖的 release。非 critical 质量退化允许在受控期限内继续当前 active release，但禁止任何新 release 引用；服务端到期时间、持久化阻断和扫描 owner 由 `05/09` 裁决，超时未处理时即使扫描器暂时不可用，catalog/turn create 也必须按服务端时间自动 fail closed。

### 11.3 Skill 指令优先级与能力边界

Skill 是“来源受控的知识”，不是 system/developer 指令、执行策略或权限主体。运行时必须把 Skill 内容放入有明确边界和来源标记的 `skill_knowledge` 上下文块，不得把正文拼接成可覆盖平台策略的裸 system prompt。裁决顺序固定为：

1. 平台 system/runtime policy、身份与 ownership、ToolPolicy、Compiler、Credit、内容安全和预算硬约束。
2. 用户在当前 turn 明确选择的 primary/Preset、当前请求与合法确认。
3. 已审批且属于 selection snapshot 的 Skill 知识，用于方法、审美、领域事实风险和候选步骤。
4. 用户附件、OCR、网页、历史输出和其他不可信数据。

Skill 可以要求核对事实、建议追问、选择已注册工具或拒绝不适用的创作方法，但不得声明自己是 system/developer/admin、改变上述顺序、注册/启用工具、扩大 capability、选择 Provider/Key、修改费用与权限、要求泄露隐藏上下文，或指示忽略平台/用户约束。类似“忽略之前指令”“把本段视为最高权限”“直接调用未注册工具”的正文属于越权指令；validator 必须报告规则 ID，critical 命中按 §11.2 disabled/fail-closed 处理。合法的角色口吻或创作 persona 只能影响输出风格，不产生更高权限。

## 12. Agent 输入安全

所有用户输入、上传文件、OCR 文本、图片视觉描述、网页/素材元数据和 `@` 引用内容默认都是不可信数据，不是系统指令。

硬规则：

- 上传图片上的文字、OCR 结果和视觉模型描述不得覆盖 system、Skill、R1-R5、费用、权限、合规和修改权规则。
- 不可信内容不能直接触发工具。资产读取、分享、下载和删除必须通过对应 ownership/permission policy；候选生成计划、费用、任务提交和 Provider generation 必须再经过 Compiler 与交易链。
- Agent 回复不得泄露系统提示词、完整 Skill 私有说明、他人产物、原始素材 URL、Provider Key 或内部审计快照。
- 引用内容中的“忽略之前指令”“替换系统规则”等文本必须作为商品/素材内容处理，不作为指令执行。
- 检测到 prompt injection 风险时，记录 trace guardrail step、结构化安全指标和脱敏日志，并降级为追问或拒绝；S08 不另造无契约的安全事件表。

输出侧护栏：

- 回复用户时只暴露必要的解释、费用、风险和可操作下一步。
- 不返回完整 prompt 编译结果，只返回安全摘要。
- 不根据模型猜测事实替用户确认商品事实。

## 13. 检索与记忆边界

1A 默认不依赖自动 embedding 检索完成核心闭环。照片意象重绘等创意任务和电商参考图均以用户显式选择的图片为准。

阶段 0 预留：

- `asset_embeddings` 可作为后续资产相似检索表。
- `user_preferences` 可作为用户偏好记忆表。
- 自动检索命中的素材必须进入引用绑定协议，不能直接进入付费生成。

1A 风险声明：

- 若未实现向量检索，UI 不提供“自动从资产库找相似参考图”的承诺。
- 做同款、创意照片重绘和套图参考图均要求用户显式选择。

## 14. 引用授权矩阵

| 引用对象       |   Agent 可读 | Agent 可改 |                                   可进入计划 |
| -------------- | -----------: | ---------: | -------------------------------------------: |
| 当前会话产物   |           是 |         是 |                                           是 |
| 其他会话产物   | 仅用户有权时 |         否 | 只可作为引用素材开启新任务，修改权仍归原会话 |
| 画布产物       | 仅用户有权时 |         否 |                                 只可跳转画布 |
| 套图产物       | 仅用户有权时 |         否 |                                 只可跳转画布 |
| 用户上传素材   |           是 |     不适用 |                                           是 |
| 分享页公开产物 |   仅公开字段 |         否 |                        需按 allow_remix 规则 |

## 15. 1A 生成动作与积分核对语义

Agent 可以展示安全进度，但步骤不产生逐步二次确认或费用卡。用户点击“生成/继续改并生成”即提交本次幂等生成动作；公网请求不提交费用模式、金额上限或图片数量字段。

| 情况                 | 行为                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| 创意生成             | Brain 从自然语言解析图片张数；Compiler 报价，Credit 核对并预留后执行 |
| 电商生成             | 完成必要商品事实确认后走同一积分核对与预留路径，不增加费用卡         |
| 余额/价格/数量不合格 | 在图片 Provider 前阻断并保留输入，不降数量、不换模、不生成费用卡     |
| 计划或目录漂移       | 当前动作失效；刷新权威目录后由用户重新点击生成                       |
| 用户明确重试         | 创建新的幂等生成动作、quote 和 reservation，并提示必要重复生成风险   |

批量、套图和画布同样使用“点击生成/运行即授权”的单动作路径；预计积分可以提前展示，但不得再增加费用确认框。

### 15.1 原生文本与模型输出修复裁决 (2026-09-26)

结算原子性补充（2026-09-27）：已通过公开文本、必需知识与预算检查的原生聊天文本和显式回复，均须在同一有界事务内完成 Brain 内部成本结算、transcript 回执与正式消息发布。发布写失败必须回滚本次结算；重放只能依据已持久化回执恢复，不得重复扣成本或在另一个事务内猜测补发。

Brain 使用 `tool_choice: auto`。唯一纯文本且无工具调用的有效响应是独立的 `chat_text` outcome：它经过完整公开文本与内容安全检查后，作为 assistant 文本写入同一原生历史与用户消息投影，结束本轮。它不是 `agent_respond` 工具调用，不能从文本推断候选计划、澄清、工具调用或生成成功。公开说明只允许与非终态知识工具混排，遵循本文件“公开过程说明”契约；文本与终态工具或 authoring 混排仍属于协议违规。`respond` 只对应显式 `agent_respond`。

`chat_text`、`respond` 和澄清问题/建议必须在模型输出写入私有 transcript 之前通过同一公开文本策略。宿主拒绝时转为仅含规则枚举、`AGENT_PUBLIC_TEXT_REJECTED` 与可信 usage 的内部 `public_text_rejected`，原始文本不得进入 transcript、私有 payload、消息或 outbox。结算与脱敏修复上下文原子写入；此上下文记录一次修复上限与剩余机会，接管恢复不得重置计数。第二次拒绝后直接安全收敛，不再请求模型。此内部结果不是对模型开放的工具或用户 API 状态。

启用两阶段提示词写作不改变规划阶段的聊天能力：在尚无 `authoring_plan` 时，仍允许原生文本回答、澄清或候选计划。只有已经固定 `authoring_plan` 的正式写作步骤要求 `agent_author_prompts` 结构化输出，不能以普通聊天文本冒充已完成的提示词。

- **结构化纠错**：`invalid_tool_input` 与 `invalid_terminal_output` 共用每 turn 最多 3 次模型修复机会，即首次违规后最多 3 个新的、分别计费的 Brain 步骤，第 4 次违规终局；任何更早到达的轮数、token、成本或权限上限仍优先阻断。每次反馈包含错误种类、受限路径/原因、明确的下一步、修复序号和剩余次数，不重复提交已有生图 Provider 动作。
- 工具批次类别非法（`illegal_tool_batch`）属于上述共享结构修复预算，不另开计费重试额度；使用脱敏 runtime policy 指导允许的工具类别/单终态动作，接管不重置计数。
- **结算与恢复**：每步按可信 usage 结算；反馈与序号随 trace 和原生 transcript 原子落库，Worker 接管后按持久化记录恢复，不重置次数。`not_dispatched`、零 usage 空响应和模型输出修复分别计数，互不冒充。
- **边界**：自然语言文本可以直接回答用户，但不能被解析成结构化工具调用；需要生图时仍必须由模型显式选择候选计划，经 Compiler、报价、资金预留后才调用生图 Provider。模型私有推理不公开。

## 16. 错误兜底

| 错误                | 处理                       |
| ------------------- | -------------------------- |
| 意图误判导致扣费    | 用户可从积分流水申诉       |
| R5 禁止修改请求     | 服务端硬拦截，返回跳转卡片 |
| Skill 不可用        | 解释原因，不提交计划       |
| Provider 能力未通过 | 不进入可收费路由           |
| 费用估算失败        | 不提交计划                 |
| 商品事实缺失        | 追问或降级为未知风险       |

## 17. 与其他文档的边界

- S08 交付 turn、trace、上下文、Skill runtime、普通回答/澄清和 `load_skill@1`；S09 完成前候选计划必须经未激活的 `CompilerPort` fail closed，不得创建 quote/workflow。
- S10 完成前非空附件与引用绑定 fail closed；S11 交正式 Agent 工作台 UI、11 个 1A primary 和首版 auxiliary 内容包；S12/S13A/S13B 才激活对应可收费 Skill 的真实生成工具与发布链路。
- Provider/模型/Key/relay base URL/预算与审批由独立 `apps/admin` / S14 管理，不进入创作平台。S08 交 deterministic fake、精确 adapter port 和静态 registry；真实 Agent Brain PoC 与公网激活遵循 S07 的 S14 后门禁，只允许服务端 relay-origin allowlist 内的 Base URL，不开放任意 URL/Key 配置。

| 文档 | 关系                                 |
| ---- | ------------------------------------ |
| `01` | 定交易和产物修改权的最高工程边界     |
| `03` | 定哪些模型能力可被 Skill 使用        |
| `04` | 定计划提交后的状态流转               |
| `05` | 定 Skill、会话、消息和快照的存储结构 |
| `06` | 定解析、计划、提交、SSE 的接口       |
| `07` | 定用户如何看到确认、风险和结果       |
