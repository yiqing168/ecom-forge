# S08 Agent Turn、Skill 运行时与循环保护

| 项     | 内容                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 状态   | 原 S08 已验收；截至 2026-09-08 已实现 transcript 宿主消息/确认/核心 Skill 绑定、知识工具配对与 owned 写事务入口，生产捕获及 P2 未完成 |
| 阶段   | 1A / D3                                                                                                                               |
| 优先级 | P0                                                                                                                                    |
| 目标   | 交付可恢复的 Agent turn、受限 tool-use 循环、Skill 渐进加载、trace 与死循环保护底座                                                   |

## 1. 开工前必读与依赖

2026-10-09 二轮规划纠错验收：按 `02` 的单对象 source 决策契约，第一次错误即返回具体字段与完整合法组合指引；覆盖遗漏来源 key、错误 mode、额外分支字段、scope mode/reason 与场景摘要同时缺失、隐私脱敏，以及一次修复后接受合法成图修改/原图重做。动态 intent 与执行提示必须与同一运行时 schema 一致，独立源图提示不得误导成图修改。七工具和系统前缀仍跨 Skill/阶段/协议稳定；最多三次修复、canonical lineage/ownership、usage 结算与 unknown 禁止自动重投不变。不调用付费 Provider。

2026-10-08 复审修复验收：公开失败摘要、错误码和 guardrail 类型收敛到 shared 单一契约，Worker 发射端使用派生类型，API 与 Web 严格引用同一白名单。覆盖全部 Brain 分类、恢复耗尽、预算/安全/无效输出摘要的跨层投影；真实隔离数据库与 HTTP SSE 验证失败事件可下发，GET turn 可读且与事件原因一致，未知摘要/内部诊断/额外字段仍拒绝。快照须覆盖 failed 与 guardrail 两种终态事件，不改费用、租约、三态回执或自动重投规则。

2026-10-03 复审修复验收：验证模型只返回宿主指定 authoring key，错误 key/漏写/多写仍进入共享有界修复；当前批次完全重复提示词经 Compiler 的纯 profile 策略确认后只重写未接受批次，checkpoint、usage、租约和未知回执规则不变。图片预算覆盖本 turn 已鉴权历史候选及合法逐张 inspection，不假定模型总是合并工具批次；测试 1/2/9 图、无新附件的历史图片和接管后的累计计数。验证中文/tokenizer、各模型视觉计数、摘要计数与保守回退，272K 政策上限及成本额度不变。API 非预期 5xx 的诊断只含 request ID、路由模板、白名单异常类型及去掉异常首行后的调用位置，不记录完整异常文本、请求值或秘密。已应用的 0040/0041 不合并、不改写。

2026-10-02 工具输入精简验收：稳定七工具及 system 前缀在 planning/authoring、不同 Skill 和三种协议间逐字保持一致；候选计划省略宿主常量、scope 重复 binding/总张数的单图/九图回包可通过补齐。显式 scope 冲突、错误 Skill、未授权 binding、未知参数与正式空提示词仍拒绝；澄清只填 question 可用。字段说明、阶段提示和脱敏修复反馈必须随测试一起交付，不以 fake 通过声称真实模型零错误。

2026-09-30 发布复核补充：所有公开终态回复（包括缺省 respond mode）必须与已捕获模型文本逐字一致，错误工具类型或文本漂移不得新增消息/回执/outbox。结算读取 trace 显式加行锁，维持 session → turn → trace 顺序。正式消息流客户端检查每个 message 的 delta_seq，乱序、跳号、终结后续写触发快照恢复，不重复拼接。

同毫秒投影补充：同 turn 同时间先用户后助手，API turn 快照与客户端分页合并保持一致；同角色同毫秒无新增全局顺序字段，仍使用稳定并列键，不能声称所有消息已有精确时序。草稿的 stale 写栅栏返回空结果，让调用方等待正在进行的租约续约并只在 revision 实际更新时重试；其他存储/完整性错误不吞掉。

2026-09-30 恢复收口补充：按 `04` 的恢复规则，received_user_input 也必须扫描；completed job 再驱动保留累计 attempts，耗尽 turn 原子进入 failed。扫描游标轮转避免首批饥饿；failed/活跃租约/等待确认/已有报价或工作流不得重驱。草稿 delta/clear 使用原生有界写事务检查有效 lease、owner、revision 和 session generation，不允许过期 owner 写入。须覆盖真实数据库分页、租约竞态、失败收口及真实 Redis 累计预算回归。

- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/spec/S05-workflow-queue-worker-and-event-outbox.md`
- `docs/spec/S06-sse-realtime-state-and-recovery.md`
- `docs/spec/S07-provider-gateway-poc-and-cost.md`

S05 的 queue intent、dispatcher、reconciler 和 event outbox，S06 的 SSE 恢复通道，S07 的模型注册、熔断和成本基础必须已完成。S08 不自行实现 S09 的确定性编译器，也不以 fake compiler 放行收费动作。

公开文本拒绝的实现与验收遵循 `02`：原生文本、显式回复与澄清的安全检查均在私有 transcript 捕获之前；内部 `public_text_rejected` 仅存规则和 usage，与结算原子追加脱敏修复上下文。安全拒绝最多一次修复，普通结构错误最多三次，接管不重置任一预算。测试须检查私有 payload 和 transcript 不含拒绝原文，并覆盖跨回复形式的重复拒绝与接管。

## 2. 参考工程调研与采用边界

本轮只读调研 `D:\agent\image` 中已经实现的**对话 Agent、tool calling 与 Skill runtime**。参考对象是其 Agent 工程机制，不是无限画布产品形态。以下机制有价值并吸收到当前工程：

| 参考机制                                      | ecom-forge 吸收方式                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 原生 tool loop + 明确 terminal tools          | 模型只能在服务端静态 registry 中调用工具，并以 respond/clarify/candidate plan 显式结束                            |
| `load_skill` 作为稳定工具、reference 增量加载 | L0/L1/L2 渐进加载；只读取 `SKILL.md` 显式声明的一跳 reference                                                     |
| 已加载 Skill 上下文按来源复用                 | 内置 Skill 复用当前进程内容；外部 Skill 复用数据库 snapshot，版本/hash 漂移 fail closed；两者都不重复注入同一资源 |
| 有界对话 working set                          | 只读取当前会话摘要、最近消息、显式绑定引用和已确认事实，不全量读取历史与资产库                                    |
| context fingerprint 防止旧结果落地            | 对消息、绑定、事实、Skill snapshot 生成上下文 hash；所有晚到写入做 owner/revision CAS                             |
| 重复 tool call 指纹与最大 step                | 使用统一 canonical JSON + 绑定版本 + Skill hash；执行第 3 次等价调用前阻断                                        |
| 工具 started/finished 进度事件与审计          | 先写 trace started，再执行事务外调用，完成时写摘要并投影 turn SSE                                                 |
| 取消与晚到 Worker 的竞态测试                  | turn revision + continuation_no + processing lease/owner CAS，晚到结果只能 no-op                                  |

以下内容明确不迁移：

- 参考工程中与本轮无关的 canvas node、action batch、direct-edit、自动铺图和全画布搜索。
- 把完整 prompt、模型原文或 Skill 私有正文写入本地 `.debug` 文件。
- 文件缺失时使用内置 fallback Skill 正文继续执行。
- 让 LLM 或 Skill 自行启用未注册工具、执行策略、Provider、模型、费用或资产权限。
- 依赖模型输出文本变化判断“有进展”；进展必须由服务端状态和已验证事实决定。

线上产品只参考公开、可验证的行为与安全机制，不推测私有实现。2026-08-12 调研基线：

| 公开参考                                                                                                       | 可迁移机制                                                                         | 本项目裁决                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| OpenAI Tools / function calling（`https://developers.openai.com/api/docs/guides/tools`）                       | 模型在声明的工具集合中自主选择调用；函数参数使用 strict schema                     | Brain 获得当前裁剪后的 `ToolContract[]`；服务端整批 preflight 和执行，模型选择不等于授权                            |
| OpenAI Codex Skills（`https://learn.chatgpt.com/docs/build-skills`）                                           | 初始只展示 name/description，再渐进读取正文                                        | 借鉴渐进披露，但本产品的 primary 必须由用户选择；模型只在所选 primary 的一跳 allowlist 中加载 optional auxiliary/L2 |
| OpenAI Codex approvals & security（`https://learn.chatgpt.com/docs/agent-approvals-security`）                 | 技术可达范围与动作批准是两层控制；工具结果、prompt 和 telemetry 默认按敏感数据处理 | ToolPolicy/ownership 决定技术可达，Compiler/quote/confirmation 决定收费副作用；trace/SSE 只保存脱敏摘要             |
| Manus 公网页面与帮助中心（`https://manus.im/`、`https://help.manus.im/en/articles/11813771-how-to-use-manus`） | 对话入口弱化固定结构；运行资源随任务复杂度受预算约束                               | 1A 保持开放对话和模型自主编排，同时使用 rounds/tool/token/成本硬预算；不复制其 UI、credits 定价或未公开运行细节     |

以上来源只证明交互/契约原则。具体状态机、幂等、数据库真相、资金与权限语义仍完全由本仓库文档裁决。

### 2.1 产品与工程模型

1A 是通用对话式生图 Agent，不是固定工作流表单，也不是画布 Agent。四方职责不可混淆：

| 角色                       | 拥有的职责                                                                                            | 不拥有的职责                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Agent Brain 模型           | 在用户已选 primary 边界内理解意图、选择 optional auxiliary/L2、组合已注册工具、决定回答/追问/候选计划 | 选择/替换 primary、用户权限、资源归属、模型准入、费用、状态落库和最终执行授权 |
| Tool registry/runtime      | 提供版本化可执行能力、strict schema、超时、幂等和安全 observation                                     | 创意方法、领域知识、扩大自身权限或绕过交易链路                                |
| Skill                      | 提供版本化任务知识、审美方法、领域约束、SOP 和能力依赖提示                                            | 注册或授权工具、持有 Provider Key、直接执行、计费或修改业务状态               |
| 工程控制面/Compiler/Credit | 身份、ownership、tool policy、R1-R5、预算、费用、状态、恢复、日志与审计                               | 替模型做审美判断，或把开放式创意推理改造成硬编码意图树                        |

服务端在第一次模型调用前自动加载用户已选 primary 的完整 L1、所选 Preset与全部 required auxiliary L1，作为该精确版本默认必需、可稳定缓存的核心知识；optional auxiliary 与 L2 不预载，只提供一跳安全 L0 catalog 和按 contract version 固定内容与顺序的稳定工具集。模型只为当前任务需要的 optional auxiliary/L2 调用 `load_skill@1`，且只能从 selection snapshot 冻结的空间内选择。每次选择都先经过服务端 schema、权限和状态校验。确定性编译器只终审候选生成计划、R1-R5、收费动作和 Provider generation，不接管普通回答、辅助知识加载或无副作用工具选择。

`detecting_intent` 只是内部可恢复阶段，不要求额外运行固定分类器，也不允许 Controller 按意图枚举接管编排。模型可以在一次 brain step 中直接回答、追问、加载知识或提出候选计划；工程只验证其结构化 outcome。Compiler 可以规范化和拒绝候选计划，不能静默替换模型的审美、构图或创意目标。

来自成熟 Agent 产品的交互原则只吸收为产品行为：用户能看到安全的阶段/活动摘要、可以在运行中追加新指令或停止、刷新后可以恢复；系统不展示 chain-of-thought、完整 prompt、内部工具名、原始参数或模型私有推理。

## 3. 本轮范围与后续边界

2026-09-15 创作边界修订按 `02` 的 Creative freedom and execution safety 执行：系统/工具前缀保持稳定，尾部只携带当前任务的执行提示与真实阶段；不得同时要求规划轮完成最终提示词又禁止其写作。文字区分事实、用户原文和 Skill 授权的原创文案。写意结构证明只作可选 strict 审计，不再以必填证明、逐字施工句或枚举差异数阻断生成。验收须覆盖规划/写作/单轮请求、跨 Skill 规则隔离、原创与无文字边界、可选证明和既有非法参数/引用拒绝；单元测试通过不代表视觉质量已验收。模型、预算、权限、交易与重试契约不变。

### 3.1 本轮包含

- `POST /api/v1/agent/turns`、confirm、interrupt 和 turn detail。
- turn/message/trace/queue intent/outbox 的短事务创建与用户隔离。
- `agent.continue` Consumer、processing lease、重复消费和 Redis 全丢恢复。
- Deterministic Fake Agent Brain adapter、精确 `AgentBrainPort`、严格结构化输出、上下文预算和循环保护。
- Skill L0/L1/L2 loader、路径约束、数据库 snapshot 真相和 Redis 只读缓存。
- 标准 Skill package manifest、纯校验器、安装领域端口、本地 ops CLI、不可变 package digest 与原子 catalog release；S14 再提供管理员 UI/API。
- `skill-risk-deadline` Worker sweeper：按服务端 UTC 分页持久化逾期 `needs_review` package 的阻断、审计与 outbox；catalog/turn 的直接时间校验仍是安全真相。
- turn scope SSE 鉴权、投影白名单、Web 端事件 schema 和恢复测试。
- 澄清确认 v1；product facts/cost/risk 只冻结通用确认信封和扩展端口。
- `validate:agent-trace-loop`、`validate:skill-load-cache` 与 `validate:skill-package-install`。

### 3.2 本轮不包含

- S09 的 R1-R5、候选计划编译、引用修改权终审、quote 创建与 submit。
- S10 的正式商品事实、上传、资产和 artifact 绑定。S10 完成前非空附件/引用在正式路径 fail closed。
- S11 的正式 Agent 工作台页面。S08 只交付 API、turn 事件客户端与最小测试夹具，不改造现有 mock 工作台为已联调产品。
- S12/S13A/S13B 的白底精修、创意生成和本会话改图工具。
- 任意厂商/任意 URL 的通用 Agent Brain adapter，以及 Key 和模型选择 UI。厂商、模型、Key、endpoint、预算与审批最终统一归独立 `apps/admin` / S14；不进入创作平台。
- chain-of-thought、隐藏推理或完整系统提示词展示。用户只看到状态、简短说明和脱敏工具摘要。

### 3.3 S09 联合激活门禁

S08 可以完成普通回答、澄清和受限只读工具循环，但在 S09 完成前：

- `candidate_plan` 只能交给未激活的 `CompilerPort`，返回 `AGENT_COMPILER_UNAVAILABLE`；不得标记 `plan_ready`。
- 不创建 `run_quote`、reservation、workflow、task 或 Provider generation 调用。
- `product_facts | cost | risk` confirmation 没有对应下游 handler 时返回 `AGENT_CONFIRMATION_NOT_AVAILABLE`。
- fake adapter 的成功结果不得作为收费闭环或真实模型 PoC 证据。

### 3.4 真实 Agent Brain 激活顺序

- S08 编码验收必须交付 deterministic fake、精确 `AgentBrainPort` 和 adapter registry；没有已冻结厂商时不得发明通用 HTTP adapter。
- S11-S13B 的工程开发和自动化测试可使用 fake，但 S11 激活后仍必须消费 S14A 受控 catalog 并固定模型 snapshot；fake 不能作为真实体验、质量或上线证据。
- 真实 Agent Brain PoC 与公网激活仍遵守 S07 已冻结顺序：S14 先交付独立管理控制面的模型/Key/endpoint/预算配置和审批，之后才允许独立 local PoC 命令调用编译期注册的精确 adapter。S14 前不得用临时环境变量或创作端配置绕过该门禁。
- staging/beta/production 的真实 Agent route 必须等待 S14 的独立管理控制面完成模型/Key/预算配置、审批和审计；缺任一条件时 readiness 与路由 fail closed。
- S14 只替换配置、审批和启停入口，不改变本 SPEC 的 `AgentBrainPort`、turn 状态、预算、trace 或 tool policy 语义。

## 4. 包与模块边界

```text
packages/agent/
  contracts/            # AgentBrainPort、CompilerPort、tool/result schema
  context/              # 有界上下文、context fingerprint、token budget
  loop/                 # loop runtime、terminal action、guardrails
  trace/                # canonical args/progress hash、脱敏摘要纯函数

packages/skills/
  catalog/              # L0 metadata schema 与发布索引纯函数
  runtime/              # L1/L2 schema、路径/大小/hash 校验纯函数
  package/              # manifest、archive entry、依赖、digest、diff 与 release 纯校验
  authoring/            # scaffold/pack/validate/diff 的无 I/O 计划与输出 schema
  fixtures/             # 只读合法/恶意 package 测试夹具；不作为运行时目录

apps/api/src/modules/agent/
  agent.controller.ts
  agent-turn.service.ts
  agent-confirmation.service.ts
  repositories/         # turn/message/confirmation/trace/outbox/intent 事务端口

apps/api/src/modules/skill-package/
  skill-package.service.ts      # quarantine complete/validation/approval/disable 领域服务
  skill-catalog-release.service.ts # draft closure/publish/rollback 领域服务
  repositories/                 # package/resource/report/release 事务端口

apps/worker/src/processors/
  agent.processor.ts
  skill-package-validation.processor.ts
  skill-risk-deadline.processor.ts
apps/worker/src/agent/
  tool-registry.ts       # 服务端 action space 与 tool policy
  skill-runtime.adapter.ts # 发布包/DB snapshot/Redis cache I/O

packages/provider/
  agent-brain/           # fake 与后续精确厂商 adapter；不含业务状态
```

约束：

