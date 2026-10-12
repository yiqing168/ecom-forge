# S07 Provider Gateway、PoC 与成本核算

| 项     | 内容                                                                                  |
| ------ | ------------------------------------------------------------------------------------- |
| 状态   | v0.4 Gateway/fake/恢复底座实现完成，待代码复审；真实 Provider 待 S14 管理台配置与审批 |
| 阶段   | 阶段 0 PoC spike + 1A / D2-D5 工程实现                                                |
| 优先级 | P0                                                                                    |
| 目标   | 实现可审计的 Provider Gateway、fake adapter、三态回执、回调/轮询、熔断与成本核算底座  |

## 1. 开工前必读与依赖

- `docs/01-architecture-and-transaction-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/spec/S04-credit-ledger-quote-and-transaction.md`
- `docs/spec/S05-workflow-queue-worker-and-event-outbox.md`
- `docs/spec/S06-sse-realtime-state-and-recovery.md`

S04 的 reservation/settlement、S05 的 task/attempt/queue intent、S06 的用户可见事件投影必须已完成。S07 不改变资金公式、产物权限或用户流程；Provider 结果只能通过既有状态 repository 和 `packages/credit` 进入终态。

真实 Provider 的厂商、精确模型版本、审核服务、Key、endpoint/region、账号资质和受控预算最终统一由 S14 独立管理台配置、审批、启停和审计，创作平台不得承载这些能力。S14 完成前可以实现和验收 Gateway/fake/恢复底座，但不得勾选真实 PoC、模型准入和成本定价。

当前 Gateway、fake adapter、三态回执、callback/poll、熔断/配额、模型控制 Service、迁移、成本报告和恢复验证已实现，进入代码复审。真实图片生成/编辑与文本/图片审核 PoC 等待 S14 管理台完成厂商/模型/Key/endpoint/region/预算配置及管理员审批；不以 fake 结果替代，也不激活公网收费路由。

## 2. 范围与分阶段激活

### 2.1 本轮包含

- `packages/provider` 的版本化 adapter 契约、model snapshot schema/准入检查、Gateway、三态错误分类、超时、配额和熔断端口；数据库 model 读取由应用 repository 完成。
- `FakeProviderAdapter`：成功、受理后轮询、确定未送达、发送结果未知、终态失败、重复/迟到回调、审核通过/拒绝/未知。
- Worker 的 Provider 投递和 polling processor；API 的 Provider webhook 验签、持久化和可恢复 callback intent。
- `task_attempts` 回执/轮询字段、`provider_callback_events`、`provider_circuit_states` 的前向 migration。
- `validate:provider-timeout`、`validate:cost-report`、真实 PostgreSQL/隔离 Redis 集成测试。
- 结构化指标和脱敏日志；模型控制领域 Service 为 S14 管理台复用。

### 2.2 本轮不包含

- 视频 Provider，归 S16。
- Agent 大脑调用循环，归 S08；S07 只冻结其复用 Gateway/成本/熔断的接口边界。
- 用户端生成 API、正式 plan 编译、R1-R5、商品事实和素材/产物下载，分别归 S09-S13B。
- 正式 artifact/object storage 写入和生成后图片展示。S10 交付资产/产物后才能激活公网收费生成；S07 的真实 PoC 输出只进入 Git 忽略的受控 PoC 目录。
- 管理前端。管理台与创作平台是独立应用，模型熔断/恢复、Key 轮换和成本看板 UI 归 `apps/admin` / S14；S07 不在 `apps/web` 增加管理页面。
- Provider Key 数据库管理和读取 API。S14 前由部署 secret 注入；不得为 S07 临时开放通用密钥 HTTP 接口。
- 图片生成、图片编辑、文本审核和图片审核的真实厂商 adapter、真实 PoC runner 与实际调用。它们在 S14 完成厂商/模型/Key/endpoint/region/预算配置和管理员审批后，按本 SPEC 第 11 节的激活契约交付；本轮 fake 验证不得替代真实 PoC 证据。

### 2.3 激活门禁

