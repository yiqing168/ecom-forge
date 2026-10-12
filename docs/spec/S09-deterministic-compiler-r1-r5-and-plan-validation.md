# S09 确定性编译器、R1-R5 与计划校验

| 项     | 内容                                                               |
| ------ | ------------------------------------------------------------------ |
| 状态   | v0.6 1A generate_action@v2、Brain 张数与无费用卡路径回写后待复审   |
| 阶段   | 1A / D3                                                            |
| 优先级 | P0                                                                 |
| 目标   | 实现计划编译器，裁决引用权限、R1-R5、DAG、费用、模型准入和错误反馈 |

## 1. 开工前必读

- `docs/01-architecture-and-transaction-contract.md`
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/spec/S04-credit-ledger-quote-and-transaction.md`
- `docs/spec/S08-agent-turn-skill-runtime-and-loop-guard.md`

## 2. 范围与不变量

本轮包含：

- 不可信候选计划的 strict schema、canonicalization 和结构化拒绝。
- 服务端引用 binding 的所有权、读取权和修改权复核；本轮只交付 Compiler 的 binding/R1-R5 内核。
- R1-R5、DAG、capability、模型准入、Skill/version drift 和费用校验。
- 确定性 task、依赖、幂等键、计划/Skill/模型/pricing/policy 快照。
- S08 `candidate_plan` 接入 Compiler，成功后原子创建 quote 并关联 turn。
- 编译器 trace、公开错误映射和恶意计划/并发反例。
- Web Agent API client 只提交用户消息、附件、Skill/模型选择和不含数量的 generation preferences；API 从已鉴权幂等生成动作派生 `generate_action@v2` evidence。Web 不发送费用模式、金额上限或前端解析的图片数量。

本轮不包含：

- LLM 创意判断、Prompt 编写、Provider 调用、资产上传和产物发布。
- S12/S13A/S13B 的具体图片生成/编辑参数与正式 capability 注册。
- canvas/suite/batch 的公网编译入口；这些入口后续复用同一内核并回写自己的 source adapter。
- 真实 Provider/Agent Brain 的模型审批管理 UI；归 S14。
- S10 之前的真实资产、artifact、商品事实 binding 构造与公网激活；S10 负责建立 binding source，届时复用本轮 Compiler R1-R5 内核并补真实 DB binding 集成测试。

固定不变量：

1. Candidate plan 是不可信建议，不是权限、价格、模型或执行真相。
2. Compiler 是纯确定性边界：相同 candidate + context 得到相同 canonical result；不读环境变量、不访问网络、不写数据库。
3. 编译成功不产生副作用，只返回可报价 draft；只有 API/Worker application service 能在短事务中创建 quote、更新 turn、写 trace/outbox。
4. 编译失败不得创建或保留 quote/reservation/workflow/task/queue intent。
5. Compiler 不静默改变审美目标、数量、比例、引用对象、修改目标或 capability；只能规范化格式和生成服务端 ID/hash。
6. 任何 decimal 费用计算只使用 `packages/shared` 金额工具；不得使用 `number` 算术估价。

## 3. 模块边界

| 模块                  | 责任                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------- |
| `packages/compiler`   | schema、DAG、R1-R5、binding、capability、模型与费用纯校验；输出判别联合                |
| `packages/provider`   | 版本化 capability/model/pricing schema 与成本公式                                      |
| `apps/worker`         | 构造 compiler context、以 owner/revision CAS 落库；消费自动提交 intent 时只委派 Credit |
| `apps/api`            | turn 创建授权、显式 quote submit 与公开错误投影；不信任客户端 candidate/plan snapshot  |
| `apps/web`            | 缓存 catalog+policy 整体并发送 strict 授权；S11 前不静默开启 auto submit               |
| `packages/credit`     | 共享 quote submit application function、账本、冻结和结算唯一写入口；Compiler 不写资金  |
| S12/S13A/S13B adapter | 注册具体 `image.generate`/`image.edit` candidate 参数 schema 和 task 参数编译器        |

Compiler capability registry 由代码静态装配且带版本。Skill 的 `required_capabilities` 只能用于一致性检查，不能注册 capability、扩大工具权限或指定模型。未知 capability/version 必须 fail closed。

S13B 前向增加独立的 immutable `skill_execution_profile` registry。它不扩大 Candidate schema：Brain 仍只能提出已注册的图片 candidate；服务端在 preflight 前按 turn 的精确 Skill snapshot 解析 profile，执行 profile 必需的 inspection 并把 receipt/digest 放入 Compiler context。Compiler 校验 receipt 后，才可按 profile 确定性展开 moderation、固定多节点和内部媒体处理 task；这些节点、依赖、成本、operation key 和 profile digest 全部进入 plan/quote/task snapshot。Brain/Skill 不能请求、删除或改写内部节点，Compiler 也不能用 profile 把用户目标改成另一个 Skill。

## 4. Candidate Plan 契约

S08 `candidate_plan.plan` 必须先解析为以下 v1 判别结构：

```json
{
  "schema_version": 1,
  "intent": {
    "kind": "creative_generate | commerce_generate | chat_artifact_edit | external_artifact_edit | raw_asset_generate",
    "confidence": 0.0
  },
  "skill_id": "exact-slug@1.2.3",
  "source": "chat",
  "nodes": [
    {
      "candidate_key": "generate-1",
      "capability": "image.generate",
      "capability_version": 1,
      "depends_on": [],
      "input_bindings": ["binding-1"],
      "params": {},
      "expected_output": "image"
    }
  ]
}
```

约束：

- 顶层和节点均为 strict object；未知字段拒绝。最大 32 个节点。
- `confidence` 是 0 到 1 的 JSON number，与 `02 §3/§5` 一致；只用于阈值比较，不参与金额运算。`<0.85` 一律返回澄清，不进入费用链路。
- `skill_id` 必须与 turn 固定的 primary 精确 ID 完全一致；不得使用 `latest`、版本范围或另一个 primary。
- S09 只激活 `source=chat`。`user_id/session_id/provider/model/price/permission/storage_key/url/header/prompt` 等字段不属于 candidate schema，出现即拒绝。
- `candidate_key` 只在本候选计划内定位，格式为小写 ASCII slug，1-64 字符且唯一；编译后 task key 由 canonical plan + candidate key 确定性生成。
- `depends_on` 只引用同计划 `candidate_key`，不可重复、自引用或悬空；所有节点必须从零入度节点可达。
- `input_bindings` 只允许引用本次 compiler context 中由服务端发放的 opaque binding key。模型不得直接提交数据库 ID 或以自然语言序号替代 binding。
- `params` 先过 capability registry 的 strict schema，再由该 capability 的纯 adapter 编译为 params snapshot；Compiler 不透传任意 JSON。
- 图片 capability 的 `params` 必须由 Brain 输出正整数 `output_count` 和 `output_count_source=user_explicit|skill_default`。前端 `generation_preferences` 不携带数量；primary Skill definition 必须提供 1-16 的版本化 `default_output_count`（省略时规范化为 1），并固化到 selection snapshot 与 Compiler context。Runtime 把该快照值传给 Brain，未明确数量时 Brain 原样复制，不得猜测；Compiler 以候选数量、同一快照默认值、模型规格和平台单 turn 上限做确定性校验，不能依赖按 slug 维护的旁路表、前端正则结果或静默改小数量。升级前 legacy snapshot 缺少该字段时，只能从已校验的 primary planning resource 按同一 schema 恢复一次并冻结为该次执行的 Brain/Compiler 共用值，不得重写持久化 snapshot/hash。
- 图片比例只有两条合法路径：用户提交具体 `W:H` 时 candidate 必须省略节点比例或与其完全一致，Compiler 不得静默改写；用户提交 `auto` 时每个图片 candidate 必须携带一个具体 `W:H`，Compiler 以所选 immutable model spec 重验并冻结到 task。缺失、冲突、不支持或把 `auto` 写入 candidate 均拒绝，Provider payload 不允许出现 `auto`。
- `expected_output` 必须属于 capability contract 的允许输出类型，不能用自由字符串建立隐式依赖。

Candidate plan 不包含 Provider/model。模型选择来自用户在 S11 UI 中提交的 S14 产品化 `model_selection_snapshot`；LLM 不能通过 candidate plan 选择、替换或降级模型。服务端在构造 compile context 时把用户选择的 catalog entry/version 解析为唯一 immutable model snapshot、capability、Provider rate card 与 billable SKU closure，再由 Compiler 确定性复核 capability、输入数量/类型、比例/分辨率、stage、审批状态、熔断与预算。任何缺失、漂移、不可用或规格无价都 fail closed，不自动从候选集换模。

## 5. Compiler Context 契约

Application service 从当前数据库真相构造 context，最少包含：

```text
actor: user_id + session_id + turn_id
skill: selection snapshot + definition/package/release digest + required capabilities
execution_authorization: server-derived generate_action + create_request_hash + policy_version + digest
bindings[]:
  binding_key + kind + object_id + object_version/content_hash
  owner_user_id + readable + mutable
  artifact producer_mode/producer_session_id/mutation_owner/source_action
  media_type + lifecycle/visibility