- `packages/agent` 与 `packages/skills` 保持无 I/O：不访问数据库、Redis、HTTP、环境变量或文件系统；只处理 strict schema、选择、路径、hash、预算和状态纯逻辑。
- `packages/agent` 不依赖 `packages/compiler` 的实现，只依赖由应用层注入的窄 `CompilerPort`。
- `packages/provider` 负责模型协议与调用，不更新 turn、trace、消息或费用。
- Worker adapter 负责从发布包/DB/Redis 读取 Skill；数据库 snapshot 是真相，Redis 只是缓存，`packages/skills` 不持有连接。
- API Controller 只做 schema/Guard/响应映射；事务、用户隔离和状态裁决在 Service/repository。
- Worker Processor 只编排 claim、runtime 和 repository，不直接裸写状态。
- package archive I/O/解包在隔离 adapter；`packages/skills` 只校验 entry/manifest/依赖/hash/diff/release closure。S08 不开放普通用户或创作端安装 HTTP API；本地 CLI 与未来 S14 Admin API 必须调用同一领域 Service。

## 5. HTTP API 契约

turn 端点要求已验证用户会话、Origin/Host/CSRF、可信代理限流和 `Cache-Control: no-store`。资源不存在或不属于当前用户统一返回 `RESOURCE_NOT_FOUND`，不得泄露其他用户的 session/turn。catalog 是唯一匿名可读端点，只返回公开发布元数据，不返回正文、依赖、capability、内部风险、评测或管理状态。

### 5.1 GET `/api/v1/skills`

供首页、快捷入口和 Composer 使用。可选 query 只允许 `domain=creative|commerce`；未知/重复参数返回 400。服务端始终按当前 `APP_ENV`/stage 过滤，只返回 `status=published + kind=primary + visibility=public`，客户端不能通过 query 请求未启用 stage。

响应按 `sort_order,id` 稳定排序：

```json
{
  "ok": true,
  "data": {
    "catalog_version": "sha256",
    "items": [
      {
        "primary_skill_id": "creative-scene-reimagining@1.3.1",
        "slug": "creative-scene-reimagining",
        "version": "1.0.0",
        "name": "照片意象重绘",
        "description": "提取照片中的语义、关系与情绪，重新创作不保留原像素的作品",
        "domain": "creative",
        "category": "photo-transform",
        "cover_asset": {
          "url": "https://approved-public-cdn/skill-cover.webp",
          "alt": "照片意象重绘示例",
          "aspect_ratio": "4:3"
        },
        "required_inputs": ["source_image"],
        "preset_slots": [
          {
            "slot": "style",
            "label": "风格",
            "required": false,
            "max_selections": 1,
            "options": [
              {
                "preset_id": "paper-color@1.0.0",
                "name": "纸上亮色",
                "description": "大留白与局部亮色",
                "preview_asset": {
                  "url": "https://approved-public-cdn/preset.webp",
                  "alt": "纸上亮色预览",
                  "aspect_ratio": "1:1"
                }
              }
            ]
          }
        ]
      }
    ]
  },
  "error": null
}
```

- `catalog_version = sha256(canonical_json(全部返回 item 的 id + definition_hash + sort_order))`。S08 时期它可直接作为强 ETag；S09 增加 execution policy 后，强 ETag 前向改为 `response_version = canonical_hash(catalog_version + policy_version)`，避免策略更新被旧 catalog 304 隐藏。已发布元数据可 `public, max-age=60, stale-while-revalidate=300`；不得回写 session cookie。
- cover/preview 只能使用发布时登记的公开只读 CDN 资产和允许的 HTTPS host，不得返回对象存储签名 URL、用户资产、外部仓库图片或未知权利素材。
- catalog 缓存只改善展示，不构成授权。创建 turn 必须按数据库 published row、definition hash、resource snapshot 和 stage 重新校验完整 selection；被停用/漂移的选择即使仍在客户端缓存中也不得执行。
- 公开 catalog 不返回 auxiliary 名称清单、dependency reason、`required_capabilities`、reference 路径、Skill 正文、golden eval 或 Provider/模型/价格/Key 信息。

### 5.2 POST `/api/v1/agent/turns`

请求头：`Idempotency-Key` 必填，1-128 个可打印 ASCII 字符。

严格请求体：

```json
{
  "session_id": "uuid?",
  "message": "string",
  "attachments": [
    {
      "binding_id": "uuid",
      "resource_type": "asset | artifact | upload",
      "resource_id": "uuid",
      "resource_version": "string",
      "role": "product | style_reference | composition_reference | other",
      "position": 0
    }
  ],
  "mention_bindings": [
    {
      "mention_key": "string",
      "binding_id": "uuid"
    }
  ],
  "skill_selection": {
    "primary_skill_id": "slug@1.2.3",
    "preset_selections": [
      {
        "slot": "style",
        "preset_id": "clean-studio@1.0.0"
      }
    ]
  }
}
```

规则：

- `message` trim 后 1-2000 字符；S10 激活后允许 message 为空但至少有一个有效附件。该上限只约束用户指令正文，不包含图片；由服务端 schema 强制执行，前端只提供同口径的发送禁用和提示，不能作为安全边界。
- 附件最多 9 个、position 从 0 连续且不重复；mention 最多 24 个，只能指向本请求附件。
- `skill_selection` 必填且 strict；`primary_skill_id` 必须是用户从安全 catalog 选择的 published、当前 stage 可见的精确 primary `slug@semver`。不接受仅 slug、`latest`、版本范围、auxiliary ID、客户端正文或空选择；缺失/非法返回 `SKILL_SELECTION_REQUIRED` 或 `SKILL_SELECTION_INVALID`，且不得创建 turn/message/trace/intent/outbox，也不得调用模型或网络。
- `preset_selections` 默认空数组，按 `slot` 排序后进入 canonical request hash。每项必须精确属于该 primary 当前版本声明的 slot/option；slot 不重复，满足 required/max selections，禁止跨 primary、未知/disabled option 和客户端正文。runtime 不补默认、不根据用户文本替换；需要改变 primary/Preset 时由用户发起携带新选择的新 turn。
- Service 在首次短事务中把经过重校验的选择写成不可变 `skill_selection_snapshot_json/hash`，至少固定 primary definition hash、Preset resource IDs/hashes、required/optional auxiliary allowlist 与 catalog presentation version。Worker 只消费该 snapshot，不再次用“当前最新版”解析；若 published resource 与 snapshot 冲突则 `SKILL_VERSION_DRIFT`，不能静默升级。
- 模型不能选择、卸载或替换 primary/Preset/required auxiliary。primary 与 required auxiliary 由 runtime 自动注入；模型只能动态加载 snapshot 已冻结的 optional auxiliary，并可在 primary/required/optional 的对应 L1 已加载后按其一跳 index 读取 L2 reference。
- S10 前 `attachments/mention_bindings` 必须为空；非空请求返回 `AGENT_CONTEXT_UNAVAILABLE`，不得临时信任客户端资源 ID。
- 传 `session_id` 时锁定并校验当前用户会话；未传时在同一事务创建新会话。
- 规范化 request hash 包含完整严格 payload。Service 的第一项数据库动作必须按 `user_id + create_idempotency_key` 查已有 turn：同 hash 立即返回 `create_response_json`，不同 hash 立即返回 `IDEMPOTENCY_CONFLICT`；只有确认 key 从未使用后，才允许锁定/创建 session 和 supersede 旧 turn。幂等重放即使发生在该 session 已出现更新 turn 之后，也不得锁 session、supersede、写 outbox 或产生任何副作用。
- 同一 session 的未提交非终局 turn 在行锁内先 supersede；已有关联 `workflow_run` 的 turn 和 workflow 不受影响。

首次创建使用一个短事务完成：

1. 按 `user_id + create_idempotency_key` 查询已有记录并处理 replay/conflict；不存在才继续。
2. 锁定/创建 `chat_sessions`，检查用户 access，并在锁内再次查询该 key 处理并发插入。
3. supersede 旧的未提交 turn、未提交 quote、pending confirmation 和运行中 trace。
4. 创建携带不可变 selection snapshot 的 `agent_turns`、用户 `chat_messages`、唯一 `agent_traces`。
5. 创建 `agent.continue` queue intent。
6. 追加 `turn.created` outbox 事件。
7. 以首次提交后的 ID、公开 `user_status` 和 event seq 构造并写入不可变 `create_response_json`。

事务内禁止 Redis、LLM、Provider、对象存储或任何网络调用。

响应 `201`；幂等重放返回完全相同的业务对象：

```json
{
  "ok": true,
  "data": {
    "session_id": "uuid",
    "turn_id": "uuid",
    "user_message_id": "uuid",
    "agent_trace_id": "uuid",
    "skill_selection": {
      "primary_skill_id": "slug@1.2.3",
      "primary_name": "用户可见名称",
      "preset_selections": [
        { "slot": "style", "preset_id": "clean-studio@1.0.0", "name": "干净棚拍" }
      ]
    },
    "user_status": "thinking",
    "revision": 1,
    "continuation_no": 1,
    "event_scope": "turn:uuid",
    "last_event_seq": 1
  },
  "error": null
}
```

### 5.3 POST `/api/v1/agent/turns/{turn_id}/confirm`

请求头：`Idempotency-Key` 必填。

```json
{
  "confirmation_id": "uuid",
  "confirmation_type": "clarification | product_facts | risk",
  "confirmation_version": 1,
  "answers": {}
}
```

规则：

- canonical request hash 必须包含路由 `turn_id` 与 strict body。Service 先按 `user_id + Idempotency-Key` 查已有 answered confirmation：同 request hash 立即重放其 `response_json`，不同 hash 立即返回 `IDEMPOTENCY_CONFLICT`；因此把相同 key/body 打到另一 turn 也必须冲突，不能返回旧 turn 响应。只有 key 从未使用时才锁 turn/confirmation；重放不得因 turn 后续已 done/superseded/cancelled 而失效，也不得再递增 continuation 或入队。
- 首次处理才锁定 turn 和 confirmation；两者必须属于当前用户，turn 必须是 `waiting_user_confirmation`。锁内再次查询 key，处理并发首次提交。
- confirmation 必须仍为 pending、未过期，ID/type/version/payload digest 必须与服务端快照一致。
- 0 积分余额门禁只适用于会继续 Agent 生图/计费链路的 `clarification` 确认；商品事实与风险确认属于非计费确认，不因余额为 0 被拦截。商品事实确认仍必须完整执行资源归属、版本和状态校验。
- S08 只注册 `clarification@v1` answer schema；product_facts/risk 等待下游 SPEC 注册 handler，未注册即 fail closed。1A 不存在费用卡，本路由不接受 cost；S09 只允许服务端生成动作证据驱动内部 quote submit。
- 成功时在一个短事务内写 answer、创建用户确认消息、递增 `continuation_no/revision`、转 `loading_context`、创建新的 queue intent。
- 同 key 同 payload返回 confirmation 的不可变 `response_json`，即使 turn 后续已推进也不重算且不重复入队；同 key 不同 payload 返回 409。
- 旧 confirmation、已 supersede/cancelled turn、错误版本均不得“尽量套用”到当前 turn。

`clarification@v1` 保持开放式对话，不冻结成业务表单。`public_payload_json` strict schema：

```json
{
  "schema_version": 1,
  "question": "string(1..500)",
  "options": [{ "id": "stable-token", "label": "string(1..80)" }],
  "allow_free_text": true,
  "max_response_chars": 2000
}
```

`options` 最多 6 项、ID 唯一，可为空；它只是快捷建议，不代表服务端替模型决定答案。`answers` 对应 `{ "response_text": "string?", "selected_option_id": "stable-token?" }`，两者至少一个存在；option 必须属于 snapshot，free text 只有在 `allow_free_text=true` 时接受。服务端将选项的 snapshot label 与文本一并写入严格 answer，客户端不得提交隐藏 value、工具参数或新 schema。

响应 `202`：

```json
{
  "ok": true,
  "data": {
    "turn_id": "uuid",
    "user_status": "thinking",
    "revision": 7,
    "continuation_no": 2,
    "event_scope": "turn:uuid",
    "last_event_seq": 4
  },
  "error": null
}
```

### 5.4 POST `/api/v1/agent/turns/{turn_id}/interrupt`

请求头：`Idempotency-Key` 必填。请求体固定为：

```json
{ "reason": "user_requested" }
```

规则：

- canonical request hash 必须包含路由 `turn_id` 与 strict body。Service 先按 `user_id + interrupt_idempotency_key` 查已有成功快照：同 request hash 立即重放 `interrupt_response_json`，不同 hash 立即返回 `IDEMPOTENCY_CONFLICT`；因此把相同 key/body 打到另一 turn 也必须冲突，不能返回旧 turn 的停止结果。只有 key 从未使用时才读取并锁定目标 turn；重放不得因为 turn 已终局而退化成状态冲突，也不得新增事件。
- 首次处理只允许中断尚未提交 workflow 的非终局 turn；锁内再次查询 key，处理并发首次提交。
- 锁定 turn 后清除 processing lease、递增 revision、转 `cancelled`；pending confirmation 同事务转 cancelled。
- 关联 quote 若仍为 `quoted`，同事务转 `cancelled`；不创建/释放 reservation。
- 已提交 workflow 返回 `TURN_ALREADY_SUBMITTED`，用户必须走 workflow cancel。
- 正在网络调用的旧 Worker 不承诺物理瞬停，但其后续状态写因 owner/revision CAS 失败只能 no-op。
- 成功时写 trace interrupt step、trace cancelled 和 `turn.interrupted` outbox；重复请求返回同一终态。
- 首次成功响应以 `interrupt_response_json` 同事务固化；同 key 同 payload 永远重放该响应，同 key 不同 payload 返回 409。不同 key 对已经终局的 turn 返回稳定状态冲突，不覆盖首次快照。
- `202` 业务响应只返回 `turn_id/user_status=stopped/event_scope/last_event_seq` 等公开恢复字段，不返回内部 `cancelled` 状态。

响应 `202`：

```json
{
  "ok": true,
  "data": {
    "turn_id": "uuid",
    "user_status": "stopped",
    "revision": 8,
    "continuation_no": 2,
    "event_scope": "turn:uuid",
    "last_event_seq": 7
  },
  "error": null
}
```

### 5.5 GET `/api/v1/agent/turns/{turn_id}`