- `APP_ENV=test` 只允许 fake adapter，不允许网络。
- `APP_ENV=local` 默认 fake；S14 配置能力完成后的真实 PoC 必须由独立 `poc:*` 命令、显式确认变量、调用上限和 endpoint allowlist 启用。
- staging/beta 只能使用已通过 PoC 的不可变 model snapshot 和受控 secret；缺模型、密钥、region、预算或内容审核能力时启动/路由 fail closed。
- production 在 S14 Key 管理、S15 安全/部署门禁和真实成本审批前禁止激活收费 Provider route。
- S07 的 task processor 只在 test/local 的 fake 验证 workflow 中激活。S09 的编译/生成前审核和 S10 的 artifact/quarantine 链路完成前，staging/beta/production 的正式生成 processor 必须保持关闭；不得用 S07 PoC 结果绕过上游 plan、权限、费用或内容安全门禁。

## 3. 包与模块边界

`packages/provider` 只负责厂商协议归一、能力/参数校验、回执分类、成本单位和熔断决策，不访问业务数据库、不写任务状态、不写账本、不创建 artifact。

```text
packages/provider/
  contracts/        # adapter DTO、错误分类、三态、成本/审核结果 schema
  gateway/          # model snapshot 校验、adapter registry、timeout、quota、circuit
  adapters/fake/    # 确定性 fake
  adapters/<protocol-or-vendor> # 精确协议/厂商 adapter；禁止通用任意 URL adapter
  poc/              # 受控真实 PoC runner 的纯调用逻辑

apps/worker/
  processors/provider-dispatch.processor.ts
  processors/provider-callback.processor.ts
  processors/provider-poll.processor.ts
  provider/attempt-state.repository.ts
  provider/circuit-state.repository.ts

apps/api/
  modules/provider-webhook/ # raw body、验签、去重、callback event + queue intent
```

API/Worker 只通过 `@ecom-forge/provider` 调用 adapter。业务代码不得直接 import 厂商 SDK、拼 endpoint 或解析厂商原始状态。

## 4. Provider 能力与请求契约

2026-10-09 串行增量：按用户确认，OpenAI Images 生图和改图默认发送 `quality=high`。正面复审：两种传输复用一个 typed 默认值，参数不交给 Brain 或浏览器决定。反面复审：不承诺中转实际支持、不自动降低质量、不调整尺寸/计价或重试语义；真实成本和出图留待用户验收。回归分别断言 generations JSON 与 edits multipart 的实际 `quality` 字段，已有失败/未知回执测试继续通过。

同日尺寸增量：按 `03` 的总像素预算公式替换固定短边算法。正面复审：一个通用公式精确复现当前前端五种比例的 1K/2K/4K 尺寸，比例约分和共同步长避免独立宽高取整失真；Provider 请求与 Compiler 像素计费共享公式。反面复审：不复制尺寸表到业务代码，不为未开放超宽比例添加特殊分支，不隐式换模型、不迁移历史价格，不缩图绕过边长或宿主像素上限。回归覆盖十五种公开组合、等价比例、非线性档位缩放、非法输入、边长/面积拒绝、JSON/multipart 请求尺寸与实际像素计价；不自动调用付费 Provider。

S07 首批能力固定为：

```text
image.generate
image.edit
moderation.text
moderation.image
```

每次调用绑定数据库 `models.id` 及其不可变 `provider/model_id/version/capability_contract_json/pricing_json/quota_json` snapshot。Gateway 必须重新读取 model，并拒绝：

- model 不存在或 task 的 `model_id/model_version` 不匹配；
- status 不是 `poc_passed`；`free_test_only` 只允许显式 PoC，不得进入收费 workflow；
- 能力、比例、分辨率、参考图数量、数量或输入类型不在 capability contract；
- Provider/model circuit 为 open，或配额/并发不可验证；
- adapter registry 不含精确 `provider + model version`；
- input snapshot 含签名 URL、对象存储 secret、二进制或未授权引用。

Gateway 输入是已冻结、已授权的业务摘要和内部 asset reference，不接受任意 endpoint/header。channel 的 relay base URL 必须在服务端 allowlist 内、使用 HTTPS 并在写入时规范化；请求 path、header 和 body 仍由精确 adapter 固定。完整 prompt 只在 Worker 受控内存中传给 adapter，禁止进入队列、日志、错误、回执摘要或 PoC 报告。

adapter 必须实现其声明的最小接口：

```ts
submit(input, context): Promise<ProviderSubmitOutcome>
poll?(input, context): Promise<ProviderTerminalOutcome>
verifyWebhook?(rawBody, headers, context): Promise<VerifiedProviderCallback>
moderateText?(input, context): Promise<ModerationOutcome>
moderateImage?(input, context): Promise<ModerationOutcome>
```