models[]:
  immutable model row ID + provider/model/version/status/evidence digest
  capability/pricing/quota snapshot
model_selection:
  catalog revision + selected product entry/version per category
  resolved model snapshot + billing SKU closure
policies:
  compiler version + capability registry version
  pricing rules + content safety policy + platform policy versions
  quote TTL + cost confirmation threshold
```

规则：

- context 在 Worker 事务外准备时可以读取 DB，但正式 compile 前必须重新读取关键 Skill、model 状态；真实 asset/artifact binding 在 S10 binding source 交付前保持空集合，候选引用按 `AGENT_CONTEXT_UNAVAILABLE` fail closed，不得临时猜测 attachment 语义。
- 所有查询显式带 `user_id`/session 边界。无法证明 readable/mutable 时按 false 处理。
- 软删除、quarantined、缺 hash/version、跨用户或未知类型 binding 不进入 context；若 candidate 引用则结构化拒绝。
- model 只有 `poc_passed` 可进入可收费计划。`free_test_only` 仅允许 test/local 的显式 fake capability adapter，不能进入 staging/beta/production quote。
- disabled/poc_failed、能力不匹配、价格未知、熔断或 S14 路由未激活时不得 fallback 到任意模型。`models` 表的全量审批记录不是路由候选集；Compiler 只接受当前发布 catalog closure 已解析出的 immutable model row ID、SKU version 和 catalog revision。S14 前生产候选集固定为空，S09 隔离测试只能显式注入自己的测试 model selection/context。
- Compiler context 不包含 Provider Key、endpoint、签名 URL、完整 Prompt、Skill 私有正文或二进制。

## 6. 引用与 R1-R5 裁决

| 场景                                  | 读取 | 修改 | Compiler 结果                                |
| ------------------------------------- | ---- | ---- | -------------------------------------------- |
| 当前用户原始 asset/upload             | 是   | 否   | 可作为新生成输入，不继承任何 artifact 修改权 |
| 当前 session 的 chat artifact         | 是   | 是   | `chat_artifact_edit` 可编译                  |
| 当前用户其他 session 的 chat artifact | 是   | 否   | 只可作新生成参考；edit 拒绝                  |
| canvas/suite artifact                 | 是   | 否   | 对话 edit 拒绝并返回 `open_canvas` 安全动作  |
| 其他用户或不可见/quarantined artifact | 否   | 否   | 统一引用不可用，不泄露对象是否存在           |

R1-R5 使用数据库 `producer_mode/producer_session_id/mutation_owner` 与 context actor 裁决，不读取 candidate 的 source 声明：

- `creative_generate/commerce_generate/raw_asset_generate` 只能读取有权 binding，产物 owner 由后续 workflow source 决定。
- `chat_artifact_edit` 必须恰好指定至少一个 mutable、`producer_mode=chat`、`producer_session_id=current session`、`mutation_owner=chat` 的 artifact。
- `external_artifact_edit` 在 1A 对话入口不编译执行；根据真实 producer 返回 `open_canvas` 或 `start_new_generation`。
- candidate 声称 generate 但 capability/params 实际修改既有 artifact 时，按 edit 规则裁决，不能用命名绕过。
- 一个节点不得把没有直接/传递依赖关系的前序输出当输入；输出依赖由 DAG 明确表示。

## 7. DAG 与确定性规范化

编译顺序固定：

1. parse strict candidate。
2. 校验 confidence、source、Skill identity 和 capability registry。
3. 解析所有 binding，执行 ownership/R1-R5。
4. 校验节点 key、依赖、环、悬空引用、可达性、输入/输出类型。
5. 按 `(dependency depth, candidate_key)` 稳定拓扑排序；同层排序不改变业务依赖。
6. capability adapter 规范化参数并生成 task params snapshot。
7. 解析并复核用户已选 catalog entry/version 对应的 model snapshot、SKU closure、能力/配额/熔断门禁；不得改变选择。
8. 计算逐 task 费用和总费用，生成 Agent quote 与自动积分核对语义。
9. 生成 canonical plan、snapshot digest、input signature 和 task operation key。

稳定字段：

- `task_key = sha256(compiler_version + canonical_plan_digest + candidate_key)` 的小写 hex。
- `operation_key` 包含 turn ID、continuation、canonical plan digest 和 task key；不使用模型 call ID。
- 数组默认保持业务顺序；只有 schema 声明为集合的 capability/版本清单排序去重。
- UUID 只接受规范小写形式；decimal 规范化为字符串；对象 key 按 canonical JSON 排序。
- 相同 input/context 重编译必须 byte-equivalent；context 中任一 binding/model/Skill/policy 版本变化必须改变 input signature。

## 8. 模型、费用与快照

每个 task 只使用用户选择并由 active catalog closure 解析出的一个不可变 model row，并校验：

- model catalog revision、entry ID/version 与 turn selection snapshot 完全一致。
- `status=poc_passed` 且 evidence digest 存在。
- capability、比例、分辨率、输出数量、参考图数量全部满足。
- pricing/quota strict schema 通过；对应 billable SKU matcher 唯一且成本不存在未知项。
- model/provider circuit 与预算门禁允许新 submit。

费用使用 `03 §6/§6.1` 的统一公式和 `packages/shared` decimal helper。每个 task 至少输出：

```text
provider_unit_cost_cny（可选内部观测；无真实来源时为 null）
tool/storage/traffic/agent allocation（可选内部观测；无真实来源时为 null）
risk_adjusted_cost_cny（仅在全部真实成本输入可用时计算，否则为 null）
billable_sku_id + version + credits_per_unit
estimated_credits（唯一用户报价来源）
pricing_snapshot_digest
```

用户总费用是 billable SKU task line item 的 decimal 求和；Provider 成本永远不能替代用户积分售价。任一 task 缺少唯一 billable SKU 或公开积分未知则整份 compile 拒绝 `cost_unavailable`。内部 Provider 成本未知时保持 null，不按 0 处理，但不阻止已有公开积分 SKU 的编译和冻结。

1A Agent quote 固定走 `auto_submit`：用户点击“生成/继续改并生成”创建的幂等请求由 API 写成服务端派生 `generate_action@v2` evidence，绑定 create request hash、Skill/模型/偏好快照和 policy version，但不含用户设置的金额或积分上限。Brain 解析张数后，Compiler 生成 quote；Credit application 在同一 quote 上校验 turn、plan、authorization digest、余额和并发，并原子创建 reservation + workflow。图片 Provider 只能消费已存在有效 reservation 的 workflow task。

必要澄清、商品事实或风险确认必须在 candidate plan/quote 前完成；它们不转成费用确认。余额不足、价格未知、catalog/pricing 漂移、数量越界或并发限制均停在 Provider 调用前，转成安全的就地阻断状态；不得创建费用卡、让用户设置当次积分上限，或为了通过积分核对删 task、降数量、换模型、降规格、把差额归零。

成功快照至少包含：

- compiler/capability registry version 与 plan digest。
- canonical task、依赖、operation key、输入 binding ID+version/hash。
- 若候选包含 `scope_decision`，原样保留在 canonical plan 并参与 plan digest；范围、张数或决策结论变化须产生不同 digest，旧无声明计划保持兼容。
- primary/Preset/实际辅助 Skill 及 package/release/definition/resource digest。
- catalog revision、用户选择的 product entry/version、model row ID、Provider/model/version、capability/pricing/quota/evidence digest。
- 每个 task 精确 billable SKU ID/version、matcher hash、unit rule、credits per unit 和完整 pricing release digest。
- Prompt template version 和仅可审计的 prompt digest/安全摘要，不保存完整 Prompt。
- product fact/platform/content safety/pricing policy version；不适用时显式 null。
- 每 task 与总费用、生成动作证据和 quote expiry。

## 9. 输出与错误契约

`compilePlan` 返回判别联合，不以异常表达预期业务拒绝：

```text
compiled:
  canonical_plan + plan_digest + input_signature
  quote_draft(items/total/expiry/submission_mode)
  skill/model/pricing/policy snapshots