返回用户可恢复快照，不返回原始 trace、完整 prompt、Skill 私有正文或 chain-of-thought：

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "session_id": "uuid",
    "user_status": "waiting_for_you",
    "revision": 6,
    "continuation_no": 1,
    "agent_trace_id": "uuid",
    "skill_selection": {
      "primary_skill_id": "slug@1.2.3",
      "primary_name": "用户可见名称",
      "preset_selections": [
        { "slot": "style", "preset_id": "clean-studio@1.0.0", "name": "干净棚拍" }
      ]
    },
    "loaded_auxiliary_skills": [
      { "skill_id": "portrait-identity-safety@1.0.0", "name": "人物保真", "load_mode": "required" }
    ],
    "run_quote_id": null,
    "workflow_run_id": null,
    "pending_confirmation": {
      "id": "uuid",
      "type": "clarification",
      "version": 1,
      "public_payload": {},
      "expires_at": "UTC ISO-8601"
    },
    "messages": [],
    "last_event_seq": 4,
    "created_at": "UTC ISO-8601",
    "ended_at": null
  },
  "error": null
}
```

`skill_selection` 来自创建时不可变 snapshot，只返回安全展示字段；`loaded_auxiliary_skills` 只返回实际加载资源的安全名称与 required/optional 模式，不返回内部说明、reference 路径、hash 或正文。`messages` 只返回该 turn 已持久化的 user/assistant 内容和附件安全摘要，顺序固定为 `(created_at,id)`；内部 tool/system message、observation 和 tool call 审计不作为对话消息返回，用户进度只看安全 activity 投影。所有公网 Agent API 只返回 `user_status`，不返回数据库 `status`；`revision/continuation_no` 是客户端恢复用的 opaque version，不得被 UI 翻译为业务阶段。S11 的完整会话列表和跨 turn 分页另行实现。

## 6. 数据模型与前向迁移

S08 只通过 Drizzle schema 生成新的前向 migration，不修改 S02-S07 已提交 migration，不执行 drop/reset/recreate，不手工修改迁移历史。

### 6.1 agent_turns 扩展

新增：

| 字段                            | 约束/用途                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `revision`                      | int，默认 1，正数；所有状态/owner/确认变更 CAS                                                                                                               |
| `continuation_no`               | int，默认 1，正数；每次有效确认递增                                                                                                                          |
| `primary_skill_id`              | string?，记录本次选择的精确 `slug@semver`；内置 Skill 不依赖 `skills` 外键，外部 Skill 由 selection snapshot 的 package/release 闭包校验；仅 legacy 行可为空 |
| `skill_selection_snapshot_json` | json?，strict 不可变 primary/Preset/dependency/catalog 快照；不含正文                                                                                        |
| `skill_selection_snapshot_hash` | SHA-256?，canonical selection snapshot hash；仅 legacy 行可为空                                                                                              |
| `create_idempotency_key`        | string?，创建 turn 的用户级幂等键；仅 legacy 行允许为空                                                                                                      |
| `create_request_hash`           | SHA-256?，规范化 create payload；仅 legacy 行允许为空                                                                                                        |
| `create_response_json`          | json?，首次 create 的不可变业务响应；仅 legacy 行允许为空                                                                                                    |
| `interrupt_idempotency_key`     | string?，成功中断时写入                                                                                                                                      |
| `interrupt_request_hash`        | SHA-256?，规范化 `turn_id + strict body`，与 interrupt key 成对                                                                                              |
| `interrupt_response_json`       | json?，首次成功 interrupt 的不可变业务响应                                                                                                                   |
| `context_snapshot_json`         | json?，只有持久化 ID、版本、hash 和预算，不含完整私有 prompt                                                                                                 |
| `context_snapshot_hash`         | SHA-256?，当前 continuation 的上下文指纹                                                                                                                     |
| `processing_owner`              | string?，Worker 唯一 owner token                                                                                                                             |
| `processing_lease_expires_at`   | timestamptz?，与 owner 成对                                                                                                                                  |

新增约束/索引：

- `unique(user_id, create_idempotency_key) where create_idempotency_key is not null`。
- `unique(user_id, interrupt_idempotency_key) where interrupt_idempotency_key is not null`。
- `primary_skill_id/skill_selection_snapshot_json/skill_selection_snapshot_hash` 必须全部为空或全部存在；S08 Service 新行强制全部存在，全空只兼容 S08 前 legacy 行。selection snapshot/hash 创建后不可更新，confirm/恢复/重放都沿用原值。
- create key/hash/response 必须全部为空或全部存在；S08 Service 创建的新行强制全部存在，全部为空只兼容 S08 前的 legacy 行。interrupt key/hash/response 必须同时为空或同时存在。response 一旦写入禁止更新。
- context snapshot/hash 必须同时为空或同时存在；首次 create 可为空，Worker 固化当前 continuation 上下文时通过 CAS 同时写入。
- owner/lease 必须同时为空或同时非空。
- 非终局且 `workflow_run_id is null` 的 turn 每 session 至多一个；API 仍必须先锁 session，唯一约束只作并发兜底。

### 6.2 agent_turn_confirmations

新表字段：`id/turn_id/user_id/confirmation_no/type/status/answer_schema_version/public_payload_json/payload_digest/answer_json/idempotency_key/request_hash/response_json/expires_at/answered_at/created_at`；其中 `request_hash` 规范化 `turn_id + strict confirm body`。

约束：

- type 固定 `clarification | product_facts | cost | risk`。
- status 固定 `pending | answered | expired | superseded | cancelled`。
- `unique(turn_id, confirmation_no)`。
- `unique(user_id, idempotency_key) where idempotency_key is not null`。
- pending 扫描索引 `(status,expires_at)`；确认查询索引 `(turn_id,created_at)`。
- answered 必须同时有 answer/idempotency/request hash/response/answered_at；response 一旦写入禁止更新，其他状态不得伪装为已确认。

### 6.3 chat_sessions / agent_traces / skill snapshots

- `chat_sessions` 新增 `primary_skill_slug?`、`summary_json`、`summary_version default 0`、`summary_through_turn_id?`；首个 turn 在锁内固定 primary slug，后续 turn 不得切换，开始新的创作方向必须新建会话；同 slug 内置 Skill 的新版本只影响新 turn。摘要只由引擎写，覆盖范围单调前进。Worker 按 `02` §11 的 token 滑动窗口和完整 turn 安全切点生成 strict 增量摘要，不得继续以固定消息条数截断冒充上下文压缩。
- `agent_traces(turn_id)` 提升为唯一，单 turn 的多 continuation 共用一条 trace。
- `agent_turns.primary_skill_id` 与 `agent_trace_steps.skill_id` 是审计/诊断标识，不建立到 `skills.id` 的外键。内置 Skill 记录随工程加载的 `slug@semver`；外部 Skill 的存在性、发布态和版本闭包由不可变 selection snapshot 在 API/Worker 边界严格校验。
- `agent_trace_status` 前向新增 `cancelled`，使用户中断不伪装成 failed/blocked。
- `agent_traces` 新增 nullable `brain_model_snapshot_id uuid -> models.id` 与 nullable `brain_model_snapshot_json`；旧 `brain_model_id` 保留作 legacy/display 兼容，不改名、不删除。S08 新 trace 在首次 LLM 前必须一次性固定 primary snapshot FK/strict JSON；legacy trace 可为空但不得进入真实 Agent route。
- `agent_traces` 新增非负 `reserved_cost`，默认 `0.00`；LLM 调用前的保守成本暴露写入该字段，崩溃恢复不能清零。
- `skill_resource_snapshots` 新增不可变 nullable `content_text`；null 只表示 S08 前尚未 hydration 的 legacy snapshot。新增 `unique(skill_id,resource_path)`，已有三列唯一约束可保留。
- `skill_resource_snapshots.summary_json` 只保存可注入摘要；`content_text` 只用于内部重放，不进入公网 API、SSE 或日志。

Skill package/release 表按 `05` 新增。`skill_package_validation_reports` 必须固定 `package_revision/package_digest`，并具有 `revision/processing_owner/processing_lease_expires_at/last_heartbeat_at`；`running` owner/lease 成对，终态清空并固定 report digest。`skill_packages` 具有 `risk_review_due_at/risk_blocked_at`，到期阻断不依赖 sweeper 存活。

S08 不创建 S14 管理身份表或开放管理 API，但 package/release Service 必须接受显式 actor context，供 local/test fixture 与未来独立 Admin principal 共用，不能依赖 `users.role`。本轮对既有 `admin_audit_logs` 只做前向兼容扩展：保留并放宽 legacy `actor_user_id`，新增 nullable `actor_admin_id/actor_type/admin_session_id/permission_snapshot` 等字段；bootstrap/local-test CLI 和 system job 写 `actor_type=bootstrap_cli|system` 且两类身份 ID 均为空。S14 创建独立管理身份表后再添加 Admin FK，并对 Admin API 强制完整 Admin actor；legacy actor 不得升级为授权依据。

### 6.4 既有数据兼容与前向发布

- migration 只由更新后的 Drizzle schema 生成。新增 create 幂等字段和 `content_text` 必须先允许 legacy 全空/null；不得通过手写 SQL、删行、改 hash、drop/reset/recreate 来伪造兼容。
- migration 前置检查必须验证：同一 turn 不存在多条 trace、同一 session 不存在多个未提交 active turn、同一 `(skill_id,resource_path)` 不存在多个 hash。任一冲突都停止发布并输出 ID 摘要，不能自动选赢家或删除历史证据。
- 受控 `scripts/ops/hydrate-skill-snapshots` 只读取当前不可变发布包：规范化 UTF-8/LF 后计算 hash，只有 `content_text is null` 且 DB `content_hash` 与发布包完全一致时才用 `id + content_hash + content_text is null` CAS 回填。正文不得作为命令行参数、日志或通用审计 payload。
- 发布包缺失、hash 不同或 CAS 失败时 hydration fail closed；该 snapshot 在补齐前不可被 S08 runtime 使用。合法内容变化必须发布新 Skill version，不能覆盖旧 snapshot。
- 新 S08 turn 只能由 Service 写入全套 create 幂等字段；新 Skill snapshot 必须直接写非空 `content_text`。集成测试要同时证明 legacy 行可读取/不可执行边界和新行不变量。
- `brain_model_snapshot_id/snapshot_json` 不按旧 `brain_model_id` 文本猜测回填。真实 adapter 只接受明确选择且已验证的不可变 `models` row；test/local fake 使用 strict fake snapshot JSON，可以没有 model FK。找不到可信快照的 legacy trace 只可诊断读取，不可恢复执行。
- `agent_trace_steps` 新增 nullable `model_snapshot_id uuid -> models.id` 与 nullable `model_snapshot_json`。每个 `llm_call` step 在网络调用前与 started/保守成本同事务固定实际 snapshot；真实调用两者都必填，fake 至少 strict JSON 必填。adapter、runtime 和 retry worker 均不得在该 turn 内切换模型；调用失败或结果未知只能 fail closed，新的尝试必须由用户创建新的 turn。

## 7. turn 状态、并发与确认

### 7.1 本轮可执行转换

```text
received_user_input -> loading_context
loading_context -> detecting_intent | blocked | failed
detecting_intent -> validating_context | clarifying | done | blocked | failed
validating_context -> clarifying | planning | blocked | failed
clarifying -> waiting_user_confirmation
waiting_user_confirmation -> loading_context        (有效确认)
planning -> waiting_user_confirmation | done | blocked | failed
```

S09 激活后才允许：

```text
planning -> plan_ready -> run_quote_created
run_quote_created -> waiting_user_confirmation | waiting_provider_confirmation | done
```

所有未提交非终局状态可以由用户中断进入 `cancelled`，或由同 session 新 turn 进入 `superseded`。`done/blocked/failed/cancelled/superseded` 终局不可逆。已有关联 workflow 的状态由 workflow 真相推进，不被新消息静默取消。

### 7.2 processing lease

- Consumer 在短事务内锁 turn，校验 `continuation_no` 和可处理状态，使用随机 owner token 领取 lease。
- 默认 lease 300 秒、每 20 秒续约；单次 Agent brain 请求 deadline 默认 240 秒。typed config 必须验证 `request_timeout < lease` 且 `renew_interval * 3 < lease`。
- 每次状态、trace、消息和 outbox 写入都检查 `turn_id + processing_owner + expected_revision`。
- CAS 失败后重读：终局/等待确认/continuation 已变化则 no-op；非法状态告警并停止。
- lease 过期可由新 Worker 领取；旧 owner 的迟到结果不能清除新 owner lease。
- Consumer 因 owner/revision 栅栏失效退出时，不得把仍可处理的 turn 永久留在 `detecting_intent` 等非终局状态。定期恢复器以数据库的过期 lease、当前 continuation 和原持久化 `agent.continue` intent 为依据，仅重新驱动同一 job；已完成但 turn 未终局、或原 job 已被清理时允许再驱动，已耗尽 BullMQ 尝试而失败的 job 不重置 attempts 自动重试，须记告警供人工处置。等待确认、报价已提交、终局或仍有有效 lease 的 turn 不重驱。接管仍先收敛 started LLM step 的未知回执，不重投可能已经到达 Provider 的调用。恢复失败须可观测，不能靠启动时的一次性 Redis 全丢协调兜底。
- 进入等待确认或终局时同事务释放 lease。

### 7.3 confirmation 生命周期

- Worker 需要用户输入时，同事务创建 confirmation、assistant message、`turn.confirmation_required` 事件，并将 turn 转 `waiting_user_confirmation`。
- confirmation 默认 30 分钟过期；sweeper 只扫描 pending，行锁/CAS 后转 expired、turn cancelled、trace cancelled，并写 `turn.status_changed` + `turn.cancelled(reason=confirmation_expired)` 可恢复终局事件。
- 新 turn supersede 或 interrupt 时，原 pending confirmation 同事务终止。
- 客户端展示的文案/表单来自 `public_payload_json`，但提交时服务端按 `answer_schema_version` 再校验，不能信任前端缓存 schema。

## 8. agent queue 与恢复

`agent.continue` payload 固定为只携带持久化 ID/序号：

```json
{
  "schema_version": 1,
  "job_type": "agent.continue",
  "trace_id": "uuid",
  "session_id": "uuid",
  "turn_id": "uuid",
  "user_message_id": "uuid",
  "continuation_no": 1,
  "turn_revision": 1
}
```

- payload 不携带 message、attachments、mention bindings、prompt、Skill 正文或模型 Key；Consumer 必须回查数据库真相。
- job ID 使用 `compositeJobId({job_type,turn_id,continuation_no})`；intent 使用 `aggregate_type=agent_turn`、`aggregate_id=turn_id`。
- create/confirm 的业务写入、intent 和 outbox 同事务；Redis add 在事务外由 S05 dispatcher 完成。
- `turn_revision` 是创建该 continuation intent 时的审计基线，不是 Consumer 从领取到结束必须始终相等的永久版本。DB continuation 小于 payload 或同 continuation 的 DB revision 小于 payload 均 fail closed；DB continuation 大于 payload 为旧 job no-op。continuation 相同且 DB revision 已因本 continuation 的合法状态、lease 或 step 推进而大于 payload 时，必须依据当前可恢复状态、processing lease 和 trace step 真相继续/接管，不能把 stalled 重跑误判为旧 job。session/message/trace 归属不一致 fail closed 并告警。
- BullMQ `attempts` 只用于 Consumer 进程级恢复，不得绕过 DB lease/CAS，也不得自动创建 quote/Provider submit。
- 工具入参校验失败的修复提示只保存安全字段路径、错误类别、预期类型/范围；不得把模型提交的原始字段值或片段写入 transcript、trace 或日志。
- Redis 全丢时，S05 reconciler 只重建当前 continuation 匹配、仍可处理且有可恢复 intent 的 agent job；payload 复用 intent 的持久化 `turn_revision` 审计基线，不以 DB 当前 revision 伪造新世代。等待确认和终局 turn 不重建。
- started LLM step 在崩溃后先按 §9.4 收敛为内部 `AGENT_CALL_OUTCOME_UNKNOWN`；保守成本 exposure 仍计入 turn 预算，并立即以 `AGENT_MODEL_UNAVAILABLE` 结束当前 turn，不得自动发起第二次 Brain 请求。连续失败状态必须从 trace step 恢复，不能因 Worker 重启、lease 接管或 Redis 恢复清零；不假装第一次调用没有成本，也不复用可能晚到的旧输出。

## 9. Agent Brain 与受限工具循环

### 9.1 AgentBrainPort

`packages/agent` 只接收以下能力，不接收任意 URL/header：

```ts
interface AgentBrainPort {
  runStep(
    input: AgentBrainStepInput,
    context: {
      abortSignal: AbortSignal;
      deadline: Date;
      idempotencyKey: string;
      modelSnapshot: AgentBrainModelSnapshot;
      traceId: string;
    },
  ): Promise<AgentBrainStepOutcome>;
}
```

`AgentBrainStepInput` 是严格、可预算的模型视图。`legacy_v1` 兼容当前 user message、recent messages/session summary 和 observation 分字段输入；`transcript_v1` 改为 `02` 定义的同一有序历史投影，不能独立维护第二份 recent messages、当前输入或 authoring plan。两种输入均包含已确认事实与引用的安全投影、primary/Preset/required auxiliary 核心知识、图片 `required_capabilities`、一跳 optional dependency 的 L0 catalog、固定合同版本的 `ToolContract[]` 和剩余 rounds/tool/token/成本预算。图片 `required_capabilities` 是动态上下文与返回值确定性复验条件，不用于改写逐轮 Provider schema，不公开给 Web，也不注册、启用或授权工具。首次调用不得预加载 optional auxiliary L1 或 L2。Brain 输入不包含全站 primary catalog、数据库 entity、其他用户存在性、完整系统日志、Key、任意 URL/header、账本写能力或 Provider generation 工具。runtime 不增加固定意图分类器或按意图枚举替模型选工具。

新消息不自动等于生图请求。Brain 先结合当前消息和同会话上下文判断本轮是在交流创意、追问、阅读知识，还是用户实际要求生成/修改图片；所选 Skill 的执行提示只约束已经选择 `candidate_plan` 的计划内容，不要求每轮提交计划。讨论、评价、解释和无需执行的反馈可直接用原生 `chat_text` 或显式 `agent_respond` 结束；信息不足则显式澄清。只有模型提交完整候选计划并通过 Compiler 后才进入 quote/预留链，普通聊天与澄清不得产生 quote、reservation、workflow 或账本写入；模型选择仍不能替代服务端授权。

候选计划 schema 必须区分模型决定与运行时确定值。冻结 context 已能唯一确定的 Skill ID、协议版本、单一 capability、固定输出数、默认来源、空依赖和场景多附件的一对一 binding，由 adapter 校验上下文后规范化补齐；Brain 只负责 Prompt、语义关系、必要的来源选择和其他不可推导决定。规范化不得覆盖模型已提供但与冻结 context 冲突的值，也不得补写缺失的 `creative_prompt` 或场景语义。完成页创作说明属于可选展示投影，不得阻断候选计划进入 Compiler。

adapter 必须把平台 policy、terminal tools 与业务工具的固定 schema/description 按 contract version 和工具名稳定排序，并把会话固定的 primary/Preset/required auxiliary 核心知识以稳定内容和顺序紧随其后，组成可复用的 prompt/KV-cache 前缀。L0 catalog、会话摘要、当前消息、授权图片、动态加载知识、observation 和剩余预算放在该前缀之后的动态消息中；禁止把这些逐轮变化内容拼进 system prompt。缓存命中只优化成本与延迟，调用前 exposure 仍按未命中上界预留，缓存 miss 不得改变 ToolPolicy、Compiler、权限或结果语义；可信 usage 中的 cached tokens 单独记账和监控。

`AgentBrainModelSnapshot` 必须通过 `03` 冻结的 `agent_brain@v1` capability、`agent_brain_tokens@v1` pricing 和 `agent_brain@v1` quota strict schema，至少固定 `snapshot_id?/provider/provider_channel_id/protocol_family/api_variant/model_id/version/capability_contract/pricing/quota/status/status_evidence_digest`，不含 Key 或任意 endpoint/header。真实调用必须由持久化 `models` row 构造，并在调用前通过已审批准入、circuit、quota 和 budget；test/local fake 使用编译期 strict fixture。adapter 不能按字符串 model ID 现场选择另一版本，只消费已固定 snapshot 与 secret handle，不接收客户端或 Skill 提供的 Key、endpoint 或 header。media/审核 model row 必须在 registry 边界被拒绝。

Google 多模态 Brain 使用 `google + google_generate_content`，沿用相同工具、编译、费用和恢复边界。工具调用的可选 `provider_metadata={google:{thoughtSignature}}` 由 adapter 从真实响应收集，不从工具参数或用户文本读取；随调用存入 transcript，重建消息与恢复 outcome 时保留，普通摘要和公开 trace 不包含签名。OpenAI reasoning effort 不发送给 Google，SDK retry 保持关闭。

模型选择是用户确认的创作参数和服务端安全快照：runtime 必须在 turn 创建时解析并固定用户选择的单一 snapshot，后续步骤不得因可用性、预算、超时或熔断选择另一个 snapshot。**临时错误的统一重试口径（产品裁决）**：只有明确且可重试的 `not_dispatched` 可对同一 snapshot 退避后重试，**最多 3 次重试（含首次共 4 次尝试）**；第 4 次仍连续未投递时立即 fail closed 为 `AGENT_MODEL_UNAVAILABLE`。Provider 返回**空响应**（HTTP 200、无文本、无工具调用、`usage` 全 0）不构成 `accepted`：无任何 token 消耗，adapter 可在三态分类前自动重试，同样**最多 3 次重试**，仍为空才归 `outcome_unknown`。**余额不足、预算超限、账号冻结等资金与权限类失败一律不重试**，立即以准确文案终局。任何 `outcome_unknown` 都立即结束当前 turn，用户需要新建 turn 后重试或重新选择模型。`outcome_unknown` 始终保留 exposure，`not_dispatched` 只有在 transport 明确证明请求未离开本机时才释放 exposure。进入 Brain 调用前的 Skill、图片索引、事实或 context snapshot 阶段若遇到明确瞬时基础设施错误，可以先按 owner/revision/continuation CAS 释放 processing lease，再由 BullMQ 最多执行 **4 次总尝试（最多 3 次重试）**；进入 Agent loop 后禁止使用该队列级自动重试。

一个 Brain 响应可以包含 1-4 个纯 `load_skill@1` 或纯 `inspect_image@1` 调用，但不得与回答、澄清、事实确认或候选计划等 terminal action 混用，也不得混合两类非 terminal 工具。runtime 必须按 Provider 返回顺序逐个执行；每个调用分别经过 allowlist/schema、重复指纹、Skill/reference/token、图片授权与 turn 工具总预算校验，并分别写入脱敏 trace。任一调用失败后不执行该响应中尚未开始的后续调用，只向下一轮返回有界 observation；整组工具调用只投影一个 started/finished activity。调用数量不得超过 model snapshot 的 `max_tool_calls_per_response`、本次 `remaining_budget.tool_calls` 或平台硬上限 4。

不得因当前轮附件尚未 inspect 或进入 authoring 而增减工具清单。既有同批工具类型、terminal action、调用总数及权限约束通过稳定 schema、尾部 typed context 与返回值校验共同执行；非法批次返回有界反馈并按原规则计入预算，不能静默改写/丢弃模型调用。P1 不切旧请求读路径，P2 必须实现这一稳定工具前缀目标；在此之前不能把新目标描述为运行事实。

模型输出从 `unknown` 进入 strict discriminated union，只允许：

- `tool_calls`：1-4 个 `{ call_id, name, arguments }`，`call_id` 在本次 outcome 内唯一，工具名必须精确含 contract version。
- `respond`：显式 `agent_respond` 的 `{ text }`，普通用户可见回答，结束 turn。
- `chat_text`：模型原生无工具纯文本 `{ text }`，独立聊天结果，结束 turn；不得推断为工具或生成动作。
- `request_clarification`：`{ question, suggestions? }`，创建 clarification confirmation。
- `candidate_plan`：交给 `CompilerPort`，S09 前永远 fail closed。

不支持原生 tool calling/strict terminal output、usage 缺失、输出截断或 schema repair 超限时不得猜测成功。adapter 可以把厂商原生 function call、strict JSON terminal 或显式 terminal tools 归一为上述联合，但不能从自由文本正则提取隐藏工具调用。若厂商已返回工具调用与可信 usage、只是工具参数 strict schema 不通过，adapter 返回脱敏的 `invalid_tool_input` outcome；Worker 按 actual usage 结算并与 `invalid_terminal_output` 共用最多 3 次结构化修复机会（首次加最多 3 次新 Brain 步骤），反馈具体原因、路径、下一步及剩余机会；轮数、token 与成本预算仍可提前终止。不得归类为 transport `outcome_unknown`、保留虚假 exposure 或对用户声称服务波动。`respond.text`、原生聊天文本和 clarification 文本必须先通过统一 `PublicTextPolicy`：长度/UTF-8/控制字符、secret/Key/签名 URL 模式、内部 tool/参数字段、系统提示片段以及与已加载私有 Skill 的长段逐字重合检测；命中时不持久化、不发 SSE，写脱敏 guardrail 并允许剩余预算内一次结构化修复，重复命中则 fail closed。内容安全策略要求拒绝时同样不发布原始文本。

模型响应有可信非零 usage、却同时没有文本与工具调用时属于已送达的模型输出协议违规，不是未知投递；返回 `invalid_terminal_output` 并带 `empty_without_tool_call` 原因，按实际 usage 结算、与 `invalid_tool_input` 共用最多 3 次带指导的修复。唯一非空纯文本、无工具调用应成为独立 `chat_text`，通过公开文本安全检查后原子写入原生 assistant 历史、用户消息与 SSE，不能伪造成 `agent_respond`、计划或图片生成。文本与工具调用混排仍为协议违规。零文本、零工具、零 usage 沿用最多三次空响应重试，耗尽后保持 `outcome_unknown`，不得伪造零成本成功。无效输出不能创建回复、quote 或 workflow。

### 9.2 Tool registry 与策略边界

模型每一轮只收到当前 runtime 已启用的 ToolContract，不收到仓库中全部工具。ToolContract 至少固定：`name/contract_version/description/input_schema/output_schema/side_effect/activity_type/max_observation_bytes`，其中 `side_effect=none | read | idempotent_write`。服务端先对整批 call 做 registry/schema/预算/policy preflight；任一失败时整批都不执行。通过后按模型给出的数组顺序串行执行，不能因并行完成顺序改变 observation。

模型调用位置键只用于追踪某个 strict outcome 中的提议位置：

```text
call_position_key = sha256(turn_id + continuation_no + llm_step_no + call_index)
```

它不能作为业务副作用幂等键，因为模型恢复、重新规划或不同 step 可能再次提出同一动作。稳定业务操作键由 ToolContract 的服务端 `deriveOperationKey` 使用 `tool contract version + user/tenant + domain aggregate ID + canonical args + bound input versions + semantic operation` 确定性派生；同一业务动作跨 LLM step/Worker 重试必须得到相同键，不同语义动作必须不同。无法从服务端已授权 ID/版本派生稳定键的 `idempotent_write` 工具不得注册。

网络/写入前先持久化 tool step、`call_position_key/tool_fingerprint/operation_key?` 和 owner/revision。`idempotent_write` adapter 必须以 operation key 原子 reservation 并提供可重放 receipt；同 key 同 fingerprint 返回原 receipt，同 key 不同 fingerprint fail closed `IDEMPOTENCY_CONFLICT`。`none/read` 不产生 operation key，但仍按 tool fingerprint 参与循环保护。S08 production registry 不含业务写工具，后续 SPEC 必须分别证明“执行成功后进程崩溃”不会重复副作用。

服务端执行顺序固定为：

```text
model tool call
  -> registry exact match
  -> strict input schema
  -> ToolPolicy(state, user, ownership, budget)
  -> started trace
  -> tool adapter
  -> strict output schema + redaction
  -> persisted observation summary
  -> model continues