`context` 至少包含 stable idempotency key、model snapshot、deadline、trace ID 和 AbortSignal；不得包含用户 session、Provider Key 明文或可序列化的完整数据库实体。Gateway 必须把调用方 AbortSignal 与服务端 deadline 合并后传给 adapter，adapter transport 必须把该 signal 继续传给 SDK/HTTP 请求。deadline 到达后 submit/poll 统一按 `outcome_unknown/provider_timeout` 收敛；Gateway 在 transport 确认中止或完成前不得提前释放并发配额，若 transport 违反取消契约而不收敛，只能依赖带 TTL 且绑定唯一 owner token 的配额租约 fail closed，不能把槽位立即复用给新 submit。租约释放必须校验 owner token；旧调用在租约过期后迟到结束，不得释放后来者持有的新槽位。

## 5. 投递三态与错误分类

### 5.1 submit outcome

`ProviderSubmitOutcome` 是严格判别联合：

| kind              | 必需字段                                                      | 本地裁决                                                    |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `not_dispatched`  | `error_code/retryable/request_digest`                         | `failed/not_dispatched`；最多创建 2 个后续 attempt          |
| `accepted`        | `provider_request_id/receipt_summary/accepted_at/poll_after?` | `accepted/accepted`，绝不自动重新 submit                    |
| `succeeded`       | accepted 字段 + `outputs/cost_summary/completed_at`           | 先记 accepted，再 CAS 为 `succeeded/accepted`               |
| `failed`          | `provider_request_id?/error_code/receipt_summary/failed_at`   | 有受理证据则 `failed/accepted`，否则必须归 `not_dispatched` |
| `outcome_unknown` | `provider_request_id?/error_code/request_digest/unknown_at`   | `outcome_unknown/outcome_unknown`，禁止自动重投             |

只有 adapter 能以可验证的“请求未离开本机”证据返回 `not_dispatched`。DNS/连接建立前失败可以属于未送达；请求体可能写出、读取超时、连接复位、响应无法解析或缺少必要 request ID 时一律 `outcome_unknown`，不得因没有 request ID 猜测未送达。

`not_dispatched` 自动重试最多 2 次，含首次投递最多 3 个 attempt。每次真实 submit 必须对应独立 `task_attempt`；原 attempt 先终态 `failed/not_dispatched`，再由数据库事务创建下一 attempt 和新的 `task.execute` intent。BullMQ `attempts` 不承担 Provider submit 重试。

### 5.2 统一错误码

adapter 只能返回稳定分类，不向业务层抛厂商原文：

```text
provider_auth_failed
provider_rate_limited
provider_quota_exhausted
provider_content_rejected
provider_request_invalid
provider_unavailable
provider_timeout
provider_response_invalid
provider_cancelled
provider_cost_unknown
provider_internal_error
```

`provider_auth_failed/quota_exhausted/response_invalid` 默认不可自动重试并计入熔断；`rate_limited/unavailable` 只有明确 `not_dispatched` 才可有界重试。错误摘要只允许 code、HTTP 状态族、厂商错误码 hash、request ID hint 和可枚举阶段，不保存原始消息、prompt、URL 或 headers。

### 5.3 attempt 状态推进

- submit 前 CAS `created/not_dispatched -> dispatching/not_dispatched`。
- `dispatching/not_dispatched` 可进入 `accepted/accepted`、`failed/not_dispatched` 或 `outcome_unknown/outcome_unknown`。
- accepted 后可进入 `polling/accepted`、`succeeded/accepted`、`failed/accepted`、`timeout/outcome_unknown` 或 `outcome_unknown/outcome_unknown`。
- Provider `cancelled`：若存在已确认的本地取消意图，attempt 归 `failed/accepted` 后由任务状态服务裁决 task cancelled；否则归 `failed/accepted` + `provider_cancelled`。
- 所有推进使用 DB CAS；attempt/task/outbox/callback event 的相关状态变化在同一短事务。事务内禁止 Provider、Redis、对象存储或 HTTP 调用。
- outcome_unknown 后收到成功/失败回执（含进入 unknown 后 30 分钟内），只记录 callback/poll 异常证据；原 attempt 不改写，不自动生成用户可见 artifact、结算或补扣用户积分。原未结算冻结从服务端 `ended_at` 起满 30 分钟自动释放，不等待人工核对；Provider 成本异常仅供平台内部对账。