rejected:
  code + category + retryable + safe_action + details[]
```

内部拒绝码：

| code                       | category      | safe_action             |
| -------------------------- | ------------- | ----------------------- |
| `candidate_schema_invalid` | repairable    | `repair_plan`           |
| `clarification_required`   | clarification | `ask_user`              |
| `skill_version_drift`      | unavailable   | `refresh_skill`         |
| `reference_unavailable`    | permission    | `remove_reference`      |
| `mutation_forbidden`       | permission    | `open_canvas/start_new` |
| `dag_invalid`              | repairable    | `repair_plan`           |
| `capability_unavailable`   | unavailable   | `explain_unavailable`   |
| `model_not_approved`       | unavailable   | `retry_later`           |
| `cost_unavailable`         | unavailable   | `retry_later`           |
| `policy_version_drift`     | unavailable   | `retry_later`           |

`details` 只含 candidate key、binding key、规则 ID 和允许的公开字段，不含对象是否属于他人、Provider 原文、价格内部参数、完整 params/prompt 或 DB 行。

公网统一映射：

- 可澄清问题进入 `confirmation_type=clarification`，不结束为系统错误。
- R1-R5 拒绝返回可读边界卡；跨用户/不可见对象统一 `REFERENCE_NOT_AVAILABLE`。
- 暂时性 model/cost/policy 不可用统一安全摘要，不暴露具体 Provider。
- schema/DAG 最多允许 Agent 在剩余预算内 repair 2 次；相同 plan digest + code 连续出现计入 S08 repeated-error/no-progress guard。

S09 不为 1A Agent 新增 `cost@v1` confirmation，不写 cost confirmation snapshot，也不把余额不足或并发限制伪装成 `waiting_user_confirmation`。公开 turn/workflow 快照只投影预计积分、实际积分和安全阻断原因；不含 Provider、内部 CNY 成本、margin、Prompt、完整 task params 或 SKU 内部字段。刷新、SSE gap 或 watchdog 恢复只能重建同一 turn/quote/workflow 状态，不能重新 POST turn、重新创建 quote 或调用 Provider。

## 10. Agent 与交易接线时序

```text
Brain candidate_plan
  -> LLM usage/cost 先按 S08 settle
  -> Worker 读取当前 DB 真相构造 CompilerContext
  -> 纯 compilePlan（无 I/O）
  -> rejected: 同一事务写 compiler_check trace + clarification/block/outbox
  -> compiled: 单一短事务
       lock turn owner/revision
       复核尚无 run_quote/workflow
       创建 run_quote（完整快照）
       写 compiler_check trace
       turn -> run_quote_created，关联 run_quote_id，清 processing lease
       所有路径创建延迟 `agent.quote.expire` intent
       创建唯一 `agent.quote.submit` intent，只写 status outbox
  -> 事务外 publish SSE wake
  -> intent Consumer 调用 Credit submit application service
  -> S04 单一事务 freeze + workflow/tasks/intents + quote/turn/workflow 关联 + outbox