```

| 动作类别                 | 例子                                   | 最终门禁                                                             |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------- |
| `knowledge`              | `load_skill@1`                         | Skill published/stage/path/hash/token policy；不经过 Compiler        |
| `read`                   | 后续的资产/商品/产物读取               | ToolPolicy + 当前用户 ownership guard；S10 前不注册                  |
| `candidate_plan`         | 模型输出候选生成/编辑计划              | 必须进入 S09 Compiler 做 R1-R5、引用、能力、费用和 DAG 终审          |
| `generation_side_effect` | 生图、编辑、放大、视频等 Provider 执行 | 不直接暴露给 Agent loop；只能由 quote/reservation/workflow/task 激活 |

ToolPolicy、未知工具、schema 或预算 preflight 拒绝时，该动作 fail closed 且绝不执行，但在剩余预算内向模型返回有界、脱敏 observation：稳定 `error_code`、`retryable`、允许的下一步和安全摘要。单次拒绝不自动终止整个 turn，模型可以回答、追问或选择另一个已注册工具；连续同错、重复调用或无进展再由 §9.5 终止。模型看不到内部异常、权限规则细节、其他用户存在性或 Provider 原文。Skill 的 `required_capabilities` 只收窄候选计划能力集合，不能注册、启用或授权任何工具；Compiler 仍按不可变 Skill/registry/context 独立终审，不能信任 Brain 已遵守 schema。

S08 production registry 只允许 `load_skill@1`。用于测试循环、错误和恢复的 fake tool 必须由 test-only composition root 注入，`APP_ENV != test` 时启动断言其不存在。S10/S12/S13A/S13B 后续增加读取或生成能力时，必须在对应 SPEC 同时冻结 ToolContract、ToolPolicy、幂等/并发、receipt/崩溃恢复、公开 activity 映射和失败测试。

### 9.3 `load_skill@1` 契约

输入是 strict discriminated union：

```json
{
  "skill_id": "slug@1.2.3",
  "view": "planning"
}
```

或：

```json
{
  "skill_id": "slug@1.2.3",
  "view": "references",
  "reference_paths": ["references/composition.md"]
}
```

规则：

- `skill_id` 必须精确匹配本 turn selection snapshot 的 optional auxiliary，或在 `view=references` 时匹配已自动加载的 primary/required auxiliary；禁止通过 `view=planning` 重载 primary/required auxiliary，禁止另一个 primary、全站搜索、`latest`、版本范围、模型自造版本和客户端传正文。
- `planning` 加载该版本 L1；`references` 只能在该 Skill 的 L1 已加载后读取 frontmatter 明确声明的一跳路径。单次最多 4 个去重路径，累计仍受 12 个 L2 和总 token 预算限制。Preset 不能作为模型重新选择风格的入口。
- 第一次 Brain 调用前自动加载 primary L1、用户所选 Preset 与全部 required auxiliary L1；optional auxiliary 和 L2 完整知识只能来自模型发起的 `load_skill@1`。required auxiliary 不再消耗模型 round/tool-call；候选计划前仍由 terminal preflight 确认全部 required 知识存在，缺失表示 runtime 漂移并 fail closed。
- 核心知识加载只在会话首个 turn 投影一次 `knowledge_loading`；同会话后续 turn 仍需为无状态模型静默注入同一有界知识前缀，但不得重复显示该活动。optional auxiliary/L2 的动态加载按真实调用继续投影。
- 加载内容计入资源/L1/L2 与总输入 token 知识预算；Skill 数量只统计 primary + 去重后的 auxiliary，Preset 是 primary 内资源，不作为独立 Skill 计数。模型发起的每次加载都占 tool-call 次数并进入重复/no-progress 保护；重复加载已加载 auxiliary/reference 返回 `already_loaded=true` 且不重复注入 token。
- 模型不能跨 Skill 借用 reference，也不能用 `required_capabilities` 要求 registry 开放工具。已加载的精确版本在本 turn 内不可替换；需要新版本只能由新 turn 重新选择。
- 内部 tool result 可把通过校验的知识块注入当前模型上下文；持久化 message/trace/SSE 只保存 snapshot ID、path、hash、token count 和安全摘要，不保存或公开完整正文。
- 重复加载相同 snapshot 返回 `already_loaded=true` 且不重复注入 token；同一路径不同 hash 返回 `SKILL_VERSION_DRIFT`，不能作为新知识继续。

### 9.4 默认预算

成本与单次模型能力仍取“系统上限、model snapshot、运营配置”三者最小值；rounds/output 按 `02` 的 2026-10-03 任务量策略派生，历史 quota 不原地修改：

| 预算项                          |                                                      1A 硬上限 |
| ------------------------------- | -------------------------------------------------------------: |
| LLM 往返                        |                       基础 6 + 额外节点写作轮 + 额外附件检查轮 |
| 工具调用                        |                           基础 12 + 额外已鉴权图片的检查调用数 |
| 同一 canonical fingerprint 执行 |                                           2；第 3 次执行前阻断 |
| schema repair                   |                                                              3 |
| 连续无进展 observation          |                                                              3 |
| 连续同工具/同错误               |                                                              3 |
| active context                  |                                                        272,000 |
| 输出 token                      |                        任务有效轮数 × 单次额度；单次默认 8,192 |
| Agent 大脑平台成本硬预算        | 等值 3 内部预算积分/turn，按版本锚定换算 CNY；不直接扣用户积分 |

金额通过 `packages/shared` Decimal 工具计算。这里的“内部预算积分”只用于统一比较平台成本，不是 `credit_ledger` 货币动作。Agent brain 成本由 S08 记录为平台成本；是否摊入后续商品报价只能由 S09/S04 的 pricing snapshot 裁决。模型不返回可靠 token usage 时当前 turn fail closed；不得继续无限调用。

每次 LLM 调用的成本状态固定为：

```text
step_exposure = request_base_cost
  + requested_input_tokens * input_rate / 1_000_000
  + requested_max_output_tokens * output_rate / 1_000_000