S07 必须回写并实现 `04`/S05 的集中状态 repository，`ATTEMPT_TRANSITIONS` 至少新增 `dispatching/not_dispatched -> outcome_unknown/outcome_unknown`。对于仍为 `created/not_dispatched` 但已有独立持久化证据证明请求可能写出的异常恢复，允许 `created/not_dispatched -> outcome_unknown/outcome_unknown`；无该证据时 created 仍表示尚未调用 Provider。两条迁移都必须通过 repository CAS，不能由 Processor 裸写。

## 6. Polling 与 callback 队列

S07 激活 `provider-callback` 队列的两个 job type：

```json
{
  "schema_version": 1,
  "job_type": "provider.callback.process",
  "trace_id": "uuid",
  "provider_callback_event_id": "uuid",
  "processing_no": 1
}
```

```json
{
  "schema_version": 1,
  "job_type": "provider.poll",
  "trace_id": "uuid",
  "task_attempt_id": "uuid",
  "poll_no": 1
}
```

稳定 job ID 分别为 `compositeJobId(provider_callback_event_id,processing_no)` 和 `compositeJobId(task_attempt_id,poll_no)`；`aggregate_id` 分别存 callback event UUID 与 task attempt UUID。payload 只带持久化 ID/序号，不带 Provider request ID、签名、输出 URL、prompt 或回执正文。

polling 规则：

- accepted 后由服务端根据 `accepted_at + model snapshot.terminal_timeout_ms` 计算不可变 deadline，并按 snapshot 的 `poll_initial_delay_ms/poll_interval_ms/max_poll_count` 写 `next_poll_at` 和 intent。adapter 只可建议下次轮询间隔，不能上报或延长 terminal deadline。
- Consumer 锁定 attempt，校验 `status in (accepted,polling)`、`dispatch_state=accepted`、`poll_no=current poll_count+1` 和服务端 deadline 后，事务外调用 adapter poll，再以原版本 CAS。
- 重复/旧 poll job 幂等 no-op；未来 poll_no 或状态不符 fail closed 并告警。
- poll 返回 pending 时递增 poll_count、写 last/next poll 时间并创建下一 intent；达到 count/deadline 或无法判定是否有终态时进入 outcome_unknown，不能 submit 新请求。
- Redis 全丢只按 DB 的 accepted/polling + next_poll_at 重建 poll job，不重建 submit。

## 7. Webhook 安全与持久化

公开路径固定为：

```text
POST /api/v1/webhooks/providers/{provider}
```

该路径不使用用户 Session/CSRF，但必须执行以下链路：

1. `{provider}` 必须命中编译期 adapter allowlist；未知 provider 返回 404。
2. 对原始 body 设置固定上限，超限在解析前拒绝；raw body 只存在于请求内存，不写日志/数据库/队列。
3. 使用 adapter 的固定 header schema、时间窗和 constant-time signature verify；IP allowlist 只能作附加信号，不能替代验签。
4. 验签成功后才从 `unknown` 解析；计算 body digest，并以厂商 event ID 或规范化 digest 形成稳定 dedup key。
5. 同一短事务插入/复用 `provider_callback_events`，并写 `provider.callback.process` queue intent；事务提交后才返回泛化 202。
6. Consumer 通过 normalized provider request ID 关联 attempt。无法匹配、payload 非法、终态冲突或迟到 unknown 的事件转 `dead_letter`/人工池，不丢弃、不猜测用户。

重复 webhook 返回同样 202 且不重复推进状态、创建 artifact、写 outbox 或结算。验签失败返回 401，格式错误返回 400；响应不得暴露 request ID 是否存在、attempt 状态或签名细节。

callback 可能早于 submit 结果的本地 accepted CAS 到达。首次无法匹配的事件先进入 dead letter/unmatched，写 `processing_count` 和 `next_process_at`；attempt 成功写入 `provider_request_id` 后必须在同一事务或提交后的可恢复 intent 中，以 `processing_no=processing_count+1` 创建新的 callback intent。定时 sweeper 也按有界批次重放 `received_at` 起 24 小时内仍为 retryable unmatched 的 event；每次使用新的稳定复合 job ID。该路径只重试 callback 归并，不调用 submit。

24 小时在线匹配窗口到期后，事件转为永久 `dead_letter`，停止自动归并、不得修改 attempt 或重新 submit；脱敏证据仍按 `08` 的 365 天策略保留。Provider 内部成本对账或用户资金争议中的记录不因窗口到期被物理删除，后续消费方与处理 SLA 归 S15 运营能力；内部对账不得延迟 unknown 冻结释放或追扣用户积分。