```

并发与恢复：

- 编译开始前后的所有写使用 `turn_id + processing_owner + revision + continuation_no` 锁/CAS。
- 同一 continuation 并发 duplicate candidate 只能创建一个 active quote；失败者重读并按相同 plan digest 幂等返回，digest 不同则 fail closed。
- 崩溃发生在纯 compile 后、事务前时没有副作用，可安全重编译；事务提交后、wake 前崩溃时通过 DB/outbox 恢复，不得再创建 quote。
- quote 创建与 turn/trace/outbox 必须同事务。不得先创建 quote 再异步关联 turn。
- 自动提交 intent 与 quote/turn/compiler trace/outbox 同事务创建。Consumer 只带持久化 ID/digest 回查，不接收金额、task 或授权正文；稳定幂等键由 `turn_id + continuation_no + plan_digest + authorization_digest` 派生。
- S04 submit 事务主体必须下沉为 `packages/credit` 的共享 application function，Worker 通过 transaction-aware queue/outbox port 调用；Worker 不得 import `apps/api`、发内部 HTTP 或复制资金逻辑。1A Agent 只接受服务端 `generate_action@v2` evidence，不接受客户端 `cost_confirmation` 或金额上限。对 Agent quote，事务锁序固定为 account -> turn -> quote（与 turn supersede 的 turn -> quote 同序），复核 user/quote/plan/authorization/continuation 后原子写 reservation/workflow/tasks/intents、quote submitted、turn workflow ID/状态与双方 outbox；失败全部回滚。
- 自动提交 Consumer 在提交前崩溃可重放；事务提交后崩溃重放返回原 workflow。Redis 全丢只从 live intent 重建，不从 quote 金额反推授权。SSE wake 失败不改变提交真相。
- 每个 Agent quote 同事务创建 `agent.quote.expire` 延迟 intent。到期 Consumer 与 submit 使用相同 turn -> quote 顺序竞争：submit 先赢则 expiry no-op；expiry 先赢则 quote/turn/trace/outbox 原子收敛，后续 submit 返回过期。不得依赖页面打开或 GET 懒清理。
- 自动提交的余额不足不是网络重试：取消未提交 quote，将 turn 收敛为带固定公开 reason 的 blocked/failed 状态并保留用户草稿；不转 `waiting_user_confirmation`，不创建 cost action card。价格未知、目录/计价漂移和单次计划数量越界同样在 Provider 前阻断；用户已有活动 workflow 时新任务正常入队；基础设施暂时故障才有界退避。
- 新 turn/supersede/interrupt 沿用 S08 对未提交 quote 的取消规则；已提交 workflow 不受新 turn 静默取消。

## 11. 测试与验证

`packages/compiler` 表驱动单测必须覆盖：

- strict schema、未知字段、越界数量/confidence、candidate key 冲突。
- DAG 正常、多入口、环、自环、悬空依赖、不可达和输入/输出不匹配。
- R1-R5 全矩阵：当前会话可改、跨会话拒绝、canvas/suite 拒绝、asset 只作输入、跨用户统一不可用。
- candidate 伪造 source/owner/model/provider/price/permission 不能通过。
- Skill/version、capability、模型审批、能力上限、未知价格和 policy drift。
- canonical 输出与 input signature 确定性；输入、模型、Skill 或 policy 版本变化会改变 digest。
- decimal 费用逐项和总额；不允许浮点近似或未知价格归零。

真实 DB/Redis 集成测试必须覆盖：

- 恶意 Brain candidate 无法绕过 ownership/R1-R5，且 quote/reservation/workflow 数量不增加。
- 同一 turn 两个并发 compile 恰好一个 quote、一个 compiler trace、一个 quote outbox。
- 编译失败原子回滚；成功时 quote/turn/trace/outbox 同时可见。
- 编译后崩溃重放不新增 quote；不同 digest 竞争 fail closed。
- model/Skill 在 Brain 输出后发生版本或状态变化时拒绝；真实 binding drift/ownership 集成测试随 S10 binding source 交付，Compiler 包内 R1-R5 全矩阵已由纯函数测试覆盖。
- quote 提交后 workflow/task 使用编译快照，不重新接受 candidate JSON。
- 并发自动 Consumer 对同一有效 `generate_action@v2` 恰好冻结一次并关联同一 workflow；余额不足、数量越界、价格未知或目录/计价漂移时不产生 reservation/workflow/Provider 调用，并收敛为固定公开阻断原因。
- 模拟自动提交在资金事务提交前/后崩溃：前者重放完成，后者重放原 workflow；任何时刻都不存在已冻结但 `agent_turn.workflow_run_id` 为空的提交结果。
- create turn 授权 policy version 失效、金额越界、同 key 不同授权均拒绝；Worker/Brain/Skill 无法提高授权。
- Web cache 必须把 catalog 与 execution policy 作为同一 `response_version` 更新；S11 前请求固定保守授权，不能因旧缓存或默认值开启 auto submit。
- 并发 submit/expiry 只能一个赢家；无人打开页面时 quote/turn 也按服务端 TTL 收敛。余额不足转 action card 后不后台重试，充值后显式 submit 可复用原 quote。

专项命令：

```bash
pnpm validate:compiler-r1-r5
pnpm validate:compiler-concurrency
pnpm validate:compiler-cost-snapshot
```

## 12. 验收清单

- [x] Candidate、context、result 均为 strict 版本化 schema，未知字段 fail closed。
- [x] R1-R5、引用权限、DAG、capability、模型与费用由服务端确定性终审。
- [x] Compiler 内核已覆盖 R1-R5；S10 前真实 asset/artifact binding source 保持关闭并 fail closed，S10 激活时必须补 binding 集成验收。
- [x] 编译器不硬编码产品 Skill，不允许 Skill/Brain 扩大 Tool 或 Provider 权限。
- [x] 成功快照可复现且不含密钥、URL、完整 Prompt 或二进制。
- [x] 失败不创建 quote/reservation/workflow/task/intent。
- [x] quote/turn/compiler trace/outbox 同事务，并发与崩溃重放恰好一次。
- [x] 1A 自动提交与其他入口的显式提交复用同一 S04 资金事务；`generate_action@v2` digest、余额/并发/价格校验和 turn/workflow 关联均有并发/崩溃反例。
- [x] 用户只看到可执行的澄清、边界或暂不可用提示，不看到内部计划和 Provider 原因。
- [x] 三个专项 validate、全仓 check/build 与真实集成测试通过。