budget_used = agent_traces.estimated_cost + agent_traces.reserved_cost
```

`requested_input_tokens` 是本次发送前由统一 counter 得到的 active context 估算：文本按已识别模型的 tokenizer 计数，未知 tokenizer 保守使用 UTF-8 字节上界；图片按模型对应的视觉规则及实际物化尺寸估算。摘要使用同一文本计数策略，Provider 返回的可信 usage 是结算和后续诊断真相。估算器不可用或结果非法时真实调用 fail closed。估算值不得超过有效 context window，并须在 model `max_context_tokens` 中至少为输出保留 1 token；超限时任何 Brain 网络调用都不得发生。`inputTokenTotal` 是跨步骤的 usage/成本统计，不是本次 active context 的剩余预算，也不能据此阻断仍未达到 context window 的正常多轮对话。由于调用前不能证明 cache 命中，exposure 一律按非缓存 input rate 计算。调用前在同一短事务创建 started LLM step、固定精确 model snapshot，并执行 `reserved_cost += step_exposure`；若加总后超过 turn 预算，调用不得发生。

`requested_max_output_tokens` 必须作为本次 Brain 调用的显式参数，由 `AGENT_BRAIN_STEP_MAX_OUTPUT_TOKENS`、model snapshot 单次输出上限、`max_context_tokens - requested_input_tokens` 与任务累计剩余输出四者取最小值；默认单次额度为 8,192。`AGENT_MAX_OUTPUT_TOKENS` 保留为运营收紧累计额度的覆盖，默认最大合法任务容量；实际额度按工作单元/有效轮数计算，不设每张提示词固定长度。提示词逐节点编写并以真实私有调用/配对回执 checkpoint 恢复；完成覆盖之前不创建 quote/workflow。repair 仍最多 3 次，反馈实际单次额度及截断/解析/schema 分类。`AGENT_MAX_ESTIMATED_COST_CNY` 默认 `0.15`，且启动时不得超过“3 内部预算积分 × 0.05 CNY/积分”的系统硬上限；最终 turn 成本上限仍取系统、model snapshot 与运营配置三者最小值。若该独立成本额度不足，多图仍须明确成本阻断，不得宣称仅修改 token 后能无条件稳定出图。

OpenAI Chat Completions 的 SDK 会为不完整 usage 补零，不能将该默认值当成可信计费证据。adapter 必须核验原始 `prompt_tokens` 和 `completion_tokens` 均为非负整数；缺失时归 `outcome_unknown`，不结算为零、不进行空响应重试。此规则同时适用于流式、非流式和摘要调用，原始 usage 不进入日志。

待压缩历史自身超过压缩模型窗口时，Worker 必须从当前 summary boundary 后最老的连续完整 turn 开始分批摘要，批次只允许缩短尾部，不得跳过中间 turn；成功后由下一轮继续推进 coverage。当 session compaction 不可用或明确 `not_dispatched` 且完整上下文已达到硬上限时，Worker 可以派生 emergency working set：按最早到最新的顺序逐组移除完整终局 turn，每次重新执行同一 token counter，直到低于硬上限。该降级只影响当前模型视图，不删除 PostgreSQL 消息，不推进 summary coverage，不拆分 turn，也不得移除当前 active turn；active turn 自身仍不适配时返回 `AGENT_SESSION_CONTEXT_TOO_LARGE`。compaction 为 `outcome_unknown` 时不得继续调用 Brain，必须保留 exposure 并以 `AGENT_MODEL_UNAVAILABLE` 结束当前 turn。

收到 strict outcome 与可信 usage 后，使用 `03` 的 token 价格公式计算 `actual_step_cost`，在同一 owner/revision CAS 事务执行：

```text
reserved_cost -= step_exposure
estimated_cost += actual_step_cost
input/output token total += verified usage
step.estimated_cost = actual_step_cost
step.status = succeeded | failed
```

重复完成只允许 no-op，不得重复减 exposure 或累加 actual。只有 transport 明确证明请求未离开本机时，才可释放 exposure 并以 0 成本收敛；超时、连接复位、响应截断/非法、usage 缺失或调用后崩溃都标记内部 `AGENT_CALL_OUTCOME_UNKNOWN`，保留 exposure 在 `reserved_cost`，不把未知调用伪装成 0，并立即终止为 `AGENT_MODEL_UNAVAILABLE`。只有明确可重试的 `not_dispatched` 可在预算内使用新 step、新 idempotency key 和新 exposure 重试，**最多 3 次重试（含首次共 4 次尝试）**；用尽后仍连续未投递时立即终止，不得继续消耗通用 6 轮预算。空响应（`usage` 全 0）按本节统一口径同样最多重试 3 次，不占通用 6 轮预算。任一可信 Brain outcome 都会把连续未投递失败计数归零。旧输出即使晚到也因 owner/revision CAS no-op。actual 高于 exposure 时仍完整计入 estimated cost，随后立即 block 并告警 pricing/model 契约漂移。

### 9.5 canonical args 与循环保护

工具指纹：

```text
sha256(
  tool_contract_version
  + tool_name
  + canonical_json(normalized_args)
  + reference_binding_versions
  + loaded_skill_resource_hashes
)
```

canonical JSON 必须：对象 key 排序、去除 undefined、补齐 schema 默认值、统一空集合、decimal/string/UUID 规范化；数组只有 schema 声明为集合时排序，否则保留业务顺序。原始自然语言不能替代已解析 binding ID。

进展指纹只由服务端真相组成：turn 状态、有效绑定 ID+version、新 Skill snapshot ID、新确认字段、candidate plan hash 和 compiler 结果。回复措辞或 observation 文本变化不算进展。

触发：

- 第 3 次准备执行同一工具指纹：`AGENT_REPEATED_TOOL_CALL`。
- 连续 3 个 completed observation 的 progress hash 不变：`AGENT_NO_PROGRESS_LOOP`。
- 连续 3 次相同 `tool_name + args_hash + error_code`：`AGENT_REPEATED_TOOL_ERROR`。
- rounds/tool/token/成本任一超限：`AGENT_LOOP_LIMIT_EXCEEDED` 或 `AGENT_BUDGET_EXCEEDED`。

触发后同事务写 guardrail step、trace blocked、turn blocked 和 `turn.guardrail_triggered`；此后不再调用 LLM、工具、compiler、收费 Provider 或创建 quote。

## 10. 上下文组装与 stale 防护

上下文信任等级不等于拼接位置：平台/权限/交易规则始终裁决，Skill 和历史均是带来源的数据。`transcript_v1` 的模型排列以 `02` 第 11.0 节为准：稳定 policy/工具 -> 核心 Skill -> summary checkpoint -> 有序语义历史 -> 当前权威 host 更新。phase 和 draft 不另起记忆，当前用户输入不重复注入。

- `legacy_v1` 保留旧格式恢复；`transcript_v1` 按 token 窗口选择连续完整终局组并保留 active turn，不用固定 12 条消息作为记忆上限。tool 只投影验证过的语义结果或受控引用，图片按授权与物化预算读取。
- 图片只以服务端签发的 opaque binding key、角色、尺寸（可能未知）和 hash 进入初始 Brain 视图；`inspect_image@1` 才能按 `overview/detail` 读取当前用户仍有权限的真实图片。Worker 对每个 binding/hash 只保留一份当前物化 payload，overview 升级 detail 时替换旧 payload；单个 Worker turn 的物化图片总字节默认上限为 64 MiB，单张图片仍受 20 MiB 上限约束，超限必须在 Provider 网络调用前 fail closed。图片二进制、路径和签名 URL 不进入消息、summary、trace 或 SSE。
- session summary 只覆盖已经终局的 turn，记录 summary version 和 through turn；当前/未终局消息不得被摘要吞掉。
- 只读取当前 session 和当前用户已显式绑定资源；不自动搜索其他会话、整个资产库或未来画布。
- OCR、图片文字、网页文本、附件 metadata 与历史 assistant 输出都作为 untrusted data 包裹，不能成为 system/Skill 指令。
- context snapshot 只保存 ID、版本、hash、选择原因和 token 预算，不保存签名 URL、二进制或完整私有 prompt。
- Worker 完成上下文加载后写 `context_snapshot_json/hash`；后续每个状态写检查 owner/revision。S09 编译前再按当前 DB 版本重算关键绑定，hash 不同返回 stale，不套用旧计划。

## 11. Skill L0/L1/L2 runtime

### 11.1 加载规则

- L0 对内置 Skill 只暴露当前工程内容的 `slug/name/description/category/stage/required_capabilities/version`；对外部 Skill 只暴露 published、当前 stage 可用的同一组安全元数据。不暴露正文和内部评测。
- L1 只读取固定版本根目录的 `SKILL.md` planning view；单 Skill 上限 4096 tokens，同时最多加载 6 个 Skill（1 个 primary + 最多 5 个去重 auxiliary）。Preset 使用独立 resource snapshot 和 token 预算，但不作为第 7 个 Skill。
- L2 只读取 L1 frontmatter 显式声明的直接引用；路径必须匹配 `references/[a-z0-9][a-z0-9-]*.md`，最多 12 个 reference。
- 禁止 absolute path、`..`、反斜杠、URL、percent-encoded path、symlink 逃逸和 reference 再递归加载 reference。
- 单文件字节/token、L1/L2 总预算同时校验；超限返回 `SKILL_RESOURCE_LIMIT_EXCEEDED`，不得静默截断成另一套语义。
- 文件缺失、hash 漂移、未发布版本或 schema 非法 fail closed；禁止 fallback body。

### 11.2 snapshot 与缓存

资源 bytes 统一 UTF-8、LF 后计算 SHA-256。数据库 `skill_resource_snapshots` 是真相：首次加载在短事务中插入 `content_text/hash/summary/kv_key`；同一 skill/path 已存在但 hash 不同即 `SKILL_VERSION_DRIFT`。legacy snapshot 的 `content_text is null` 不代表空正文，必须先按 §6.4 完成受控 hydration，runtime 不得从 hash 猜测或直接绕回文件继续。

Redis key 继续使用 `02` 约定，并包含 version/path hash/content hash。读取缓存后必须复算 hash：

- cache hit 且 hash 匹配：使用摘要/正文。
- 外部 Skill cache miss：从 DB snapshot 读取并回填；Redis 不可用时允许从 DB snapshot 继续，记录 degraded 指标。
- 内置 Skill 始终从工程内容 loader 读取并校验当前 hash，不使用外部 DB snapshot；外部 Skill 不得改用未经 snapshot 校验的磁盘正文。
- 外部 Skill DB 无 snapshot 时可从当前不可变发布包首次建立；发布包与 skills row 不匹配则阻断。

trace/chat message 记录实际使用的 snapshot ID/hash，而不只记录 Skill slug。外部 Skill 后续版本变化不影响历史 turn 回放；内置 Skill 的新 turn 记录当前工程内容 hash。

### 11.3 package installer 与 catalog release

内置 Skill 不走 package installer 与 catalog release：它们由工程源码随 API/Worker 一起部署，启动时读取同一份内容并按 hash 校验。修改内置 Skill 后重启两个进程即可对新 turn 生效；版本号只记录内容变更，不代表审批或激活状态。历史会话继续创建的新 turn 也按当前内置内容解析，单个正在执行的 turn 在本次执行边界内保持一致。以下 package/release 条款仅适用于外部 Skill 包。

- 标准 `.skillpkg`、作者工作区、可复现 pack、manifest、路径/MIME/大小、package/Skill/resource digest、依赖、重新验证和权限边界以 `02 §11.2` 为正文。S08 必须交付 `skill:scaffold/pack/validate/diff/install`、纯 validator、quarantine adapter、validation Worker、package/release Service 和只读合法/恶意 fixture；不开放公网或创作端安装 API。
- `SKILL.md` 的 `name/description/body` 是可复制 Skill 的作者入口；`skill-package.json` 同时保存 package inventory 与按 `skill_id` 索引的 ecom-forge `skill_profiles`。validator 必须拒绝 profile/Markdown 身份不一致、`${slug}@${version}` 不一致和 definition hash 漂移，并由通过验证的内容确定性编译数据库 `definition_json`。
- `scaffold/pack/validate/diff` 不访问 DB/Redis/网络；`install` 仅允许 local/test，调用正式领域 Service 创建 quarantine package 和 validation attempt，不隐含 approve/publish。路径不进入审计正文；manifest/package/report/release digest、操作者和结果进入受控审计。
- S08 可隔离并校验 PNG/JPEG/WebP，但本轮不交付图片去元数据重编码与公开 CDN 发布适配器；含图片资源的 package 在审批时 fail closed，不能物化到 catalog/runtime。后续启用图片资产必须先交付并评审净化、权利校验和公开只读资产登记链路，不得直接发布 quarantine 原字节。
- package 生命周期、validation report 生命周期与 release 生命周期必须按 `04 §15`、`05` 正文实现。审批固定 passed report/validator/eval-suite digest并物化不可变 Skill/resource snapshot，但不切 active release；一个精确 Skill ID 只能由一个 package record 拥有。
- validation 使用 `06` 的 v2 `skill-package.validate` payload、DB intent、合法稳定 job ID `skill-package_validate_{report_id}` 和 report processing lease。Worker 只读取持久化 ID/hash，终态 report 不重跑，崩溃只接管同一 attempt；不得把 archive bytes、object key、Skill 正文或 eval 数据塞进队列。
- queue 发布必须执行两阶段：Release A 同时解析 v1/v2、heartbeat 声明支持版本且关闭 v2 Producer；所有旧 Worker drain 后，Release B 提升 recovery schema v2，readiness 在新 sentinel reconciliation 完成前 fail closed，完成后才启用 validation Producer。历史 v1 intent 不改写。
- S08 自动化测试可用受控 local/test fixture 命令显式 approve 和 publish；staging/beta/production 必须等待 S14 Admin Auth/MFA/permission/step-up/API。S14 前真实环境 installer、approval、publish readiness 全部 fail closed。
- catalog query 和 turn create 都读取 `skill_catalog_state.active_release_id`，并再次检查 package 未 disabled、release closure 完整、resource hash 未漂移。catalog item 必须属于同一 active release；不得把多个 release 的 primary/Preset/dependency 拼接成临时目录。
- release draft 从明确 base release + changes 解析成完整 closure；publish 使用 expected catalog/release revision 和幂等键，在同一短事务验证整个 manifest、写 published/retired 状态与 active pointer；并发发布只有一个赢家。事务外不下载、解包、运行 eval 或访问网络。
- rollback 创建新 release 序号并复用目标旧 release 的已审批完整 manifest，写 `rollback_of_release_id` 后按同一 publish CAS 切换；旧 release/Skill/resource/report 永远不被原地改写。
- validator/eval/policy 升级可对原 digest 创建新 report。critical 安全失败必须 disable 并立即阻止新 turn；非 critical 质量风险写服务端 24h due time，期间禁止新 release，逾期时 catalog/turn create 自行 fail closed，deadline sweeper 只 CAS 写一次持久化阻断和审计。重新验证不改变历史 turn 的 selection/resource snapshot。
- S08 Worker 必须交付 `skill-risk-deadline` sweeper：默认每分钟按 `(risk_status,risk_review_due_at,id)` keyset 分页扫描到期且 `risk_blocked_at is null` 的 package；每行以 `id + revision + needs_review + due<=server_now + risk_blocked_at is null` CAS 写一次 `risk_blocked_at`，并在同一短事务追加脱敏审计和 outbox。扫描器停机、重复运行或多实例竞争不能改变 catalog/turn 按 deadline 直接阻断的结果，旧 revision/重复 claim 只 no-op。
- 外部 Skill 的运行中/历史 turn 只读取 selection snapshot 固定的 package/release/resource ID+hash；active release 变化不能让 confirm、Worker retry、lease takeover 或 Redis 恢复升级知识。内置 Skill 的新 turn（包括历史会话继续创建的 turn）重新读取当前工程内容，正在执行的 turn 不在中途切换。

## 12. trace、事件与用户可见边界

### 12.1 trace 写入

- 单 turn 只有一条 trace，多 continuation 共用并累计预算。
- step_no 通过统一 helper 在短事务中以 `agent-trace:{trace_id}` transaction advisory lock 分配 `max+1`；唯一约束兜底，禁止无锁先查后写。
- 网络调用前写 started；调用后按 step ID + owner/revision 更新 succeeded/failed/blocked。
- turn 状态、assistant/tool message、trace step 完成和对应 outbox 必须在同一短事务。
- `input_summary/output_summary` 只允许 strict redaction schema；不得存完整 prompt、chain-of-thought、Skill 私有正文、附件文本全文、Key、URL 或 Provider 原文。

### 12.2 turn scope SSE

S08 把 S06 从 `workflow_run` scope 扩展到 `turn:{turn_id}`：query parser、ownership repository、stream log、public projector 和测试必须同步支持。非本人 turn 返回 404，未来 cursor/非法 scope 返回 400。

公开事件 payload 均携带 `turn_id/agent_trace_id`：

- `turn.created`
- `turn.status_changed`
- `turn.message_delta`
- `turn.response_draft_delta`
- `turn.response_draft_cleared`
- `turn.activity_started`
- `turn.activity_finished`
- `turn.confirmation_required`
- `turn.guardrail_triggered`
- `turn.superseded`
- `turn.interrupted`
- `turn.cancelled`
- `turn.completed`
- `turn.failed`

S08 必须同步更新服务端 `projectPublicEvent`、Web turn `SUPPORTED_EVENTS`、strict payload schema 和契约测试。未知事件/payload 继续 fail closed，不跳过 seq。`message_delta` 只传持久化 assistant message 的有序安全片段，不传隐藏推理；刷新后以 GET turn 的完整已持久化消息为准。

turn 事件 payload（除表中可选字段外一律 strict）固定为：

| event                         | payload 特有字段                                                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.created`                | `user_status=thinking`                                                                                                                                                                                                |
| `turn.status_changed`         | `previous_user_status/user_status`                                                                                                                                                                                    |
| `turn.message_delta`          | `message_id/delta_seq/text_delta/is_final`                                                                                                                                                                            |
| `turn.response_draft_delta`   | `step_id/draft_seq/text_delta`；仅为显式 `agent_respond` 或原生 `chat_text` 中已通过公开文本检查的前缀，不能代表正式回复或成功终态                                                                                    |
| `turn.response_draft_cleared` | `step_id`；候选未成为有效 `respond/chat_text`、被新轮取代或被安全策略拒绝时清除预览                                                                                                                                   |
| `turn.activity_started`       | `activity_id/activity_type/display_summary/status=started`                                                                                                                                                            |
| `turn.activity_finished`      | `activity_id/activity_type/display_summary/status=succeeded\|failed\|blocked\|cancelled/public_error_code?`                                                                                                           |
| `turn.confirmation_required`  | `confirmation_id/confirmation_type/confirmation_version/public_payload/expires_at/user_status=waiting_for_you`                                                                                                        |
| `turn.guardrail_triggered`    | `guardrail_type/action=stopped/summary/user_status=failed`；首次违规后最多三次候选工具结构修复仍非法时使用 `guardrail_type=invalid_model_output` 和固定公开摘要“创作方案未能形成完整结构，本轮已停止，请重新发送要求” |
| `turn.superseded`             | `new_turn_id/reason=new_user_message/user_status=stopped`                                                                                                                                                             |
| `turn.interrupted`            | `reason=user_requested`                                                                                                                                                                                               |
| `turn.cancelled`              | `reason=user_requested\|confirmation_expired\|policy_cancelled/user_status=stopped`                                                                                                                                   |
| `turn.completed`              | `message_id/user_status=completed`                                                                                                                                                                                    |
| `turn.failed`                 | `public_error_code/summary/user_status=failed`                                                                                                                                                                        |

每个 payload 还必须带当前 scope 的 `turn_id/agent_trace_id`；UUID、UTC 时间、枚举和字符上限均由共享 strict schema 校验。`public_error_code` 只取 06 允许向用户公开的 Agent 错误码；`summary` 和 `display_summary` 只取服务端枚举文案。

`turn.message_delta` 不是模型原始 token 流：runtime 必须先得到完整 `respond.text` 或 `chat_text.text`，通过 strict outcome、`PublicTextPolicy` 与内容安全，再在同一短事务持久化完整 assistant message，并把文本按 Unicode code point 确定性切为每段最多 1000 字符、总计最多 64 段的连续 outbox 事件。`delta_seq` 从 1 连续递增，只有末段 `is_final=true`；空文本不产生消息。任何校验失败都不得写 message/delta。这样刷新可由 GET 恢复完整文本，SSE 不成为内容真相。

真实流式预览使用独立的 `turn.response_draft_delta`，不改变上述正式消息语义。Provider 明确输出单个 `agent_respond` 工具入参或原生文本 delta 时，按 `step_id` 从 1 连续编号；reasoning 流、其他工具入参、完整 prompt 与隐藏推理一律不得转发。Worker 对累计文本做公开文本检查，保留足够的未发布尾部以检查跨 chunk 的秘密/私有内容重叠，限制总长度和事件数；每段经 owner/revision 和非终态校验后写 outbox，再唤醒 SSE。模型输出无效、文本与工具混排、步骤变更或中断时发 `turn.response_draft_cleared`；完整合法的 `respond` 或 `chat_text` 仍须按原流程校验、落库、生成正式 `turn.message_delta` 才能完成 turn。草稿不成为 chat message、工具授权、报价或账本证据。GET turn 仅对仍在运行的当前步骤从 outbox 重建草稿；正式消息或终态覆盖草稿，断线后不得重复、串轮或把草稿当成成功结果。

草稿快照的容错只适用于可选预览：非法事件 payload、重复/跳号或累计超长时，整个 `response_draft` 降级为 null，不发布部分文本，不修改原始事件或 turn 状态，正式消息和其他有效快照仍可读取。诊断只能记录固定错误分类，不包含模型文本或事件 payload。鉴权、活动、确认、正式消息和 SSE 仍按原契约校验，存储异常及其他完整性错误继续抛出。须以真实 API 故障注入覆盖四类损坏、重复读取无写入，以及合法草稿仍可恢复。

内部 trace 的 `tool_name/args_hash/error_code` 不原样进入公网。`activity_*` 只投影 strict `activity_type/display_summary/status`：

| `activity_type`     | 用户可见摘要示例                                   | 内部可能来源                                   |
| ------------------- | -------------------------------------------------- | ---------------------------------------------- |
| `knowledge_loading` | 正在加载专业知识                                   | `load_skill`                                   |
| `context_reading`   | 正在理解你的需求 / 正在分析参考图片 / 正在继续思考 | 首轮推理 / 图片按需物化后的推理 / 其他后续推理 |
| `plan_preparing`    | 正在准备方案                                       | candidate plan/compiler                        |
| `safety_checking`   | 正在检查安全与权限                                 | policy/compiler guard                          |