## 8. 数据模型回写

S07 通过新的前向 migration 创建/扩展以下结构，不修改 S02-S06 已提交 migration，不执行 drop/reset/recreate：

- `task_attempts` 新增 `accepted_at`、`last_polled_at`、`next_poll_at`、`poll_count default 0`；增加 polling 扫描索引与非负 CHECK。
- `provider_callback_events`：验签后 callback 的去重、处理状态、attempt 关联、脱敏摘要与 dead letter 真相。
- `provider_circuit_states`：provider/model scope 的持久化 circuit 状态、revision、窗口计数和 probe 时间。

model capability/pricing/quota JSON 必须由 `packages/provider` schema 从 `unknown` 校验。model 标识与三个 JSON snapshot 创建后不可变；能力、价格、配额或版本变化创建新 row，不原地覆盖。status 只按 `05` 的受控 CAS 转换，运行时熔断不改 model status。

S14 前模型 bootstrap 只允许受控 `scripts/ops/register-provider-model` / `approve-provider-model` 调用同一领域 Service：注册时固定为 `free_test_only`，审批命令要求 evidence digest、操作者、原因、expected status 和交互确认，才能 CAS 为 `poc_passed/poc_failed/disabled`。CLI 不接收 Provider Key 命令行参数、不执行手工 SQL；test fixture 只在独立测试事务中创建 fake model。

## 9. 熔断、配额与恢复

熔断 scope 为 provider 或 model，状态固定 `closed | open | half_open`。数据库是控制真相，Redis 只用于有 TTL 的并发/速率计数；Redis 不可用时新的真实 Provider submit fail closed，不退化为进程内 Map。

- 路由前读取 model status 和 circuit state；任一 open 立即拒绝新 submit。
- 窗口指标至少包含 sample、not_dispatched failure、accepted failure、outcome_unknown、auth/quota error 和 latency。
- 自动 open 阈值来自 model quota/circuit snapshot；禁止业务代码写死厂商阈值。
- open 到期后仅允许一个带 DB revision CAS 的 half-open probe；其他请求继续拒绝。`probe_after` 在 open 时表示最早探针时间，领取后原子改写为服务端计算的 half-open 租约截止 `now + circuit_open_ms`；provider scope 即使被不同模型访问也只读取该持久化截止，不用当前请求的模型参数反推旧租约，不信任 Worker 或 adapter 上报时间。
- probe 成功关闭并重置窗口；失败重新 open。若 probe owner 在租约内未回写结果（包括进程崩溃），下一次路由检查必须用行锁 + revision CAS 将过期 half-open 原子转回 open，清空 `probe_owner`，写 `reason_code=half_open_probe_timeout`，并从该服务端时刻重新计算 `probe_after`；本次请求继续 fail closed，下一个 cooldown 到期后才允许唯一新 probe，禁止直接接管旧 owner 或并发放出第二个 probe。并发更新影响行数不是 1 时重读。
- 若 attempt 在 Provider 请求启动前因 CAS 失效而无法投递，则使用原 probe token 原子释放 `half_open -> open`，不记录 Provider 结果、不增加 failure/unknown 样本，并允许下一次检查重新领取 probe。
- auth failed、配额耗尽可以按证据打开 Provider/model scope；单个 model snapshot 的单小时成本超限只打开该 model scope，不得连带熔断同 Provider 下其它模型。账本漂移由 S04 全局 fail closed，不由 Provider Gateway自行恢复。
- 单小时成本熔断的授权真相来自 PostgreSQL 中按 Provider/model/hour 聚合的 dispatch exposure，不读取用户 credit ledger，也不以可能迟到的 Provider 回调作为是否计入的前提。请求确认可能写出时，按该 attempt 绑定的不可变 pricing snapshot 计入暴露成本；`accepted`、`succeeded` 与 `outcome_unknown` 均计入，后续 Provider reported cost 只用于对账/校准，不能倒退已触发的小时预算保护。Redis 只允许做带 TTL 的加速计数，丢失后必须回读数据库真相。
- `daily_budget_cny` 在本轮只冻结并校验 model snapshot 字段，不宣称日预算门禁已生效。真实 Provider 路由在 S14 激活前，必须补齐基于 PostgreSQL dispatch exposure 的日预算门禁、并发反例和运维告警；不得仅依赖 Redis 或管理台展示值放行。
- Redis 并发槽位租约必须至少覆盖本次调用的服务端 `deadlineAt` 再加固定安全窗口，不能按模型 terminal timeout 猜测 transport 时长。正常完成后仅由 owner token 释放；transport 忽略 abort 时依赖租约到期 fail closed，旧 owner 不得释放后来者槽位。
- S14 前人工恢复 open 或租约已过期/无有效租约的 half-open circuit，只允许受控交互式 `ops:recover-provider-circuit` 调领域 Service，要求 scope key、expected revision、操作者、原因和二次确认；仍在有效租约内的 probe 不得被强制关闭，并发恢复仅一个 CAS 成功，不接受命令行参数，不直接 UPDATE 表。S14 后由独立管理台、Admin Session、permission、step-up 和审计调用同一 Service。