`display_summary` 由服务端按真实阶段从固定枚举映射，不接受模型自由文本。`context_reading` 的“正在分析参考图片”只能在上一项成功动作是 `inspect_image` 且图片已完成物化时产生；初始上下文只含 opaque binding 时不得使用该文案，后续若已经执行其他工具也不得重复沿用。历史事件中的“正在读取已授权的上下文”只为旧 turn 回放兼容而保留，新事件不得继续产生。失败时公网只给可操作的安全摘要；完整错误分类留在 trace。GET turn 快照必须从该 turn 的 outbox 重建每个 `activity_id` 的最新安全状态并返回 `activities[]`，因此刷新不依赖浏览器内存；activity type 与 summary 不属于同一受控映射，或 started/finished 的 type 与 summary 不一致时，快照 fail closed。`turn.status_changed` 只携带 `previous_user_status/user_status`，两者均来自 `thinking | waiting_for_you | stopped | completed | failed`；数据库 `from/to` 不进入公网，前端不直接翻译内部枚举。每次合法内部状态迁移仍追加一个连续 event seq；若迁移前后映射到同一 `user_status`，允许公开 payload 两值相同，客户端只推进 cursor、不制造新的 UI 阶段。

### 12.3 用户控制与恢复体验

- 运行中发送新消息就是“继续引导”：API 创建新 turn，并按 §5.1 在同一 session 行锁内 supersede 尚未提交的旧 turn。无需增加容易卡死的 `paused` 内部状态。
- 已经提交 workflow 的生成不会被新消息或 turn interrupt 静默停止；用户必须使用 workflow cancel。新 turn 可以读取该 workflow 的授权状态并解释进度，但不能改变其资金/Provider 状态。
- 用户点击停止时，按钮以首次 `interrupt` 202 为准；旧 Worker 可能仍在结束网络请求，但所有晚到写因 revision/owner CAS 被丢弃。UI 显示“已停止”，不宣称底层网络已物理瞬停。
- `turn.interrupted` 只表示用户主动停止；所有进入 cancelled 的路径同时发送 `turn.cancelled`，并以 `reason=user_requested | confirmation_expired | policy_cancelled` 区分。新消息取代使用 `turn.superseded`，不伪装成用户停止。
- SSE 断线或刷新先 GET turn 快照，再从 `last_event_seq` 补增量；临时 `message_delta` 或 activity 事件丢失不得丢失最终 assistant message、confirmation 或终态。
- 用户只看到回答、确认、结果、当前阶段和必要活动摘要；不得提供“展开思考”、原始工具调用、完整上下文或系统日志入口。

## 13. 安全、日志与监控

- 任何 tool 都有服务端静态 registry、strict input/output schema、side-effect 等级和最大输出摘要；未知 tool 的动作直接拒绝且不执行，重复越界按循环护栏终止 turn。
- Skill、用户输入和模型输出都不能更改 registry、预算、Provider/模型准入、R1-R5、权限或费用规则。
- Skill 以有来源标记的 `skill_knowledge` 数据块进入模型上下文，优先级低于平台 runtime policy、ToolPolicy/Compiler/Credit/ownership 和用户当前明确选择；不得把正文拼成可覆盖平台策略的裸 system prompt。validator/runtime 对伪装 system/developer/admin、要求忽略平台约束、启用未注册工具或泄露隐藏上下文的内容 fail closed。
- 日志只记录 user/session/turn/trace 的 HMAC 摘要、状态、error code、token/latency/cost；不记完整 message/prompt/answer/attachment。
- 指标至少包含 turn latency/terminal、LLM rounds/tokens/cost、tool calls/errors、guardrail 分类、Skill cache hit/miss/degraded/drift、lease takeover 和 stale write rejection。
- 告警：`SKILL_VERSION_DRIFT`、Agent 预算异常、guardrail 突增、lease takeover 持续升高、真实环境 fake adapter 被请求。
- `APP_ENV=test` 禁止网络；local 默认 fake；staging/beta/production 没有 S14 已审批 Agent brain model/Key/预算时 Agent route readiness fail closed。

## 14. 配置与启动门禁

Worker typed config 集中读取：

```text
AGENT_BRAIN_ADAPTER=fake|approved
AGENT_REQUEST_TIMEOUT_MS=240000
AGENT_PROCESSING_LEASE_MS=300000
AGENT_PROCESSING_RENEW_MS=20000
AGENT_MAX_LLM_ROUNDS=6
AGENT_MAX_TOOL_CALLS=12
AGENT_MAX_INPUT_TOKENS=272000 # active context window; not cumulative turn input budget
AGENT_MAX_OUTPUT_TOKENS=360448 # operator ceiling; actual turn allowance is task-sized
AGENT_BRAIN_STEP_MAX_OUTPUT_TOKENS=8192 # still capped by registered model capability
AGENT_MAX_REFERENCES=12
```

自动压缩阈值当前由 Worker typed runtime default 固定为 active context 的 80%（272K 窗口对应 217,600 tokens）；图片物化默认最大边长为 4,096 像素、单个 Worker turn 总字节上限为 64 MiB。这些策略不是客户端输入，也未作为独立环境变量开放。单图默认 6 轮/49,152 累计输出，4 图 12 轮/98,304，9 图 22 轮/180,224；工具额度为 12/15/20，无新附件的已鉴权历史图同样计入工作量。输出是可用上限，不是每张 Prompt 的目标长度。成本仍独立限制为默认 0.15 CNY/turn。

业务包不读取环境变量。配置超过本 SPEC 硬上限、时序关系非法、adapter 与 APP_ENV 不匹配、model snapshot 不可验证时启动失败。成本上限来自运营/model snapshot 与系统硬上限的最小值，不允许客户端覆盖。

## 15. 测试与验收命令

### 15.1 单元测试

建议路径：

- `packages/agent/src/loop/*.spec.ts`：terminal action、预算、canonical args、重复/no-progress/error loop。
- `packages/agent/src/context/*.spec.ts`：有界 history、context fingerprint、无关消息不改变绑定 hash、关键版本改变必变。
- `packages/skills/src/runtime/*.spec.ts`：L0/L1/L2、一跳引用、path traversal/symlink、hash drift、缓存 miss/degraded。
- `packages/skills/src/package/*.spec.ts`：manifest inventory、frontmatter 唯一真相、可复现 pack、archive/path/MIME/size、digest、dependency/release closure 和越权指令扫描。
- `packages/skills/src/authoring/*.spec.ts`：scaffold/pack/validate/diff 的稳定输出、隐私边界和不覆盖行为。
- `packages/provider/src/agent-brain/*.spec.ts`：fake structured outcome、usage、timeout/abort、禁止网络。
- `packages/provider/src/agent-brain/*.spec.ts` 同时证明 media/Agent Brain strict union 互斥、tool/terminal protocol 能力门禁、token pricing Decimal 公式与缺 usage fail closed。

### 15.2 API/Worker 集成测试

使用 `TEST_DATABASE_URL`、`TEST_REDIS_URL` 和唯一 `TEST_REDIS_PREFIX=s08-test-<run_id>`；沿用 S05 精确 ID 清理，禁止 drop/reset/recreate、`FLUSHALL`、`FLUSHDB`。

必须覆盖：

1. create 原子产生 turn/message/trace/intent/outbox；同 key 并发只一份，不同 payload 409；旧 create key 在同 session 已有更新 turn 后重放，必须原样返回旧响应且不能 supersede 更新 turn。
2. 同 session 并发新消息只有一个未提交 active turn；旧 Worker 晚到 CAS no-op，已提交 workflow 不受影响。
3. confirm 并发只消费一次 pending confirmation、只递增一次 continuation、只建一个新 job。
4. interrupt 与 Worker 完成竞态只有一个合法终态；interrupt 后晚到 LLM/tool 结果不覆盖。
5. lease 到期接管、旧 owner renew/write 失败、重复 job 不重复 tool side effect；同 continuation 已经合法推进 revision 后模拟崩溃，stalled 重跑仍能按 DB 状态接管，不会因 payload 的旧 revision 永久卡住。
6. Redis 全丢只重建当前 continuation；等待确认/终局不重建，且重建沿用 intent 审计基线而不是改写为 DB 当前 revision。
7. started LLM call 崩溃、超时、响应非法或 usage 缺失后，旧 step 以内部 `AGENT_CALL_OUTCOME_UNKNOWN` 收敛为 failed，保守 exposure 仍留在 reserved cost，并且不再自动调用 Brain；只有明确可重试的 `not_dispatched` 可用新 step/exposure 重试，**最多 3 次重试（含首次共 4 次尝试）**，用尽后立即以 `AGENT_MODEL_UNAVAILABLE` 结束。该状态可从 trace 恢复，不会因 Worker 重启清零、重复减账、无限调用或复用旧输出。明确未发出的调用才释放 exposure；可信 actual 原子从 reserved 转 estimated。
8. trace step_no 并发无缺口/重复；状态+message+outbox 原子。
9. turn SSE 非本人 404、gap 恢复、刷新 GET snapshot、activity started/finished 去重有序；GET snapshot 从 outbox 重建活动最新状态，刷新后与 SSE 收敛一致；API/SSE 都不泄露内部 turn status。
10. S09 前 candidate plan、非空附件和未注册 confirmation handler 全部 fail closed。
11. create/confirm/interrupt 首次响应持久化后，即使 turn 已继续推进或终局，同 key 同 canonical request 仍在任何状态校验/锁/supersede 前逐字段重放原响应；不同 request 409，重放不写事件、不递增 revision/continuation、不入队。confirm/interrupt hash 必须包含路径 `turn_id`，同 key/body 改打另一 turn 必须 409，不能错误重放旧响应。
12. 缺失 `skill_selection`、非 public/published primary、`latest`、版本范围、停用/漂移 catalog 选择均在创建任何 turn/message/trace/intent/outbox 或网络调用前拒绝；Agent 不存在隐式选择或替换 primary 的入口。
13. production registry 只有 `load_skill@1`；test fake tool 不得出现在非 test composition root。
14. 公网 activity 只含枚举摘要，不出现内部 tool name、args、Skill 正文、错误原文或 chain-of-thought。
15. 第一次 Brain 调用预载用户已选 primary L1、Preset 与全部 required auxiliary L1；optional auxiliary/L2 仅给 L0。核心知识计入 token 预算但不计模型 tool-call 次数；后续 optional auxiliary/L2 加载计入 tool/token/重复/no-progress 预算。Skill 数量只统计 primary + 去重 auxiliary，Preset 不单独计数。
16. legacy turn 的 create 幂等字段允许全空但不能伪装为 S08 新行；legacy Skill snapshot 只可在 hash 一致的受控 hydration 后执行，冲突时不删数据。
17. 新 trace/每次 llm step 必须固定 strict model snapshot；真实调用还必须引用精确 `models.id`。legacy 文本 model ID 不得猜测回填或用于真实调用；任何失败、超时或结果未知都不得在 adapter/runtime 内切换模型。
18. Agent Brain model 只能使用 `03` 的 agent strict 三件套；media model、无原生 tool/strict terminal、无可信 usage 或 capability/pricing/quota kind 不匹配均在网络前拒绝。Brain 每步接收服务端裁剪的 L0 catalog/action space，并可自主选择回答、追问、知识、工具或候选计划，不存在 Controller 固定意图路由树。
19. Preset 覆盖 required slot 缺失、重复 slot、超过 `max_selections`、未知/disabled option 和跨 primary option；全部在首次 LLM 前拒绝，runtime 不补默认。
20. selection snapshot/hash 创建后不可变。外部 Skill 的 confirm、队列重试、lease 接管和 Redis 全丢恢复始终使用原 primary/Preset/dependency resource IDs 与 hashes；内置 Skill 按 slug 使用当前 Worker 进程启动时加载的工程内容，并在单次执行边界内保持一致。
21. primary L1、用户所选 Preset 与 required auxiliary L1 必须在第一次 Brain 调用前自动加载，optional auxiliary/L2 不得预载。optional auxiliary 与所有 L2 只由模型从 selection snapshot 的精确一跳 allowlist 按需加载；候选计划缺 required auxiliary 表示 runtime 漂移并拒绝，递归 dependency、全站搜索和 auxiliary 自带 Preset 被拒绝。
22. 外部 Skill 在 catalog 缓存中仍显示但数据库已停用或 definition hash 已漂移时不能创建 turn；内置 Skill 不查询外部发布表，API 按 slug 将客户端记录版本归一化为当前工程版本。
23. 同一副作用在不同 LLM step、Worker retry、lease owner 和进程恢复后派生相同 `operation_key`；模型 `call_id/index` 变化不能改变业务幂等真相。
24. 同 `operation_key + tool_fingerprint` 重放原 receipt；同 `operation_key` 搭配不同 fingerprint 返回 `IDEMPOTENCY_CONFLICT`，且不会再次执行副作用。
25. package validator 对 manifest/frontmatter 双重声明、`skill_id`/path/hash 不一致、未知字段、脚本/WASM/archive bomb、secret/URL、许可证缺失和权限升级指令 fail closed；合法包确定性生成相同 definition/package digest。
26. local/test `skill:install` 同 archive/operation 并发只创建一个 package 和一个 validation attempt，不审批、不发布；staging/beta/production 命令启动即拒绝。CLI 路径和私有正文不进日志/审计。
27. validation report `queued -> running`、lease renew/takeover、旧 owner 晚到和终态 CAS 使用真实 PG/Redis；同 report 重复 job 只有一个终态，package revision/digest 变化使旧结果 cancelled/fail closed。
28. queue Release A 同时解析 v1/v2 但不生产 v2；存在 v1-only heartbeat 时升级/Producer 门禁拒绝。Release B 提升 recovery schema 后 readiness 先 503，v2 sentinel 完成才接流，旧 v1 intent 仍可恢复。
29. approved package revalidation passed/needs_review/critical 三路均追加新 report；needs_review 到期后即使 sweeper 停止，新 catalog/turn 仍按服务端时间阻断，sweeper 恢复后只写一次 `risk_blocked_at`/审计/outbox。
30. package approve 不切 active catalog；draft closure 缺依赖/含 disabled 或 needs_review package 时拒绝。并发 publish 只有一个 expected revision 成功，事务失败不改变 active pointer，rollback 创建新 release_no。
31. Skill 知识不能覆盖 platform policy、ToolPolicy、Compiler/Credit/ownership 或用户当前选择；合法 persona 只影响风格，恶意高优先级声明被验证/运行时拦截且不进入 Brain。
32. 管理 actor 端口不接受普通 user/session/`users.role` 伪装；S08 local/test fixture 使用显式受控 actor，S14 前非 local/test approve/publish/disable 全部 fail closed。

### 15.3 专项命令

- `pnpm validate:agent-trace-loop`：真实测试 PG/Redis，证明预算、重复调用、no-progress/repeated-error、interrupt/stale worker。
- `pnpm validate:skill-load-cache`：证明 L0/L1/L2、直接引用、DB 真相、Redis miss/degraded、hash drift。
- `pnpm validate:skill-package-install`：真实测试 PG/Redis/隔离 storage，证明包安装、validation lease/恢复、供应链恶意夹具、原子 release、重新验证 deadline 与 queue v2 两阶段门禁。
- `pnpm validate:golden-eval-gate` 在 S08 只交 harness 与 fake 数据集；S11 加正式内容和真实数据集，S12/S13A/S13B 加真实生成证据后才成为完整业务门禁。
- 完成后执行 `pnpm check`、`pnpm build`、`pnpm test:integration`、`pnpm test:worker`、`pnpm db:check` 和 `git diff --check`。

## 16. 验收清单

- [ ] create/confirm/interrupt/get 的 DTO、用户隔离、no-store、错误码和幂等均有集成测试。
- [ ] turn/message/trace/intent/outbox 原子创建，事务内没有网络调用。
- [ ] processing lease、revision、continuation_no 能阻断重复消费、旧确认和晚到 Worker。
- [ ] Agent 循环命中 rounds/tool/token/成本/重复/no-progress 任一上限后停止，且不进入收费链路。
- [ ] context 只包含当前用户显式工作集，关键版本变化会使旧 context hash 失效。
- [ ] Skill 只按 L0/L1/L2 加载；path traversal、递归引用、hash drift 和 fallback body 全部被拒绝。
- [ ] `.skillpkg` 可复现打包、manifest inventory/profile 与可复制 `SKILL.md` 分工、纯 validator、隔离安装和恶意包 fail-closed 均有单元/集成证据。
- [ ] validation report 的 owner/lease/revision、Redis 全丢、重复 job、旧 owner 晚到、package digest 漂移和终态不重跑均通过真实 PG/Redis 测试。
- [ ] queue v1/v2 两阶段发布、heartbeat 兼容检查、recovery schema v2 sentinel/readiness 和历史 v1 intent 兼容有专项验证。
- [ ] approve 与 publish 分离；完整 release closure、并发 CAS、事务失败、disabled/needs_review、rollback 新序号和历史 turn 不升级均被测试锁定。
- [ ] revalidation 的 clear/needs_review/critical 三态、24h deadline 直接阻断和 sweeper 持久化补偿闭环。
- [ ] Skill 知识始终低于平台/权限/交易策略，越权指令不能注册工具、改费用/权限、伪装高优先级或进入 Brain。
- [ ] 每个新 turn 都由用户显式选择 published primary；Preset slot、停用缓存、不可变 selection snapshot、仅预载 primary/Preset、模型按需加载 required/optional 和一跳 allowlist均有正反向集成测试。
- [ ] `call_position_key` 只用于审计，副作用 `operation_key` 能跨 LLM step、Worker retry 和恢复稳定重放，并拒绝同 key 不同 fingerprint。
- [ ] Redis 只是 Skill cache 和队列载体；DB snapshot/turn/trace/outbox 仍可恢复真相。
- [ ] turn SSE 可鉴权、补齐和刷新恢复；activity 使用安全枚举投影，用户看不到内部工具、chain-of-thought、完整 prompt 或私有 Skill 正文。
- [ ] 模型可自主选择知识和注册工具，但 ToolPolicy、Compiler、Credit 与 workflow 始终拥有权限、费用和执行终审。
- [ ] Agent Brain 使用独立 strict capability/pricing/quota 契约；token usage、成本 exposure/actual 收敛和结果未知均可审计且不会低估预算，模型选择不会被自动 fallback 改写。
- [ ] S09/S10/S11/S12 未完成能力保持 fail closed，没有假装完整生成闭环。
- [ ] 数据库只使用新的 Drizzle 前向 migration，无手写改库、删库或重建。