## 10. 内容安全边界

- `moderation.text` 在 Provider submit 前执行；拒绝或审核不可用时 fail closed，不调用生成 Provider。
- S07 的 Gateway/adapter/fake 必须证明文本与图片审核结果归一为 `pass | blocked | unknown`，并记录策略版本和非敏感 reason code。
- 正式“报价/冻结前文本审核”由 S09 编译/提交链接入；S07 不在 Worker 里创造绕过生成动作证据和积分核对的新预留语义。
- 生成后 `moderation.image` 与 quarantined artifact 的正式落库/可见性由 S10-S13B 激活。S07 只提供接口和 PoC；在该链路完成前，真实生成不得进入公网收费路由。
- 审核 unknown 不得按 pass 处理；图片保持隔离，24 小时 SLA 和结算/释放遵循 `04/06`。

## 11. S14 后真实 PoC 激活契约、成本与产物卫生

本节冻结后续真实 Provider 激活时必须满足的契约，不属于本轮 Gateway/fake/恢复底座的完成条件。真实 adapter、runner、实际调用证据和模型人工审批必须在 S14A 管理配置完成后，由 S11（Agent Brain）和 S12（图片生成/编辑、文本/图片审核）分别实现、复审和验收；不得以本轮 FakeProviderAdapter 或离线成本夹具勾选这些条目。

真实 PoC 命令固定放在 `scripts/poc/`，只调用编译期注册的 adapter 和 allowlisted endpoint。每次运行要求：

- `APP_ENV=local`、`POC_CONFIRM_REAL_COST=1`、明确 model snapshot ID、manifest 和 `POC_MAX_CALLS`；超过 manifest 或预算立即停止。
- 图片生成与图片编辑各至少 20 次受控调用；文本/图片审核覆盖 pass、blocked、unknown 和服务不可用样本。
- 使用无用户隐私、无真实订单/商品机密的批准样本；参考图来源和授权记录在 manifest。
- 输出写 Git 忽略的 `artifacts/poc/provider-runs/`；只保存脱敏 JSON、质量评分、成本单位和本地输出文件，不保存 Key、完整 headers、签名 URL 或未脱敏 prompt。
- 每条记录含 provider/model/version/capability contract version、attempt ID、request ID hint、三态、延迟、计费单位、成本 decimal string、错误分类和 reviewer 质量结论。

成本报告使用 `decimal.js` 和 `packages/shared` 金额工具，禁止 JS `number` 金额算术。输入 decimal string，CNY 保留 2 位 `ROUND_HALF_UP`；`suggested_credits` 使用 Decimal 向上取整。公式沿用 `03` §6.1，并验证 failure/unknown/refund/risk rate 均在 `[0,1]`、gross margin 在 `[0,1)`、credit anchor 大于 0。

`validate:cost-report` 使用固定公开夹具，可离线重算并对输入顺序稳定；真实报告属于本地/受控验收产物，不默认提交仓库。模型只有在真实调用、质量评审、回执/超时、审核、配额和成本全部通过后才能写为 `poc_passed`；自动脚本不得自行批准模型。

## 12. 配置、日志与指标

S07 配置由 Worker/API typed config 分别读取，业务代码零 `process.env`：

```text
PROVIDER_MODE=fake|real
PROVIDER_PROCESSOR_MODE=disabled|fake_validation|real
PROVIDER_ADAPTER=<allowlisted id>
PROVIDER_<ADAPTER>_API_KEY=<server secret>
PROVIDER_<ADAPTER>_WEBHOOK_SECRET=<server secret>
PROVIDER_CALLBACK_DIGEST_KEYRING=<key_id:secret,...>
PROVIDER_CALLBACK_DIGEST_ACTIVE_KEY_ID=<key_id>
PROVIDER_ENDPOINT=<allowlisted HTTPS origin>
PROVIDER_REGION=<allowlisted region>
PROVIDER_CONNECT_TIMEOUT_MS
PROVIDER_REQUEST_TIMEOUT_MS
PROVIDER_POLL_INTERVAL_MS
PROVIDER_TERMINAL_TIMEOUT_MS
PROVIDER_WEBHOOK_MAX_BODY_BYTES
PROVIDER_WEBHOOK_CLOCK_SKEW_SECONDS
COST_BUDGET_HOURLY
```

实际厂商可以使用命名空间变量，但必须由 adapter 自己的 typed schema 校验；不允许 `PROVIDER_*` 通配读取任意值。secret 仅注入需要发起调用/验签的进程；Web 和 migration 不接收。

结构化日志至少带 `event/trace_id/task_id_hash/attempt_id/provider/model_version/error_code/dispatch_state/duration_ms`；不得记录 user ID、完整 prompt、Key、签名、callback raw body、输出 URL、对象 key、图片二进制或厂商原始错误。

指标至少包含 submit/accepted/succeeded/failed/unknown、not-dispatched retry、poll latency/count、callback valid/invalid/duplicate/dead-letter、circuit state/probe、quota reject、moderation decision、provider reported cost 和 hourly budget。

## 13. 实现边界

- Processor 只编排：读 DB 真相、事务外调用 Gateway、再调用状态 repository；不内嵌厂商解析、资金或 artifact 权限逻辑。
- Provider 请求与 DB transaction 不得重叠。提交前状态必须先落 `dispatching`；外部调用返回后用 CAS 收敛，进程在两者之间崩溃时按“可能已送达”恢复为 outcome_unknown，不能重新 submit。
- 崩溃恢复必须调用集中 attempt repository 的显式迁移，不得依赖 Processor 特判；测试需锁定 `dispatching/not_dispatched -> outcome_unknown/outcome_unknown` 且 submit 计数不增加。
- Webhook Controller 只取得 raw body/headers/provider 和 request context；验签、持久化、去重与业务处理分层。
- `packages/provider` 不依赖 apps、db、queue、credit 或 NestJS；应用通过端口注入 clock/random/http transport，测试不访问网络。
- S07 不新增用户端页面，也不修改首页/Composer；PoC 可用 CLI 报告，不以管理 UI 是否存在阻塞 Gateway 工程验收。
- S07 不新增公网 SSE event type；attempt/task 变化继续投影为 `06` 已存在的 `task.status_changed`。后续若新增事件类型，必须按 S06 演进门禁同步服务端/Web 白名单和契约测试。

## 14. 测试标准

### 14.1 单元/契约

- 四类 capability schema、未知字段、非法 model snapshot、参数边界和敏感字段拒绝。
- submit 五种 outcome；连接前失败与写出后超时的反例分类。
- deadline 必须触发 adapter 可观察的 AbortSignal；transport 确认中止或完成前不得释放并发配额。
- fake adapter 完全确定性，stable idempotency key 重放不产生第二次计费调用。
- webhook raw-body 验签、时钟窗、constant-time compare 封装、重复 event 和非法 payload。
- 成本 decimal、舍入、边界 rate、输入顺序稳定和非法值 fail closed。
- circuit closed/open/half-open、单 probe、revision 冲突和 Redis 不可用。
- 配额租约覆盖调用 deadline，过期 owner 不能释放 replacement owner；`daily_budget_cny` 仅作 schema 冻结，不以未实现门禁通过真实 Provider 激活验收。

### 14.2 PostgreSQL/Redis/BullMQ 集成

使用独立 `_test` 数据库和每次运行唯一 `TEST_REDIS_PREFIX`；禁止 drop/recreate/reset、修改 migration 历史、`FLUSHALL`/`FLUSHDB`。