## 17. 会话语义历史扩展 (2026-09-07)

这是原 S08 的串行增量，不重开或绕过 S09/S10/S11 的既有权限、编译、资金和用户投影契约。直接上游为 `02` 第 11.0 节、`03` transcript 请求预算、`05` 新字段/表/锁/导入/summary v2、`06` 格式兼容、`08` 生命周期、`09` 专项验收；research 只作依据，不替代这些裁决。

### 17.1 交付阶段

**2026-09-09 范围修订**：用户明确不需要旧会话兼容，按 `02` 11.0 仅交付新会话 `transcript_v1/1`。本节此前关于回填、legacy 影子发布、双格式执行/恢复/排空/回滚的要求撤销；P1 持久化与 P2 读执行仍串行完成，新流程恢复和资金幂等不减项。历史 schema 不破坏性改写，实测不沿用旧会话。

| 阶段        | 本阶段必须交付                                                                                                                              | 本阶段不做                                                                          | 完成门槛                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P1 原生记录 | 前向 migration、strict items/private payload、统一写锁、幂等批次追加、atomic chat/trace/outbox、完整性/隐私/性能 harness                    | 不做旧消息回填、影子部署或续传/Todo；未过完整门禁不启用新流程                       | 真实 PG/Redis 验证顺序/配对/回滚/锁等待；最大合法 payload 兼容；量化基线达标                   |
| P2 原生执行 | 同一 transcript 驱动 planning/authoring/tools、稳定完整工具集、native-message adapter、新流程 pending operation 恢复、summary v2 与窗口规划 | 不做旧摘要转换、双格式执行、legacy drain 或旧格式回滚；不引入强制 Todo/固定艺术流程 | `09` 新流程全矩阵与相关 lint/typecheck/test/build/migration 全过，完整 diff 正反审查后交用户测 |
| P3 可选优化 | 实际 relay 续传/cache 参数 PoC、可选模型 Todo 与对应安全/回滚测试                                                                           | 不作为 P1/P2 的正确性前提                                                           | 独立契约复审与用户确认，不占本次完成判据                                                       |

三个阶段是依赖顺序，不代表并行开发能力。用户本次要测试的是 P1 + P2 的完整结果，不能只交影子写入就宣称“已统一记忆”。P1 的严格原子写有延迟/回滚风险；不使用 best-effort 丢记录换取“零影响”的表述。

### 17.2 模块与写入范围

- `packages/db`：只新增 schema/migration 与必要复合索引/约束；已有 migration 不编辑。空库与现有库向前升级均需验证，生产/本地验收库的迁移需在代码验证之后执行。
- `packages/agent`：versioned transcript types、canonical normalization、配对检查、受控 payload 读取端口、上下文窗口/摘要来源计算；复用 `packages/shared` canonical/digest，不另造成本或权限服务。
- `apps/api`：create/confirm/interrupt/session 入口的格式冻结、租户与 message history revision、原子用户投影；`apps/worker` repositories：模型结果/usage、tool batch/result、phase、summary、terminal callback 的原子存储与恢复。Processor 只协调领域服务。
- `packages/provider`：消费规范化完整历史并映射原生角色/工具结果；稳定系统和工具前缀。新格式不从 trace、分离 observation 数组或重新拼的 draft 获取第二套真相。
- 统一锁涉及的不只是 append helper。必须一起审查 API create/confirm/interrupt、Worker claim/LLM cost/summary、工具/terminal 写入、quote submit、settlement 和 outcome-unknown release 的调用顺序。已持有 account/领域行/turn 的调用者不能在深层临时补拿 session；按 `05` 在外层调整取得顺序并重验归属，不新增费用语义。
- `apps/web` 的公网协议不变；保留或补充现有恢复/重试分支测试。本扩展不增加原始历史 UI、费用卡、画布入口或 Skill 内容改写，也不改 `.claude`。

### 17.3 捕获和恢复的验收边界

- 首个 side effect 之前，整批模型输出已经严格验证并提交。执行失败/取消时未开始调用也有明确结果；下一次 Brain 前所有本批协议项已闭合。副作用幂等仍以领域 operation_key/receipt 为准，不能凭 transcript 或 trace 标记判断已经收费/生成。
- 已知执行前崩溃恢复原 operation；执行后崩溃查领域真相；结果写成后崩溃只 replay。将一次 `accepted/outcome_unknown` 当成“没记录，重新调用”是验收阻断项。
- planning draft 和最终 authoring 结果存严格私有 payload，完整保留可执行参数；二者和 phase 进入同一历史。新格式禁止从 trace draft 恢复或新增这类 trace 正文；残留旧格式拒绝执行，不实现旧恢复。
- 总预算复用当前 rounds/tools/output/成本限制；压缩计入同一 Brain 预算。共享历史不是无限上下文：source digest + sequence range + generation 的 summary CAS、active turn 保留和硬上限失败必须随 P2 同时完成，不能另留“后续补压缩”。

当前已交付 `05` 的 P1 私有 payload/item 纯校验、连续窗口协议检查，以及 owned read、原生用户消息/确认/核心 Skill 宿主绑定、知识工具结果配对和独立 owned 写事务入口。这些组件尚未接通生产捕获或 Brain。完整模型/terminal 来源及保守输入依赖继承、幂等批次追加、payload 与消息/trace/outbox 原子捕获、全调用链锁顺序仍未完成，不能把单条可读或事务夹具成功视为完整历史可执行；各轮证据和串行进度见 17.7-17.14。

### 17.4 新流程交付

1. 交付扩展 schema 与原生 transcript 运行时，审查完整 diff 并验证前向迁移。已有 turn 不自动升级；已应用 migration 不修改。
2. 新会话直接冻结 `transcript_v1/1`，残留旧格式拒绝执行。不实现 backfill、shadow 激活、双格式执行或旧摘要转换。
3. P1 按 `09` 输出完整性、最大 payload、SQL 次数、p50/p95、锁等待和物理容量基线。固定预算进入 typed config，不新增散落的 env 开关。
4. P2 完成新会话恢复、压缩和生命周期测试后才交用户实测。捕获能力与执行能力分别报告，不能把“能解析格式”当成“能执行”。
5. 用户于 2026-09-10 再次明确旧会话后续全部清理、不做兼容。清理作为后续独立操作核对会话范围及关联关系；不因此整库 reset、删除资金/任务/审计证据或改变已应用迁移。本轮不执行清理。
6. 最终联调前先检查现有服务/在途 turn，安排稳定 API/Worker 重启并等待 readiness/`worker_ready`；不启动第二 Worker，不在用户验收期间用 watch。用户明确验收前不 commit/合并/推送。

### 17.5 验证和状态报告

- 新增的 `pnpm validate:agent-session-transcript` 与实现路径/矩阵以 `09` 为准；当前已交付基础层和若干宿主读写组件，生产捕获与专项脚本尚未交付，不能报告专项验收已经通过。
- TypeScript 实现至少执行相关 Vitest、`pnpm lint`、`pnpm typecheck`；本扩展还执行 `pnpm validate:agent-trace-loop`、`pnpm test:integration`、`pnpm test:worker`、`pnpm db:check`、受影响构建和 `git diff --check`。新增 package script/工程配置时按根规则补 `pnpm install`、`pnpm check`、`pnpm build`。
- migration 在空库从零和既有结构升级库验证，资金/权限/状态/幂等回归与失败/并发矩阵不能只靠 mock。量化报告写真实 p50/p95、场景及样本数；`09` 的估算和目标不充当通过证据。
- 完成报告分别列出契约审查、P1、P2、代码审查、用户验收状态，以及尚未导入/排空的 session 和未运行检查。只有修复并复验后才能明确说“代码审查通过”；数据库基础层或私有 payload 纯校验的局部通过不等于整个扩展代码审查通过。

### 17.6 数据库基础层检查点 (2026-09-07)

以下记录该基础层交付时点的证据和未完成项，保留为历史检查点；后续私有 payload 增量及容量反证以 17.7 为准。本次未重跑数据库集成测试，也未修改已经应用的 `0038` migration 或其 metadata。

- 已实现：session 语义序号/revision/generation、默认 off 的状态字段、turn 冻结格式字段、两张私有 transcript 表、归属复合外键、去重/配对索引、前向 migration `0038` 及 snapshot/journal。旧数据仍为 `legacy_v1`，不自动捕获或升级。
- 实测：`pnpm.cmd --filter @ecom-forge/db test` 为 6 个文件、153 项通过，其中新增 transcript migration 测试 74 项；全仓 `pnpm.cmd lint` 和 `pnpm.cmd typecheck` 均为 14/14 包通过。数据库 build 与 Drizzle metadata check 通过；格式和 diff 检查限定本次改动范围。
- 正向验证覆盖空库从零、既有结构升级、旧消息/摘要保持、bigint 无精度丢失、8 MiB 规范化内容完整往返，以及迁移实际 hash/时间戳与文件一致、重复迁移不改历史/计数器。
- 反向验证覆盖跨用户/会话/turn 引用拒绝、畸形结构、重复 source/sequence/result 拒绝、事务回滚、并发序号分配和有界锁等待。这些是数据库约束及事务夹具测试，不是生产 append、执行 fencing、全链路锁顺序或恢复测试。
- 尚未实现 strict 语义 parser、真实 digest/字节复验、API/Worker 原子捕获、source provenance 复验、导入与生命周期清理、混版本 readiness、完整性/性能 harness；结构性 JSON CHECK 和声明 `byte_size` 的范围不能替代这些门禁。普通 `db:check` 只检查基线结构，不能证明 `0038` 已安装。
- 大载荷兼容性尚未放行：32 节点多字节 prompt 夹具通过候选/authoring schema 及逐节点 adapter 后，authoring 和合并计划的 canonical UTF-8 均超过 8 MiB；该探测未执行完整 Compiler、真实模型或计费链路。实际 Brain 8192-token 输出预算、Provider 完整 prompt 限制和宿主扩展/导入路径仍需一起验证，不能把它称为已复现生产故障，也不能用普通 8 MiB 往返测试宣称最大合法输出已兼容。不得为满足存储边界缩短创作 prompt 或截断 JSON。
- 本检查点未迁移验收库、未导入/激活任何 session、未重启 API/Worker、未调用收费 Provider、未删除测试库、未提交。P1/P2 完整验收和用户验收均未完成；下一交付为 strict 语义与 payload 校验，再接入原子影子写入，P2 仍须等待 P1 全部门禁通过。

### 17.7 私有 payload 纯校验检查点 (2026-09-07)

- 已实现：`packages/agent` 的 strict 私有引用解析、捕获准备与读回复验；宿主注入既有领域 schema，完整复验实际 canonical UTF-8 字节/hash、kind/version、user/session/turn/import 身份，返回独立且深度冻结的正文。无数据库、Provider 或权限 I/O，不新增公网错误码、环境变量或循环依赖。
- 正向验证：实际 authoring/candidate schema 无损往返，重新编译后的快照/费用一致，8 MiB 多字节 JSON 完整保留，普通 Unicode、合法代理对、null-prototype object 和共享子对象均可存储；身份 UUID 小写规范化不改变正文或调用方输入。
- 反向验证与修复：拒绝 parser 删字段/裁剪/补默认/强制转换、伪造 hash/字节数、跨 scope 引用、异常正文泄漏、稀疏数组及其伪索引、循环/accessor/非 JSON 值；shared 检测并拒绝比较器判等的不同 key，不改变既有 canonical/hash 规则。8 个 UUID 回归先失败，修复后全部通过；真正不同的 UUID 仍拒绝。
- 本次实测：Agent 3 文件/114 项（其中私有 payload 103 项）、Shared 5 文件/40 项、Compiler 5 文件/88 项，共 242 项通过；全仓 `pnpm.cmd lint`、`pnpm.cmd typecheck` 各 14/14 包通过，Agent/Compiler/DB 及依赖的 Turbo build 6/6 通过。测试为无收费调用的本地夹具，不是生产捕获、真实授权读取或完整性能证明。
- 容量复核：按现有 Provider 完整 prompt 上限 128000 减去既有 512 字符 envelope 预留，127488 字符的多字节单节点夹具通过完整编译、存储往返和再次编译。32 节点夹具通过结构 schema 且超过 8 MiB，但完整编译被 `creative_profile_single_image_node_required` 拒绝；不能将其描述为已复现的合法线上回归。全部合法输出、8192-token Brain 可达性、宿主扩展/导入路径与跨运行环境 canonical 兼容性仍是激活门禁，不缩短 prompt 或截断 JSON。
- 当前纯校验增量已完成正反代码复审，代码审查通过仅限此边界；完整工作区差异与新增文件一并复核，其他开发的 Skill manifest、Next 声明和 `.claude` 未改动。完整扩展审查、P1、P2 与用户验收均未通过。
- 下一交付：versioned item envelope 与协议配对，再实现读取正文前的 live item/来源/依赖授权、执行 fencing 和原子影子追加。API/Worker 全局锁顺序、导入/清理、混版本 readiness、性能 harness 和 `validate:agent-session-transcript` 均未交付。本检查点未运行全链路 Agent/Worker/API/E2E 门禁，未迁移验收库、重启服务、调用收费 Provider、删除数据库或提交。

### 17.8 Item envelope 与协议校验增量 (2026-09-08)

- 范围：按 `05` 的内部 v1 结构实现无 I/O item prepare/readback、宿主 schema 注入、64 KiB/digest 校验与连续窗口配对。复用私有 payload 的 JSON 安全规则；不改 `0038`、公网 API、Provider adapter 或当前模型读路径。
- 正向复审：保留工具原顺序、terminal 动作闭合、多 continuation 恢复、穿插用户/host 事件、legacy 来源与大型私有引用；不截断正文、不强制艺术步骤。
- 反向复审：跨 scope/turn、孤立/重复/错误 ordinal 结果、篡改参数 hash、失败后继续执行、遗漏父依赖、缺页、伪造终态、删除记录复活均须有反例。结构配对不证明 live 权限或领域动作状态，未物化正文单独列出。
- 契约与实现：本纯逻辑增量已实现；JSON 校验提取为 Agent 内部共用模块，不改变既有 canonical 规则或私有 payload 错误接口。引用清单明确标为未授权物化，协议 closed 不表示领域任务成功。
- 正反实测：Agent 4 文件/232 项（本轮 item/protocol 118 项）、Shared 5 文件/40 项、Compiler 5 文件/88 项，共 360 项通过。覆盖四结果全部 24 种到达顺序、失败后成功拒绝、跨 scope/turn、重复/孤立结果、terminal 闭合、跨 continuation 恢复、源与依赖、tombstone 拒绝回放、64 KiB 多字节边界及大型真实 authoring schema 引用。Compiler 现有往返夹具经过 item 封装/配对/读回再复验私有正文，完整重编译与费用快照一致，存储不绕过编译拒绝。
- 审查修正：复现非法超长 sequence 在格式失败后仍调用 BigInt；回归先失败，改为格式/长度通过后才进入范围转换，复验通过。清理 lint 指出的多余类型断言。没有把这次输入边界复现描述为线上事故或性能基准。
- 门禁：最终 `pnpm.cmd lint`、`pnpm.cmd typecheck` 均 14/14 包通过；相关 Turbo build 6/6 通过；构建后 ESM 入口确认 4 个新函数导出可用；本轮范围格式与完整 tracked diff/相关新增文件空白检查通过。
- 完整工作区 diff 和新增文件已结合前轮数据库证据复核，本轮纯 item/协议增量正反代码审查通过；不等于完整扩展、P1/P2 或用户验收通过。未运行本轮真实 PG/Redis、Agent 专项、全 API/Worker integration 或浏览器 E2E：生产宿主绑定、受控读取、捕获和专项 harness 尚未接入，这些是后续必过门禁，不是免检。
- 下一交付：按实际 API/Worker 领域 schema 绑定来源，实现在正文物化前重新鉴权的 owned repository，再接 owner/revision fencing 和全局锁顺序下的原子影子追加。业务直接引用、闭合组撤销投影、导入/清理、readiness、性能及 P2 切读仍待交付。本轮未改 migration `0038` 或验收库，未重启服务、调用收费 Provider、删除数据库、改 Skill/Next 声明/`.claude` 或提交。

### 17.9 Owned read repository 增量 (2026-09-08)