- 同一 task 并发消费只执行一次 submit；稳定幂等键不重复调用 fake。
- 明确 not_dispatched 最多两个新 attempt；accepted/outcome_unknown 零重投。
- dispatching 状态提交后模拟进程崩溃，恢复为 outcome_unknown 而非重新 submit。
- accepted -> polling -> succeeded；重复/乱序 poll no-op；deadline -> outcome_unknown。
- webhook 事务写 callback event + intent；重复 webhook、双 Consumer、无法匹配和迟到回调。
- callback 先于本地 accepted 到达：先 unmatched，accepted 持久化后只重放 callback 归并且最终处理一次，不发生第二次 submit。
- callback/poll 与存活 Worker 并发时只有一个 CAS 成功，outbox/settlement intent 恰好一次。
- circuit 并发 open/half-open probe、重启后保持状态；领取 probe 后模拟进程崩溃，租约过期先回 open 且不放行本次请求，下一个 cooldown 后仍只允许一个新 probe；Redis 故障新的真实 submit fail closed。
- queue recovery 只重建 poll/callback，不重投 accepted Provider request。

### 14.3 专项命令

- `pnpm validate:provider-timeout`：真实测试库 + fake adapter，证明 accepted/写出后超时进入 outcome_unknown、不新建 attempt、不重复扣费。
- `pnpm validate:cost-report`：固定夹具离线重算并核对 decimal/舍入/毛利/建议积分。
- S11/S12 后续激活交付必须提供 `pnpm poc:agent-brain`、`pnpm poc:provider:image`、`pnpm poc:provider:edit`、`pnpm poc:provider:moderation`；这些命令仅在显式真实成本门禁下运行，不进入 `pnpm check` 或 CI，本轮不提供空转占位脚本。

## 15. 正反向验收

正向：model snapshot -> pre-moderation pass -> attempt dispatching -> Provider accepted -> callback/poll terminal -> 脱敏回执/成本 -> 后续 S10 artifact quarantine -> moderation pass -> settlement，全链以 DB 状态和稳定 ID 幂等收敛。

反向：未知模型/能力、circuit open、配额不可用、连接前失败、发送后断线、accepted 超时、重复/伪造 webhook、回调先于本地 accepted、callback 丢失、poll 重放、Redis 全丢、进程崩溃、迟到 success、成本未知和审核 unknown，均不得造成重复 Provider 调用、越权产物、自动补扣、密钥泄露或未知结果自动重投。

## 16. 验收清单

- [ ] 上游 `03/04/05/06/09/10` 回写完成并复审通过。
- [ ] Provider Gateway 与 fake adapter 的四类能力、三态、超时和错误分类有契约测试。
- [ ] callback/poll payload、验签、持久化、去重、dead letter 与恢复闭环可审计。
- [ ] not_dispatched 有界重试，accepted/outcome_unknown 在并发、崩溃和 Redis 恢复下均不重投。
- [ ] 熔断/配额 fail closed，单 half-open probe、探针崩溃租约恢复和 revision CAS 有真实集成测试。
- [ ] 成本报告只用 decimal，固定夹具可离线重算。
- [ ] 管理能力仅提供领域 Service/指标，未在 `apps/web` 创建管理 UI；S14 可复用且不重写语义。
- [ ] `pnpm check`、`pnpm build`、`pnpm test:integration`、`pnpm test:worker`、`pnpm validate:provider-timeout`、`pnpm validate:cost-report`、`git diff --check` 全部通过。

S14 后真实 Provider 激活的独立验收项（本轮不得勾选）：

- [ ] 图片生成和编辑各至少 20 次真实 PoC，文本/图片审核 PoC 通过并完成质量/成本人工审批。
- [ ] 厂商 adapter、PoC runner、Key/endpoint/region/预算配置和管理员审批已完成独立代码复审与安全验收。

# Final relay integration addendum (2026-08)

This addendum is authoritative for S07 real-provider integration and supersedes
the earlier fixed OpenAI official endpoint decision:

- Relay protocol families: `openai` and `anthropic` only.
- API variants: `openai_chat_completions`, `openai_responses`,
  `anthropic_messages`, and `openai_images`.
- Brain adapters use Vercel AI SDK with `maxRetries=0`, one SDK request per
  AgentBrain step, no SDK-owned tool execution loop, and strict normalization
  into the existing AgentBrain outcome contract.
- Image adapters use the OpenAI Images contract for generation/editing and retain
  ProviderGateway three-state outcomes and the existing task/attempt boundary.
- A channel may hold several model snapshots. A selected model snapshot is fixed
  for the entire capability slot and cannot be replaced by fallback logic.
- Relay origins are server-allowed HTTPS origins. The admin API never accepts
  arbitrary headers, arbitrary request JSON, or an unvalidated endpoint.