- 已实现 Worker `AgentTranscriptRepository.readItem`：显式 user/session/item 查询、真实 turn/message/trace 来源核验、父调用局部配对、按使用位置 schema 物化私有 payload。该 repository 尚未接入 Processor/Brain，不改变当前模型输入或执行恢复。
- 资源依赖在私有正文读取前和结果返回前分别调用宿主 live authorizer；缺少授权器、空返回、false 或异常均拒绝，空依赖列表不能免检。payload SQL 同时检查 user/session/turn/import、未归档 session、generation 和 message history revision；返回前复查 session，底层异常不带查询参数/cause 出口。
- 正反复审修正了本轮草稿的一项过度限制：完整性 checkpoint 只证明旧范围，不应阻断其后已经追加的当前轮消息。读取以已分配 sequence 范围为界，每条仍重新验证；完整窗口闭合、兄弟结果失败顺序和模型投影另行验证。trace step 先经 owned trace 再按 trace ID + step ID 查找，不使用裸 step UUID 作为授权。
- 单元实测：Worker 30 文件 / 198 项通过，其中本 repository 37 项，含真实 Drizzle SQL 编译断言、跨租户、父子配对、同 ID 多 schema、权限撤销先于 generation 清理和错误脱敏。Agent 4 文件 / 232 项回归通过。
- PostgreSQL 实测：`test/s08-transcript-read.integration-spec.ts` 9 项通过。使用前轮已安装 `0038` 的独立库；每例独立事务回滚并查询确认 session 夹具未持久化。覆盖大于 64 KiB 的真实 authoring schema、尾部读取、租户/会话/turn 隔离、源内容篡改、私有正文篡改、归档及 generation 变化。授权器是确定性测试实现，事务内仅 DB 操作，无 Provider/对象存储请求；不是生产授权实现或跨进程并发证明。
- 本增量最终 `pnpm.cmd lint` / `pnpm.cmd typecheck` 各 14/14 包通过。复验命令：`pnpm.cmd --filter @ecom-forge/worker test`；对已安装 `0038` 的隔离库设置测试进程的 `TEST_DATABASE_URL` 后，运行 `pnpm.cmd --filter @ecom-forge/worker exec vitest run --config vitest.integration.config.ts test/s08-transcript-read.integration-spec.ts`。本套测试不自动迁移或清空数据库。
- 未完成项仍阻止实测交付：生产宿主消息/资源依赖绑定、来源过期后的生命周期投影、keyset 完整窗口读取、统一锁顺序下的 fenced 原子捕获、导入/清理/readiness/性能 harness、P2 统一历史和 summary v2、全链路恢复与浏览器验收。不能将独立读取层或其 fake authorizer 当作 P1/P2 完成，也没有完成完整工作区的最终代码审查与用户验收。
- 本轮没有修改 migration `0038`、迁移验收库、重启 API/Worker、调用收费 Provider、改 Skill/Next 声明/`.claude`、提交或推送。完整迭代目标保持不变：P1 + P2 完成且通过全流程门禁后再交用户实测。

### 17.10 原生用户消息宿主绑定增量 (2026-09-08)

- Worker 新增 `agent-transcript-message-binding.ts`：`transcriptUserMessageSchema` 复用 Compiler 附件 schema；`verifyTranscriptUserMessageSource` 对真实 user message 的归属、逐字正文和完整附件数组做一致性检查；`AgentTranscriptUserMessageAuthorizer` 验证附件与资源依赖集合完全相等，并重新查询用户和资源的当前状态。它仅处理 `user_message`，不能作为工具/Skill/事实/legacy 的通用授权器，也尚未接入 Processor/Brain。
- 正向保留：空正文加附件、Unicode/空白、多角色引用同一资源、mention 筛选后的非连续 position、同一用户跨会话只读引用、确认选项标签与最长答案拼接。宿主绑定不 trim、排序、重新编号、重新施加创建请求字数限制，也不把 `mutable` 快照变成执行授权。
- 反向拒绝：源正文/角色/附件变化、混入工具或 approval 结构、资源依赖遗漏/多余/重复、非正常用户状态、跨租户/删除/隔离/缺失资源、内容 hash/版本漂移、图片 MIME 不符及发布 revision 漂移。查询按 user + IDs 分批进行，不跨读取缓存授权成功。asset/artifact DB 校验不证明对象存储的真实字节可读或 hash 正确，图片物化仍必须走既有服务。
- 重要边界：确认 message 仅保存 API 已写入的显示正文；完整结构化确认答案及 fact set 来源必须另有 host context，不能从“已确认商品档案”反推。`skillSnapshots` 是宿主选择指针，不作为用户文本或完整 Skill 知识；确认与 Skill 上下文绑定仍是后续激活门槛。
- 最终实测：Worker 31 文件 / 239 项通过，其中本增量 41 项；原 PostgreSQL 读取专项扩为 16 项通过，其中 7 项使用真实宿主用户消息绑定与真实 user/asset 查询。覆盖源附件篡改、依赖遗漏、删除不推进 generation、两次授权间 hash 漂移、资源换 owner 和用户冻结。所有夹具事务回滚，沿用已安装 `0038` 的独立库，不迁移或清空数据库。图片存储、真实 artifact 数据、多连接并发和完整确认路径未在这 7 项中验证。
- 最终 `pnpm.cmd lint` / `pnpm.cmd typecheck` 各 14/14 包通过；`pnpm.cmd exec turbo build --filter=@ecom-forge/worker...` 11/11 通过。复验命令沿用 17.9；本轮不把读取专项等同于完整 API/Worker integration、Redis/队列恢复或浏览器验收。
- 本轮消息绑定增量正反复审及复验通过；完整工作区最终代码审查、P1/P2 和用户验收仍未通过。下一依赖是确认/Skill/工具等其余宿主来源与资源绑定，然后统一锁顺序下原子捕获，再完成 P2 同历史读路径与压缩恢复。未重启服务、改验收库、调用收费 Provider、改 migration `0038`、提交或推送。

### 17.11 确认回答宿主绑定增量 (2026-09-08)

- API 确认 schema 与商品事实规范化复用 Agent 的共享契约，公开字段和限制不变。新增确认语义上下文及 Worker 来源/依赖绑定，保留完整回答，核对真实 answered confirmation、response continuation、问题 digest 和已确认 fact set；正常历史确认不因原 pending TTL 经过而失效。
- 所有 host context 在私有正文读取前必须有来源验证器。商品事实同时检查用户、源图片、商品及原 fact set，拒绝 owner/hash/状态漂移；不把新 fact version 当成对历史版本的覆盖。
- 实测：Agent 5 文件/250 项，Worker 32 文件/276 项；独立 PostgreSQL 读取专项 25 项（新增确认路径 9 项）通过。全仓 lint/typecheck/build 各 14/14 通过；完整 `pnpm.cmd check` 成功，test 阶段 24/24 tasks，API 58 文件/329 项通过，quality-gate smoke 通过。
- API 首次测试库缺少 transcript 字段且有原奖励数据，不改原库；使用正常迁移的新独立测试库后复验。构建并行时出现一次既有 5s timeout，未放宽 timeout，单文件及随后全仓检查均通过。验收库未迁移，未重启服务或调用收费 Provider。
- 以上只证明确认绑定和旧行为回归；尚未接通生产捕获/Processor/Brain。Skill/工具绑定、原子捕获、生命周期/导入、P2 投影/压缩/恢复、完整审查和用户验收仍未完成。

### 17.12 核心 Skill 与知识工具绑定增量 (2026-09-08)

- 核心 Skill 上下文按真实 turn selection 保存 primary、所选 Preset、required auxiliary 的有序资源引用，不预载 optional/L2，不把正文复制进 transcript。内置历史知识严格匹配来源 turn 的版本、定义、资源身份和 hash，禁止按 slug 偷换新正文或外部 fallback；其他 Skill 导致的 catalog 更新不单独撤销未变内容。按 `02` 11.1A，已结束 turn 的旧内置引用经同用户、同会话 selection/hash 证明后可继续作为历史证据；已更新正文不再物化，新 turn 使用当前知识，不因旧版本引用阻断。直接读取正文仍要求当前资源精确匹配。外部旧 published/retired release 核验 manifest、原报告和资源闭包，支持真实 rollback digest，并以数据库时间检查风险复审到期。
- Skill 正文只在来源和 live 元数据授权后物化，读取后复验 hash、权限和会话 generation/revision；源正文缺失、版本漂移、读取中撤销/归档均拒绝。`skill_package_resources.skill_id=null` 沿用已有合法语义，非 null 时必须匹配；不靠放宽资源归属解决历史读取。
- `inspect_image@1/load_skill@1` 参数复用原执行 schema；整批参数先验证。结果必须对应原 binding/detail 或 Skill/view/有序 paths，并继承父调用及结果资源依赖。repository 在任何私有结果物化之前强制调用配对验证器。未执行/拒绝/未知结果保留独立状态，不伪造成功。这里只完成准备/配对和受控读取，不证明模型输入来源已完整，也未调用真实工具或切换执行路径。
- 复审与修正：合法结果复验曾误带 `payload_digest` 等非输入元数据，已用严格元数据投影修复；共享协议层补齐 result continuation 不得早于父调用的条件，普通工具和 terminal 的反例先复现失败，再修复；不影响同 continuation 或后续恢复 continuation。
- PostgreSQL 读取专项当前 47 项通过，其中 6 项是实际工具配对读取，之前 41 项覆盖 owned read、消息、确认、核心 Skill 和授权/正文竞态。工具夹具显式绑定一个已验证的原输入项，不冒充生产模型输入依赖继承器。所有读取夹具事务回滚；沿用已安装 `0038` 的独立库，没有迁移或清空数据库。

### 17.13 Owned 写事务入口增量 (2026-09-08)

- 新增独立 Worker `AgentTranscriptWriteTransactions`，仅接收已经 claim 的 native turn，先锁 session 再锁 turn；核验归属、strict shadow/active checkpoint、generation、capture version、owner/revision/continuation、运行状态和数据库时钟下的租约，回调后再次检查原租约。它还未接入 Processor，也不供资金结算或跨 turn 回调使用。
- 默认锁等待 1s、总事务 5s。每条 SQL 继承数据库剩余总预算；宿主为回滚预留最多 50ms。SQL 失败、并发 query、超时或结束后的 scope 一律失效，吞掉 query 异常不能提交前面写入。原型的空闲超时反例暴露“数据库先断开、宿主回滚/连接回收等待”的竞态，已修正正常超时的回滚顺序并复验，未提升超时或弱化回滚断言。
- PostgreSQL 写事务专项 32 项通过，验证两种 mode、bigint、正反归属、旧 owner、过期 lease、回调回滚、真正多连接的锁顺序/串行计数/锁超时、SQL/空闲/累计时间超限和 scope 失效。序号、revision 和消息写入是回调夹具，不是完整 transcript append。连接回收正常结束。
- 写事务测试需要提交精确 UUID 标记的合成夹具供独立连接观察；夹具保留在隔离测试库，不清空现有数据。库必须预先安装 `0038`。复验命令：在测试进程设置隔离 `TEST_DATABASE_URL` 后，执行 `pnpm.cmd --filter @ecom-forge/worker exec vitest run --config vitest.integration.config.ts test/s08-transcript-write.integration-spec.ts`。
- 此增量不证明完整批次/payload 幂等、消息/trace/outbox/usage 原子捕获、真实连接丢失恢复、涉及资金的全局锁顺序或性能预算已通过。全仓最终复验和完整扩展审查仍按 17.5 执行；不能将本组件称为 P1 完成。

### 17.14 当前交付批次

三阶段 P1/P2/P3 不变。以下八批仅是本次 P1 + P2 串行实施的进度视图，不增加并行产能；后续批次的局部预备代码不代表越过前置门禁。

| 批次 | 内容                                                          | 当前状态                                                                                                                  |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1    | 契约细化与正反设计复审                                        | 已完成；实现证据可重新打开问题                                                                                            |
| 2    | schema/migration、private payload、item/协议基础              | 已完成并有隔离验证（migration `0038`；测试库迁移由自备库入口保证，不再依赖手工状态）                                      |
| 3    | 宿主来源、授权读取与资源依赖闭包                              | 已完成（消息/确认/核心 Skill/知识工具、模型/terminal 来源与输入依赖闭包均有真实 PG 专项）                                 |
| 4    | 统一锁顺序、幂等批次与原子捕获                                | 已完成（append/payload 幂等、usage/消息/trace/outbox 原子捕获、全链路接入 Processor）                                     |
| 5    | 生命周期、readiness 与 P1 完整性/性能门禁（旧数据导入取消）   | 已完成；完整性门禁通过。**性能门禁为已知限制**：实测超 +20ms 预算，经 2026-09-11 用户裁决接受、本批不阻塞，待办见 docs/09 |
| 6    | P2 同历史 planning/authoring/tools、稳定前缀与 native adapter | 已完成（切读收口、恒定工具前缀、非法批次有界反馈、原生 adapter）                                                          |
| 7    | summary v2、有界窗口与新流程 pending operation 恢复           | 已完成（summary v2/CAS/有界窗口、恢复三窗口；旧格式兼容排空取消维持）                                                     |
| 8    | 全矩阵复验、完整 diff 正反审查、稳定栈与用户实测              | 复验与正反审查已完成（主审 + 用户独立复审复现全部数字）；等待用户验收与用户实测                                           |

当前全部 12 项交付中 11 项完成，1 项（P1 延迟预算）经用户裁决接受为已知限制。验收对象仍是完整 P1 + P2；P3 response chaining、厂商缓存参数与 Todo 不在本次范围。旧会话清理与 P2 独立测量口径为后续独立事项。

### 17.15 原生投影与窗口边界修复 (2026-09-10)

- Provider 原生消息映射保留当前 user 的原位置且只注入一次；内部版本化工具名映射到注册的 wire 名称，candidate plan 去除宿主 envelope。call/result 按调用顺序相邻输出，夹在批次内的 host/user 事件保留相对顺序延后；拒绝重复、孤立或未闭合调用，`rejected/unknown/not_executed` 不编码为成功。三种协议均以 mock fetch 验证真实 SDK 请求，无收费 Provider 调用。
- Worker 当前窗口读取补齐空窗口的输入、generation、闭合边界和末尾 fence；非空窗口也复查首次读到的尾部，避免两次读取间新增结果被漏掉。分页单测验证 200 项以上的 keyset 游标、完整重授权、重复页和缺页失败；没有扩大读取预算。
- native turn 在每次迭代均禁止进入旧 chat-message summary v1 路径。这只是隔离旧摘要，不是 summary v2 完成；当前硬上限失败逻辑保留。修复事实依赖单测夹具缺少版本及源图片字段的问题，未弱化校验。
- 本轮单测：Worker 39 文件 / 518 项、Provider 12 文件 / 179 项、Agent 5 文件 / 282 项通过；全仓 lint 14/14、typecheck 14/14 通过，`git diff --check` 通过。
- PostgreSQL 读取专项命令在测试初始化时因未显式提供隔离 `TEST_DATABASE_URL` 停止，未执行测试；本环境 Docker daemon 不可连接。未运行完整 API/Worker integration、迁移/build/性能和浏览器门禁，未启动或重启 API/Worker，未提交。
- 尚未达到完整 P1 + P2 交付：稳定工具 schema、transcript pending operation 恢复、summary v2/CAS/窗口规划、生命周期/readiness/metrics 和专项验证入口仍有缺口；完整工作区最终代码审查及用户验收未通过。旧会话不做回填、转换、双执行或恢复，后续清理独立进行。

### 17.16 完成交付与用户裁决 (2026-09-11)

> **状态注记（2026-09-13）**：本节记录 2026-09-11 时点的交付与裁决事实。此后工作区仍有未复验改动（套件增删、provider/worker 逻辑调整），因此本节中的 `validate:*` 通过结论、集成项数与“未发现阻塞缺陷”表述**不描述当前门禁状态**；当前结论以 `docs/research/06-p1-p2-code-review-status.md` 为准。

- 本增量完成批次 4-7 的收尾与批次 8 的复验：summary v2/CAS/有界窗口、恒定工具前缀与非法批次有界反馈（`recordIllegalToolBatch`，混排不再整回合失败，和普通结构错误共享三次修复上限）、生命周期/读门禁、readiness 版本枚举、统一 `agent_transcript_metric`；专项验收入口与 `test:integration`、api `test` 均改为零配置自备库（稳定命名复用、只前向迁移、绝不自动删库）。
- 门禁实测：`typecheck --force` 14/14、lint 14/14、format 全过、`pnpm check` 五段 24/24（含 api 58 文件/329 项）、worker 集成 18 文件/321 项（真实 PG）、db 8 文件/169 项、两条 `validate:*` 通过、`pnpm build` 14/14。完整 diff 正反审查通过（主审报告 + 用户独立复审复现全部数字），未发现阻塞缺陷。
- **P1 延迟预算（用户裁决 2026-09-11）**：裁决级测量（同机隔离库、1000 预热样本/路径）Δp95 = 23.87 / 76.81 / 143.95 ms（并发 1/4/8），超出 docs/09 的 +20ms 预算。用户裁决：**接受为已知限制，本批不阻塞**；已完成的切读保留、不回退。待办已记入 docs/09：下次文档复审把预算调整为分层口径（区分无竞争单步与同会话并发串行场景）并说明 session 行锁串行化（05 规定的锁顺序，正确性优先）的原因。
- 用户独立复审提出并已修复两个非阻塞观察项：db 迁移测试并发超时抖动（显式 `{ timeout: 180_000 }`）；api 测试依赖机器库状态（s03 播种前退役遗留 active 奖励活动 + api `test` 改自备库入口）。
- 未完成/不在范围：用户验收与用户实测（等待用户）；旧会话清理（已取消兼容，独立后续）；P3 response chaining、厂商缓存参数与 Todo；P2 独立测量口径；写事务内 metric 发射、Processor 体积与 transcript 模块碎片化三项维护项（记录于审查报告，另行处理）。

## Agent 与媒体滥用防护

- Agent 正文最多 2,000 个字符，附件最多 9 个；API schema 是最终边界，超限请求不得创建 turn、入队或调用模型。
- Agent 创建请求按用户和可信客户端 IP 使用 Redis 原子窗口限流；幂等重放在命中已存响应后直接返回，不重复计入异常尝试。
- 余额为 `0` 时，Agent API 在写入 turn、trace、message 和 queue intent 前拒绝；账户查询、历史会话、资产和作品读取仍可用。
- 同一用户在 10 分钟内产生 10 次以上独立零余额 Agent 提交，服务端事务性设置 `users.risk_status=frozen`、递增 `risk_revision` 并撤销普通认证 session。管理员通过既有风控接口解锁。
- frozen 用户的 Agent、积分、任务、SSE、资产、作品和模型目录接口拒绝；已签发的图片 capability 在读取或上传时仍重新检查用户风险状态。
- 图片上传、预览和下载按 capability 所属用户与可信客户端 IP 双重限流；请求体仍受图片字节上限约束。生产部署还应在反向代理配置请求速率和连接数上限。
