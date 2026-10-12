# 09 验证与运营

| 项       | 内容                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 状态     | v0.7 1A 生成排队与无费用卡交易反例回写后待复审                                |
| 基准     | PRD v1.12                                                                     |
| 完成节点 | 内测前                                                                        |
| 裁决范围 | 资金异常脚本、模型 PoC 验收、邀请内测指标、监控告警、灰度、环境门禁、故障手册 |
| 不裁决   | 产品边界、数据库最终 schema、UI 细节                                          |

## 1. 目标

阶段 0 验收不能只靠文字。必须用脚本证明以下场景不会重复扣费：

- 单次投递。
- 供应商已受理但超时。
- 回执丢失。
- 重复点击。
- Worker 恢复。

同时必须能查询并告警：

- 账本不一致。
- Provider 错误。
- 回执未知。
- 任务等待过长。
- 单任务成本和单小时成本异常。

## 2. 1A 累计验收脚本

脚本目录：

```text
scripts/validation/
```

必需脚本：

```text
single-dispatch.spec.ts
provider-accepted-timeout.spec.ts
webhook-lost.spec.ts
duplicate-click.spec.ts
worker-recovery.spec.ts
ledger-replay.spec.ts
cost-report.spec.ts
agent-trace-loop.spec.ts
skill-load-cache.spec.ts
skill-content.spec.ts
golden-eval-gate.spec.ts
image-pipeline.spec.ts
creative-chat.spec.ts
specialized-skills.spec.ts
operations-control-plane.spec.ts
deployment-smoke.spec.ts
```

建议命令：

```bash
pnpm validate:single-dispatch
pnpm validate:provider-timeout
pnpm validate:webhook-lost
pnpm validate:duplicate-click
pnpm validate:worker-recovery
pnpm validate:ledger-replay
pnpm validate:cost-report
pnpm validate:agent-trace-loop
pnpm validate:skill-load-cache
pnpm validate:skill-content
pnpm validate:golden-eval-gate
pnpm validate:image-pipeline
pnpm validate:creative-chat
pnpm validate:specialized-skills
pnpm validate:operations-control-plane
pnpm validate:smoke
pnpm validate:stage0
```

`validate:stage0` 保留历史命令名作为兼容入口；到 S15 时必须聚合本节全部 1A `validate:*`，并对每个子命令校验实际匹配用例数。它不能只运行 S01-S10、使用 `--passWithNoTests`，也不能以 fake 结果替代下述真实 Provider/Brain PoC。当前 `specialized-skills`、`operations-control-plane`、`smoke` 三条尚未实现：`validate:stage0` 会把缺失列为失败（红即真，不允许假绿补齐），实现或修订本节清单后方可转绿。

真实 Provider/Brain PoC 不属于普通 `validate:*` 或 CI，不得被 fake 结果替代。S11/S12 在 S14A 配置和审批完成后分别提供受控命令：

```bash
pnpm poc:agent-brain
pnpm poc:provider:image
pnpm poc:provider:edit
pnpm poc:provider:moderation
```

每个命令都必须要求 `APP_ENV=local`、显式真实成本确认、固定 model snapshot、allowlisted adapter/endpoint、调用上限和脱敏 evidence；只要凭据、预算、回执、质量、审核或成本任一项 unknown，就不得写入可发布状态。`poc:agent-brain` 由 S11 负责，后三个由 S12 负责，S15 只验收最终证据。

`poc:agent-brain` 额外要求通用真实 Provider 门禁 `PROVIDER_REAL_POC_ENABLED=true`、`PROVIDER_REAL_COST_CONFIRMED=I_ACCEPT_REAL_PROVIDER_COST`、精确 `AGENT_BRAIN_POC_MODEL_SNAPSHOT_ID` 和固定为 5 的 `AGENT_BRAIN_POC_MAX_CALLS`。同一门禁约束 S12 的审核、图片生成和图片编辑真实 PoC，不允许各模型类别另设可绕过的成本开关。Brain 的五个调用依次证明安全回复、必要澄清、候选计划、optional auxiliary 加载与命中条件后的 primary L2 Reference 加载。命令只解析该 model snapshot 固定的 channel/credential，不读取 `OPENAI_API_KEY`、不接受 URL/header/model override；报告只写 adapter/model/version、调用计数、usage/cost、结果分类与 digest 到 Git 忽略的 `artifacts/poc/`，不得写 prompt、Key、完整 Provider 响应或用户数据。真实命令证明 strict 输出、可信 usage、actual cost 与 Skill 渐进加载遵循；连接复位/超时 unknown、exposure 保留、未支持模型网络前拒绝和无静默换模由同一 adapter/router 的可控自动化反例证明，验收时两类证据必须同时存在。

### 2.1 后续阶段验收脚本

后续脚本仍放在 `scripts/validation/`，命令和主断言如下：

| 命令                                  | 主断言                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm validate:video-poc`             | 视频 Provider 回执、配额、质量和成本审批通过                                |
| `pnpm validate:long-task-recovery`    | 30 分钟级任务刷新、断线和 Worker 重启后可恢复且不重复扣费                   |
| `pnpm validate:golden-eval-extension` | S17 质量版本、Preset、可选新候选与高清工具通过版本化 golden eval 和成本门禁 |
| `pnpm validate:batch-50-sku`          | 50 SKU 排队、并发限制、部分失败和重试互不污染                               |
| `pnpm validate:share-privacy`         | 分享、撤回、举报及“做同款”不泄露私有素材和完整提示词                        |
| `pnpm validate:template-unlock`       | 模板版本、解锁与积分账本幂等                                                |
| `pnpm validate:suite-7-images`        | 7 张套图单动作提交、部分失败、归档和账本一致                                |
| `pnpm validate:platform-spec-rules`   | 三平台规则版本化；hard block 默认关闭且校准门禁可证明                       |
| `pnpm validate:canvas-mount`          | 产物挂载、修改权、节点版本和回退一致                                        |
| `pnpm validate:canvas-dag-run`        | DAG 环检测、整链单动作提交、恢复和账本一致                                  |

这些命令在对应阶段才成为发布门禁，不纳入 1A 的 `validate:stage0`。

## 3. 脚本断言

### single-dispatch

断言：

- 一个 `task` 只创建一个当前有效的 `task_attempt`。
- 队列重复投递同一 `jobId` 不产生第二次 Provider 调用。
- `credit_reservation` 只创建一次。

### provider-accepted-timeout

断言：

- Provider 已返回 request ID 后超时，或请求可能写出但无法取得有效回执时，状态进入 `outcome_unknown/outcome_unknown`。
- fake submit 调用计数保持 1，系统不自动创建新 attempt、不重新 submit。
- reservation 保持冻结且不重复扣除，任务进入人工处理或用户明确新报价路径。
- 验证 dispatching 状态提交后模拟进程崩溃，恢复同样不得猜测为 `not_dispatched`。

### webhook-lost

断言：

- Provider 已受理，但平台没有收到最终回调。
- 轮询失败后进入 `outcome_unknown`。
- 不自动创建新 attempt。
- 告警被触发。
- S05 阶段只使用 Fake attempt/回调缺失夹具证明 accepted/polling 的恢复底座、状态 CAS 和不重投 Provider；`provider-callback` payload、重复回调处理、真实签名与外部 Provider 联调由 S07 回写并验收。

### duplicate-click

断言：

- 同一用户同一幂等键重复提交，只返回已有报价或运行。
- 不重复冻结积分。
- 不重复入队。

### worker-recovery

断言：

- Worker 在 `dispatching/not_dispatched` 中断时，只有 adapter/transport 能证明请求未离开本机才可重试；无法证明时必须进入 outcome_unknown。
- Worker 在 `accepted` 后中断，不自动重新投递。
- 新 Worker 根据数据库状态恢复。
- 多 dispatcher 竞争同一 intent 时只有一个有效 owner；lease 过期后旧 owner 的 CAS 更新失败。
- 模拟 BullMQ add 成功但 DB 标记失败后，以相同 job ID 重放且不产生第二次业务消费。
- reconciler 与存活 Worker 同时消费时只有一个状态 CAS 成功，失败方 reload 后 no-op；状态与 outbox 不出现分裂。
- 当前 BullMQ 版本下，同 job ID 对 waiting/active/completed/已清理 job 的 add 行为均有断言，业务正确性不依赖覆盖旧 payload/options。
- dispatcher 与 sweeper 短暂重叠时复用同一 claim/CAS，不能产生两个有效 owner；`dispatched` intent 只由 reconciler 重建。
- 删除唯一测试 `REDIS_PREFIX` 下的 BullMQ key 和 recovery sentinel 后，pending 与仍需执行的 dispatched job 均可从 DB 恢复；终态 no-op。
- 多输出图片生成时，独立 `moderation` 队列必须让已完成输出的审核与后续 generation 并行；首张审核通过的 `artifact.created` 早于最后一张 generation 终结。Redis 恢复按 intent 原 queue/job type 重建，旧 `task.execute` 审核任务仍可兼容消费。
- `accepted/polling` 只恢复查询/等待，`outcome_unknown` 只恢复核验/人工处理，Fake Provider 投递计数不增加。
- half-open probe 领取后模拟 Worker 崩溃且不回写结果；服务端租约过期后的首次检查必须原子回 open、清空 owner 并继续 fail closed，重新 cooldown 后并发检查仍只能领取一个新 probe。
- reconciler 在 sentinel 写入前崩溃时可由新 owner 接管；完成后重复运行不新增 job。
- recovery sentinel 缺失时 queue readiness 失败且新生成/收费写操作 fail closed；reconciliation 完成并写 sentinel 后才恢复接流。
- SIGTERM 后 Worker 停止领取新 job，heartbeat 进入 draining，active job 在时限内完成或由恢复机制接管。

隔离要求：

- 脚本只允许 `APP_ENV=test`，使用 `TEST_DATABASE_URL` 连接独立测试数据库；本地固定 `ecom_forge_test`，CI 可使用 `ecom_forge_test_<run_id>`。规范化后的 host/port/database 与 `DATABASE_URL` 完全相同，或 database 名不含 `_test`/`_test_` 边界时，测试启动失败。
- Redis 必须使用 `TEST_REDIS_URL` 的独立实例或逻辑 DB，并使用每次运行唯一的 `TEST_REDIS_PREFIX=s05-test-<run_id>`；该 URL + prefix 组合不得等于开发/生产配置。Redis Cluster 只能使用独立测试实例。
- Redis 全丢演练只删除该测试 prefix 下的 BullMQ key 与 sentinel；禁止对共享或非隔离 Redis 执行 `FLUSHALL`、`FLUSHDB`。
- 数据库不做 drop/recreate/reset；test harness 必须保存本次创建的精确主键白名单，并在可用业务键中加入 `test_run_id` 前缀，清理只按这些 ID 执行，禁止改写 migration 历史。
- S14 Admin bootstrap 依赖“尚无 active super_admin”的全局不变量，正式集成门禁固定使用单独的 `S14_TEST_DATABASE_URL`（本地 `ecom_forge_test_s14_gate`，CI 可加 run_id 后缀）。该数据库只做前向 migration，禁止 drop/recreate/reset；各独立用例仍按测试专用标记和精确 ID 清理自身 principal/session/challenge，不得删除其他管理员。

### ledger-replay

断言：

- `credit_accounts.balance/frozen` 等于 `credit_ledger` 重放结果。
- 每条 ledger 都有幂等键。
- 人工冲正只追加流水。

### cost-report

断言：

- 固定公开夹具中的每次 Provider 调用都有 decimal string 成本和三态记录。
- 使用 `decimal.js` 与共享金额工具按模型、任务类型、小时聚合，CNY 统一 2 位 `ROUND_HALF_UP`；禁止 JS number 金额算术。
- failure/unknown/refund/risk rate、gross margin、credit anchor 的非法边界 fail closed，超过小时预算触发告警。
- 小时预算门禁以 PostgreSQL dispatch exposure 为真相：请求可能写出即按不可变 pricing snapshot 计入，`accepted/succeeded/outcome_unknown` 不得因回调缺失而漏算；credit ledger 与 Redis 计数都不能替代该真相。
- 输入顺序改变不影响聚合和输出，可生成 Git 忽略的 `artifacts/poc/cost-model.csv` 或同等工作表。
- 能按 1 积分 0.05 元内部锚定，用 Decimal 向上取整反推 `suggested_credits`。

### agent-trace-loop

断言：

- 每个 turn 都生成 `agent_trace_id` 和 step 日志。
- 同一 turn 同一工具等价入参第 3 次执行前被阻断；canonical hash 覆盖 tool contract、参数、引用版本和 Skill resource hash。
- 连续 3 个无进展 observation 触发 `AGENT_NO_PROGRESS_LOOP`，连续 3 个同工具/参数/错误触发 `AGENT_REPEATED_TOOL_ERROR`。
- rounds/tool/input-output token/平台成本预算任一耗尽即停止；命中保护后不再调用模型、工具、Compiler 或收费 Provider。
- started LLM 调用后模拟崩溃，保守成本暴露仍计入预算；恢复不能把可能发生的调用当作零。
- 同一 LLM step 成功回执重复到达时只原子执行一次 `reserved -> estimated`；明确未发出才释放 exposure，超时/截断/非法响应/usage 缺失统一保留 exposure 并记内部 `AGENT_CALL_OUTCOME_UNKNOWN`。
- Agent Brain media/agent strict model schema 必须互斥；capability/pricing/quota kind 不匹配、无原生 tool/strict terminal、无可信 usage 均在网络调用前 fail closed。
- 每个 S08 新 trace 与每次 llm step 固定 strict model snapshot；真实调用还引用精确 `models.id`，可回放 provider/model/version/pricing/capability/准入证据。legacy 文本 model ID 不得驱动真实调用；失败、超时或 unknown 不得自动换模，用户需新建 turn 后重新选择。
- 并发 create/confirm/interrupt、lease 接管、旧 owner 晚到写、同 session 新消息 supersede 和 Redis 全丢恢复使用真实测试 PostgreSQL/Redis 证明。专项覆盖同一 continuation 在状态/step 推进使 revision 增长后崩溃，stalled job 仍可按当前 DB 状态接管；payload revision 只作审计基线，不能造成永久卡死。
- create/confirm/interrupt 的首次响应快照在 turn 后续推进后仍能逐字段幂等重放；幂等查询必须先于状态校验、session lock 和 supersede，同 key 不同 payload 返回 409，重放不写事件或影响后来 turn。
- test-only fake tool 在 `APP_ENV != test` 的 composition root 中必须启动失败。
- Agent API/SSE 只返回 `user_status` 和安全 activity，不返回内部 turn 状态、tool name/args 或模型私有推理。
- 工具输入精简专项：`pnpm --filter @ecom-forge/provider exec vitest run src/agent-brain/vercel-ai-agent-brain.spec.ts` 必须覆盖三协议稳定七工具、单图/九图精简计划、scope 冲突不被覆盖、正式空提示词/未知字段拒绝及只填 question 的澄清。联动运行 `pnpm --filter @ecom-forge/worker test:integration test/s08-agent.integration-spec.ts test/s08-transcript-write.integration-spec.ts`，核对完整计划归一化后的 transcript 与结算/恢复不变。真实实测用既有 trace 的诊断分类、repair_attempt 和 token usage 对比首次调用成功率与修复轮数，fake 通过不等于真实模型零格式错误；不得为统计保存 prompt 或原始回包。

### agent-session-transcript (S08 扩展)

**实施状态（2026-09-13）**：P1/P2 已实施；`pnpm validate:agent-session-transcript` 与既有 API/Worker harness 在**隔离迁移库**上通过（默认测试库存在历史迁移漂移时入口会显式失败，见下）。`pnpm validate:agent-cost-exposure`（费用暴露恢复专项）由同一 runner 分派 `s08-agent.integration-spec.ts`。原 `s08-transcript-adapter-capture` 合成夹具套件已移除：其捕获证据由 read/write 集成套件与 provider 投影测试覆盖，真实生产授权读取器的端到端证据仍待补。

**复审口径**：全量代码复审与用户验收须分别记录当前改动区、检查结果及明确裁决，本节的"实施"不代表复审或验收已完成，不以历史记录代替当前门禁。已知环境限制：开发机主测试库存在一条历史迁移漂移行（被替换的旧 `0016` 内容），依赖自备库入口的验证必须在隔离迁移库上运行；漂移处置为独立运维事项，不由代码修复承担。

**2026-09-09 范围修订**：按 `02` 11.0 取消下列旧会话 backfill、legacy 双执行/排空/回滚、v1 summary 转换和导入监控验收项。验收从新会话开始；保留前向 schema 校验、残留旧格式拒绝执行、新流程并发/故障/生命周期/性能和 summary v2 门禁。旧路径只可作为离线性能基准，不要求部署兼容。未运行的检查必须报告未完成，不以取消旧会话兼容为由省略新流程恢复。

实施时新增 `pnpm validate:agent-session-transcript`，复用 `scripts/validation/run-s08-case.mjs agent-session-transcript`，由该入口分派现有 API/Worker 的 Vitest integration harness；不另造任务 runner。此处冻结验收义务，不表示该 case 已存在或测试已通过。使用隔离的真实 PostgreSQL/Redis 与 deterministic Fake Brain，不调用收费 Provider，不向报告写入用户正文。

P1 必须证明：

- 空库全量 migration、既有 schema 前向升级、legacy 默认值、mixed-format 拒绝/排空和回滚兼容；旧 migration 不改。
- 来源重复/内容冲突、整批 assistant 原子写、call/result 唯一配对、payload 引用完整性、租户/源 ID 交叉攻击、旧 owner 写入拒绝；真实 PG 并发验证 sequence 唯一和事务回滚不留半批。
- create/confirm/interrupt、summary CAS、工具结果、结算/unknown 释放终态同时写同 session，验证 `05` 的 account/session/turn/领域行/trace/outbox 锁顺序，无死锁和无界等待。
- backfill 分页崩溃重启、来源 revision 改变、导入中继续新请求、缺失旧工具参数、删除后的禁止复活、未完成导入不得切读；影子模式确实仍使用 legacy 请求视图。
- 任一已接受输出到 transcript/chat/usage/outbox 的写入故障不能形成相互矛盾的成功投影；外部副作用后的故障只能恢复既有 operation/attempt，不新增收费请求。

P2 必须证明：

- 捕获实际 adapter 输入：用户消息只出现一次、规划到 authoring 共享消息/引用、工具/系统前缀稳定、optional 知识在加载位置、图片 overview/detail 投影和版本撤销正确；终局工具及部分失败批次均无孤立 call/result。
- 工具执行前、执行后未写 result、result 已提交三个崩溃窗口；assert 实际执行计数。unknown/accepted/迟到产物不重投，续传/cache 不支持或 miss 时完整 portable 路径仍成立。
- source-content digest/sequence/generation/summary CAS 竞争、压缩失败/未知、active turn 超窗、旧 v1 summary 不能冒充 v2；完整终局组降级不会跳写摘要游标。全上下文计数包含 tools/Skill/图片/受控 payload，不只计算新传输字节。
- 前端原安全 API/SSE 保持兼容，提交前失败不显示成功，异步结果归属原分支，重新生成与刷新仍反映相同业务真相。使用 existing integration/E2E harness，不另造公开 transcript API。

容量与延迟验收预算（设计目标，不是实测结果）：

| 项目                  | 夹具/目标                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| envelope/私有 payload | 按 `05` 校验 64 KiB/8 MiB；最大合法模型/工具输出不得被静默截断                                                                |
| 典型 turn 估算        | 1 user + 6 assistant + 12 result + 8 host = 27 items；以平均 4 KiB 加 128 KiB 私有数据估算约 236 KiB，不含索引/TOAST/WAL      |
| 典型会话估算          | 100 个上述 turn 约 23.1 MiB 逻辑数据；不是强制 100-turn 上限，物理表/索引/WAL 另测                                            |
| 回放/导入负载         | 1/10/1000-turn 固定公开合成夹具；分页不超过 200 items/1 MiB envelope，超大 payload 单独按窗口预算解析                         |
| 测量方法              | 同机器/同数据，在旧路径、P1、P2 各预热后至少 1000 次；并发 1/4/8，记录 SQL 往返、锁等待、事务/每步总耗时、内存及逻辑/物理字节 |
| P1 非网络附加延迟     | 每步 p95 增量不超过 20ms，且 loop 本地 p95 回归不超过 10%；须同时满足，模型网络等待不进入这个对比                             |
| 写入硬边界            | lock timeout 1s、事务上限 5s；并发基准中死锁/丢失/重复语义结果必须为 0                                                        |

不得把“每个工具固定增加两次 DB 往返”当成结论；批次、usage/trace/outbox 与已有事务复用后以实测 SQL 数为准。未达预算时暂停切读并解释瓶颈，调整目标需要复审，不能用模型耗时掩盖本地回归或以省写入牺牲完整性。

> **S08 已知限制与待办（用户裁决 2026-09-11）**：S08 §17 transcript 扩展的裁决级测量（同机隔离库、1000 预热样本/路径）实测 native capture 相对等价旧路径步写入的 Δp95 = 23.87 / 76.81 / 143.95 ms（并发 1/4/8），超出上表 +20ms 预算。并发放大主要来自 session 行锁串行化（05 规定的锁顺序，正确性优先，并发基准 0 死锁/0 丢失/0 重复语义结果）。经用户裁决：**接受为已知限制，S08 本批验收不因此阻塞**；已完成的切读保留、不回退。
> **待办（下次文档复审）**：把本预算调整为分层口径——区分「无竞争单步写入」与「同会话并发写入（受 session 行锁串行化约束）」两类场景分别给预算，并说明锁串行化的原因；同时补充 P2 路径的独立测量口径。复审通过前，本行作为 S08 交付的差异披露项。

报告至少输出 `transcript_append_latency`、`transcript_lock_wait`、`transcript_bytes`、`transcript_integrity_failure`、`transcript_pending_call_recovery`、`transcript_projection_tokens`、`transcript_summary_cas_conflict` 的统计或等价既有监控入口（`transcript_import_remaining` 随 backfill 取消一并移除）；指标 label 只使用 format/type/result 等有界枚举，不能把 user/session ID 作为高基数 label。安全诊断日志可使用关联 ID。固定配置放 typed `runtime-defaults.ts`；本扩展不新增 Provider/费用默认值到 `.env.local`。

### skill-load-cache

2026-10-02 多图预算回归：验证 1/4/9 当前输入与接受节点数分别分配任务 rounds/output；较小模型单次能力、运营收紧 ceiling、272K 窗口和独立成本门禁均有效。逐节点写作必须覆盖缺失/重复/未知 key 拒绝、仅修改 prompt、不完整计划不进入 Compiler、已保存批次接管不重写、最后批次捕获后崩溃可原样恢复、并发 checkpoint 幂等和过期 owner 拒绝。Provider 返回 length 时即使有可解析 JSON 也不能接受；JSON 解析/schema 分类、reasoning usage 和实际下次单次额度可诊断，修复仍最多 3 次；unknown delivery 不自动重投。验收使用合成模型和隔离测试库，不自动重放用户付费请求。

断言：

- Skill 只按 L0/L1/L2 逐级加载，不全量预读。
- 每个 turn 的用户 primary Skill 必选并固定精确 `slug@version`；缺失、非 primary、停用、跨 Skill Preset、`latest`、版本范围和 capability 自授权都在创建任何 turn/trace/intent 或模型调用前被拒绝。模型不得自动选择或替换 primary。
- primary、用户 Preset 与 required auxiliary 预加载计入资源/L1/L2/input-token 知识预算并写 system trace/activity，但不计模型发起的 tool-call 次数；Skill 数量只统计 primary + 去重后的 auxiliary，Preset 不作为独立 Skill。预算不足时首次 LLM 前阻断。optional auxiliary 只可从 selection snapshot 的精确一跳 allowlist 动态加载。
- Skill catalog 只返回当前 stage 的 published/public primary 安全元数据；缓存中的已停用版本不能创建 turn，响应不得泄露 auxiliary、正文、capability、reference、评测、模型、价格或 Key。
- `load_skill@1` 只允许读取同一 Skill package profile 显式声明的一跳 `references/*.md`；跨 Skill、递归、绝对路径、`..`、URL 和 symlink 逃逸被拒绝。`SKILL.md` 的 `name/description/body` 是可复制创作知识，package manifest 的 `skill_profiles` 是宿主运行 profile；重复宿主字段、身份或 hash 不一致必须拒绝。
- DB snapshot 是真相；Redis hit/miss/degraded 均得到同一内容 hash，重复读取不重复展开 token。
- 同一 `(skill_id,resource_path)` 发布包 hash 漂移触发 `SKILL_VERSION_DRIFT`，不得 fallback、静默覆盖或继续执行。
- legacy null `content_text` 只有在发布包 hash 完全一致时可由受控脚本 CAS hydration；缺包、冲突或并发改写都 fail closed，且测试不删库、不删除历史行。
- Skill 内容以受控 `skill_knowledge` 数据块进入上下文，优先级低于平台 policy、ToolPolicy、Compiler/Credit/ownership 和用户当前明确选择；伪装 system/developer/admin、要求忽略平台约束或启用未注册工具的正文必须被 validator/runtime 拒绝。
- 运行时上下文不泄露完整私有 Skill 正文。

### golden-eval-gate

断言：

- Skill 或 prompt 新版本必须通过黄金集回归。
- 意图分类、解析确认、计划编译三项都要有可复现断言。
- 未通过门禁的版本不得进入 `published` 或可收费路由。
- 评测结果写入 `docs/provider-model-approval-log.md` 或同级审批记录。

### image-pipeline

断言：

- 生成前审核、Compiler/quote、reservation/workflow、图片 Provider、quarantine、生成后审核、发布处理、published artifact 与 settlement 按 S12 固定顺序推进；1A 不实现产品水印或 AI 标识，审核未通过前不创建收费执行。
- 每次真实生成后审核都由正式 moderation task/task_attempt 承载，固定 model/runtime/policy 与成本；旧 `evaluation.run` 不联网，重复/乱序审核回执只写一个不可变 evaluation。
- preflight 重复消费和并发恢复复用同一 operation；只有明确 `not_dispatched` 可恢复，可能写出、超时、崩溃或回执非法均为 `outcome_unknown` 且不自动重审/生成。
- Provider output reference 只能由固定 adapter 读取；任意 URL、重定向、私网地址、超大文件、magic byte/MIME 不符、维度越界、解码失败和输出数漂移全部 fail closed。
- publication put 后崩溃通过确定性 key 的 head/hash 收敛；hash 冲突或 put/head unknown 保持 quarantined，不重复 published object、consume 或 outbox。
- 多输入 `artifact_input_bindings` 完整保存 role/version/hash；跨用户、已删除、隔离或篡改 binding 被拒绝。人工 release/reject/到期三方并发只有一个 revision CAS 胜者。

### creative-chat

断言：

- 自由创作、人像焕新、照片意象重绘和本会话继续改分别固定 S13A profile；Skill、素材职责、模型能力或 generation preferences 不匹配时不静默换模、换 Skill 或降级能力。
- “生成两张/三张”和未写数量三类输入由 Brain 产生正确 `output_count/output_count_source`；Compiler 对数量、模型能力、Skill 默认和平台单次计划上限重校验。余额不足、价格未知、目录/计价漂移或数量越界均在 Provider 前阻断，不产生费用卡、reservation 或 Provider 调用；已有活动 workflow 时新任务仍正常入队。
- R1-R5、lineage、并发确认、刷新/SSE/Redis 恢复和 Provider 三态不产生第二个 quote/run/submit/consume。

### specialized-skills

断言：

- S13B 七个固定 profile 逐一校验 identity、privacy、文字事实、源图角色和 pixel anchor；内部平台能力不进入 Agent Tool catalog，也不接受 URL/路径/二进制参数。
- 实景拼贴及其相邻照片转译 Skill 验证输入/输出 hash 与 lineage receipt；源 revision 漂移、Provider 或存储 unknown 保持 quarantined。
- 重复确认、Worker 接管和 Redis 恢复不重复 Provider submit、published object、consume 或 outbox。

### operations-control-plane

断言：

- S14B 七个运营模块和 S14A 增强页均使用真实 API；最小角色权限、环境/用户隔离、step-up、幂等、revision 和审计失败回滚逐项覆盖。
- 风险、任务、资金、申诉、奖励、Skill 和管理员高风险写入调用领域 Service；资金只追加，`accepted/outcome_unknown` 不重投或伪退款，真并发只有一个赢家。
- keyset 查询覆盖领域筛选、前后翻页、重置、空页、坏 cursor 和请求失败；O13 仅在 S12 API 激活后显示。
- 用户中心的取消、明确重试、资产删除和申诉在真实普通用户 API 上验证，重复点击不重复投递或扣费。

## 4. Provider PoC 验收

每个进入可收费路由的模型必须有：

- PoC run JSON。
- 请求参数摘要。
- Provider 回执摘要。
- 成功样例。
- 失败样例。
- 错误分类。
- 配额和限流记录。
- 单次成本。
- 产品确认记录。
- 图片生成和图片编辑各至少 20 次受控真实调用；文本/图片审核覆盖 pass、blocked、unknown 和服务不可用。
- Provider endpoint、region、模型精确版本、账号资质、配额、调用上限和受控预算记录。

输出：

```text
artifacts/poc/provider-runs/*.json
artifacts/poc/provider-cost-report.md
docs/provider-model-approval-log.md
```

真实 PoC 不进入 `pnpm check`/CI，必须以 `APP_ENV=local + POC_CONFIRM_REAL_COST=1 + POC_MAX_CALLS` 显式运行。测试和 CI 只允许 fake adapter 且禁止网络；真实 run 原始产物、Key、headers、签名 URL、完整 prompt 和用户数据不得提交。自动脚本只能生成证据，不能自行把模型审批为 `poc_passed`。

## 4.1 Skill 发版评测门禁

阶段 0 先用小型黄金集做硬门禁，再扩成长期回归：

- 每个 Skill 新版本至少跑意图、引用绑定、事实确认、积分核对/提交证据和循环保护五类样本。
- 每类样本至少覆盖正例、边界例和错误例；最低规模为 5 类 × 3 条 = 15 条黄金用例。
- 发布门槛建议：关键断言 100% 通过，非关键断言不低于约定阈值。
- 失败时只允许修复后重新发版，不允许跳过门禁直接进生产。
- 评测输入和评测结果必须落 `agent_traces`、`skill_resource_snapshots` 和审批记录。
- 维护责任：产品负责业务样本和期望结果，工程负责自动化断言、回归脚本和版本审批记录。
- 每个安装包还必须通过 manifest/hash 完整性、路径/解包炸弹、同版本不同 digest、缺失/递归依赖、Preset 越界、可执行文件/脚本、secret/URL、许可证/来源、原子 release 和 rollback 测试。第三方包自带 eval 不能关闭平台强制负例或自行宣告通过。
- Skill 作者工具链必须有 golden CLI 测试：`skill:scaffold` 不覆盖目录；相同输入 `skill:pack` 字节和 package digest 可复现；`skill:validate` 与服务端 validator 对同一夹具结论一致；`skill:diff` 能识别 Skill/Preset/dependency/required input/eval/asset 变化且默认不打印私有正文；`skill:install` 只在 local/test 创建 quarantine + validation，不隐含审批或发布。
- `pnpm validate:skill-package-install` 使用本地只读夹具与真实测试 PG/Redis/隔离 storage 证明：合法包可幂等安装；篡改字节、未知文件、NFC/case-fold 冲突、zip-slip/symlink/hardlink、嵌套 archive、压缩炸弹、超限 entry、MIME/magic-byte 伪装、HTML/SVG/脚本/WASM、secret/URL、许可证缺失、manifest/frontmatter 重复声明或身份/hash 不一致、越权指令、同 package/Skill 版本不同 digest、重复 Skill owner 和未审批/跨 release 依赖均 fail closed。
- validation 恢复专项必须模拟：创建 intent 后 Redis 丢失、Worker 在 running 中崩溃、lease 过期接管、旧 owner renew/终态晚到、同 report 重复 job、package revision/digest 在结果前变化。断言只有一个终态 report，旧结果不能把新字节推进 ready/approved，终态不重跑 eval。
- queue v2 发布专项必须证明：Release A 可同时解析既有 v1 与 `skill-package.validate` v2，但 Producer 保持关闭；heartbeat 可识别仍存活的 v1-only Worker；全部旧 Worker drain 后提升 recovery schema v2 会使 readiness fail closed，reconciler 完成 v2 sentinel 后才允许 Producer 接流；历史 v1 intent 不被改写且仍可恢复。
- upload-intent 幂等专项必须证明：同 key/同 request 只产生一个 package record，同一有效上传窗口可为同一对象键重新签发 URL，签名 URL 不进入幂等表/审计/日志；窗口过期或 complete 后不再签发，同 key 不同 request 返回冲突。邀请码生成响应的幂等重放、恢复码和 Key 明文仍不能再次显示；邀请码列表复制只能使用 S14A 的单码受控 reveal。
- 审批/发布专项必须证明：旧 report/digest 不可审批；approval 不改变 active catalog；draft 是完整 closure；并发发布只有一个 expected revision 成功；发布事务中断不改变 active release；disabled package 即使仍被旧 active release 引用也不能创建新 turn；回滚创建新 release 序号且不影响历史 turn snapshot。
- 重新验证专项必须证明：同 digest 新 report 不覆盖旧报告；非 critical 失败进入 needs-review 告警并禁止新 release 引用；服务端写入 24h due 时间，达到 due 后即使 deadline sweeper 停止，catalog/turn create 仍按时间 fail closed；sweeper 恢复后只 CAS 持久化一次 `risk_blocked_at`/审计/outbox。critical 规则命中立即 disabled、catalog/turn fail closed，且不能原地恢复。

运行告警与 SLA：

- active release 中任一 package/resource hash drift、critical revalidation failure、catalog closure 失效：立即告警，目标 5 分钟内阻止新 turn，15 分钟内发布移除/回滚 release。
- 非 critical 质量或许可证待复核：validation 终态事务以服务端 UTC 写 `risk_review_due_at=now()+24h`，立即禁止新 release 引用并告警；catalog/turn create 每次直接比较该 deadline，逾期阻止新 turn。`skill-risk-deadline` sweeper 每分钟用 `(risk_status,risk_review_due_at)` 索引分页 claim，按 package revision CAS 写一次 `risk_blocked_at` 和审计/outbox；它只持久化已生效的阻断，不是安全正确性的唯一触发器。
- validation 队列 P95 等待超过 5 分钟、running lease 接管持续升高、quarantine 过期对象积压或 release publish 冲突突增均告警。

## 5. 监控指标

| 指标                     | 维度                      | 告警建议                         |
| ------------------------ | ------------------------- | -------------------------------- |
| 生成成功率               | model/skill/provider      | 低于 92%                         |
| P50/P95 等待时长         | task type/provider        | 超出基线                         |
| Provider 错误率          | provider/model/error_code | 连续 5 分钟异常                  |
| 回执未知率               | provider/model            | 超过 1-3%                        |
| 账本不一致数             | user/global               | 大于 0                           |
| 单任务成本               | model/task type           | 超过配置上限                     |
| 单小时总成本             | provider/global           | 超过预算                         |
| 退款率                   | skill/model               | 超过 5%                          |
| 申诉率                   | skill/model               | 异常升高                         |
| Worker heartbeat         | worker type               | 45 秒未更新                      |
| 批量部分失败率           | batch/sku/provider        | 超过 10% 或连续升高              |
| 套图部分失败率           | suite/product/model       | 超过 10% 或连续升高              |
| 导出失败率               | export source/error_code  | 超过 5%                          |
| 导出过期积压数           | user/global               | 超过保留清理基线                 |
| 认证邮件接收率           | purpose/provider/status   | sent 比率持续下降                |
| 邮件结果未知率           | purpose/provider          | 大于 0 持续 5 分钟               |
| 邮件退信/投诉率          | provider                  | 超过服务商基线                   |
| OTP 限流命中率           | purpose/dimension         | 突增或持续异常                   |
| 悬挂邮件投递数           | provider/status           | queued 超恢复阈值                |
| 注册 finalizer 积压      | decision/error_code       | verified 未核销增加              |
| Agent turn 终局/延迟     | terminal/model/skill      | P95 超基线或终局率下降           |
| Agent guardrail 命中     | guardrail/model/skill     | 同类持续突增                     |
| Agent lease 接管         | worker/model              | 持续升高                         |
| Agent stale 写拒绝       | state/source              | 持续升高                         |
| Skill cache/drift        | skill/version/result      | drift > 0 立即告警               |
| Skill package validation | status/rule/severity      | critical > 0 或失败率突增        |
| Skill catalog publish    | result/reason             | 冲突/失败持续升高                |
| Skill revalidation age   | package/severity          | critical 立即；非 critical > 24h |
| Agent 大脑成本           | model/skill/terminal      | 超 turn/hour 预算                |

告警通知：

- beta 默认使用企业微信机器人或钉钉机器人 Webhook，对应环境变量 `ALERT_WEBHOOK_URL`。
- critical 告警必须包含环境、模块、用户/任务/trace ID、当前影响和建议动作。
- 账本不一致、Provider unknown 激增、单小时成本超预算、Worker heartbeat 丢失必须立即通知。

默认运营配置：

| 配置                         |                                                           默认值 |
| ---------------------------- | ---------------------------------------------------------------: |
| 单用户每月申诉上限           |                                                               10 |
| Agent turn 大脑平台成本预算  |                       等值 3 内部预算积分/turn；不直接写用户账本 |
| 生成前文本审核超时           |                                          10 秒，超时 fail-closed |
| 生成后图片审核超时           |                                            60 秒，超时进入隔离态 |
| 隔离产物保留期               |                                          30 天，过期进入删除队列 |
| 内容安全人工复核 SLA         |                                                          24 小时 |
| 保真 hard block 开关         |                        默认关闭；仅 S23 校准审批后按规则版本开启 |
| 积分人民币内部锚定           |                                                 1 积分 = 0.05 元 |
| outcome_unknown 自动释放时间 |                                                          30 分钟 |
| 注册赠送积分                 | 由 S14 active registration reward campaign 的版本化金额/预算裁决 |
| 邀请返积分                   |   由 S14 active invitation reward campaign 的版本化金额/预算裁决 |
| 同邮箱 + purpose 发送冷却    |                                                       60 秒 1 次 |
| 同邮箱 + purpose 发信        |                                       1 小时 5 次，24 小时 10 次 |
| 同 IP 发信                   |                                                     1 小时 30 次 |
| 同设备发信                   |                                                     1 小时 20 次 |
| 同邀请码注册发信             |                                        10 分钟 20 次并受容量约束 |
| 单 OTP 错误次数              |                                                       5 次后作废 |
| 同 identity 校验请求         |                                                    10 分钟 10 次 |
| 同 IP 校验请求               |                                                    10 分钟 60 次 |

认证限流阈值必须来自服务端配置并保留以上默认值；前端不得提交或覆盖阈值。限流响应不返回邮箱、邀请码容量或账号存在性。办公 NAT、校园网误伤通过运营可配置阈值和风险复核处理，不能移除 IP 维度。

## 6. 灰度发布

1A 发布策略：

```text
内部账号
  -> 10 名白名单
  -> 20-50 名电商卖家
  -> 100 名内测
```

放量条件：

- 首次生成成功率达标。
- 账本不一致为 0。
- Provider unknown 比率低于阈值。
- 单小时成本低于预算。
- 申诉和退款率可控。

回滚条件：

- 任一账本不一致。
- Provider unknown 激增。
- 成本超过预算。
- 内容安全误放严重。
- 用户无法完成核心闭环。

紧急关闭路径：

- 关闭新任务提交。
- 熔断单模型。
- 关闭注册赠送。
- 冻结风险账户。
- 关闭分享/下载导出。

## 7. 环境门禁

部署拓扑、工程目录、本地开发和中国内测部署由 `10-engineering-architecture-and-deployment.md` 裁决；本文只定义验证和运营门禁。

| 环境       | 用途       | 数据与邮件                                                                 |
| ---------- | ---------- | -------------------------------------------------------------------------- |
| local      | 本地开发   | Docker PostgreSQL/Redis、本地 uploads、Fake Provider、console/可选 Mailpit |
| test       | 自动化测试 | 隔离数据库/Redis、Fake Provider、FakeMailAdapter                           |
| staging    | 集成验证   | 测试密钥/资产、真实邮件和 Provider 受控 smoke                              |
| beta       | 内测生产   | 中国香港云服务器优先、真实用户、真实邮件/Provider、预算上限                |
| production | 公测/付费  | 法务、真实邮件和全部上线门禁完成后启用                                     |

production 出现 test adapter、测试数据库名、业务进程消费 `TEST_*` 或共享测试 Redis prefix 时启动失败。

要求：

- 不同环境密钥隔离。
- staging 必须先跑 DB migration dry-run、`pnpm typecheck/lint/test`、`pnpm validate:stage0` 和 fake Provider 闭环。
- staging 如接真实 Provider，只能使用测试密钥或封闭 PoC 预算。
- beta 可使用真实 Provider，但必须有预算上限。
- production 不得在法务门禁未完成前开放支付。
- 面向中国用户时，beta 默认按 `10` 的中国香港部署拓扑执行；production 是否迁移大陆由 `10` 和 `08` 的合规门禁裁决。

S07 Provider 环境门禁：

- test 只允许确定性 fake adapter，发现真实 Provider Key、非 loopback endpoint 或网络调用即失败。
- local 默认 fake；真实 PoC 只能由独立 `poc:*` 命令启用，要求 endpoint/region allowlist、显式成本确认和调用上限，不能由普通 Worker 启动顺带触发。
- staging/beta 的真实 route 只允许 `models.status=poc_passed` 的精确版本；缺内容审核、circuit 数据库真相、Redis 配额控制、小时成本预算或 secret 时 fail closed。
- production 在 S14 Provider Key 控制面、S15 安全/部署门禁和人工成本审批完成前，Provider 收费 route 必须保持关闭。
- Provider Redis 配额不可用时不得退化为进程内计数；新的真实 submit 拒绝，accepted/polling 的查询恢复按数据库状态继续。

S08 Agent 环境门禁：

- test 只允许 deterministic fake Agent Brain 和 test-only fake tools，禁止网络。测试数据库必须与开发库不同且名称含 `_test`，Redis 使用唯一 `s08-test-<run_id>` prefix；只按 test run ID 精确清理，禁止 drop/reset/recreate、`FLUSHALL` 或 `FLUSHDB`。
- local 普通 `pnpm dev` 默认 fake。真实 Agent Brain 的 PoC 与公网激活遵循 S07/S11：必须等待 S14 独立管理控制面完成模型/Key/endpoint/预算配置和审批，之后才能由 `poc:agent-brain` 在调用上限、人工确认和静态 adapter/model allowlist 下运行。
- staging/beta/production 不允许 fake Agent Brain、test tool、任意 URL adapter、客户端 model/Key 选择或未审批 model snapshot。缺 S14 审批、secret、预算、熔断/配额控制或 strict tool calling 能力时 Agent route/readiness fail closed。
- S11-S13B 的工程和自动化测试可以使用 fake，但仍须消费 S14A 发布的受控 catalog 与完整 snapshot，不能用 fake 绕过产品模型选择；beta/production 上线必须同时具有真实 Agent Brain PoC、质量黄金集、成本证据和管理审批，fake 结果不能替代。
- Redis Skill cache 故障允许读取 DB snapshot 并告警；DB snapshot 不可用、hash 漂移或发布包不匹配时当前 turn fail closed。Redis queue 丢失按 S05/S08 从 DB intent 恢复，不扩大 action space。

### 7.1 S03 认证与邮件门禁

- local 不购买腾讯 SES；`MAIL_PROVIDER=console` 跑全真业务链路，可选固定版本 Mailpit 检查邮件 HTML。test 只允许 FakeMailAdapter，OTP 通过测试适配器读取，禁止调试 HTTP 接口返回验证码。
- staging/beta/production 只允许已配置的真实邮件适配器；缺密钥、默认 secret、错误 `APP_ENV`、console/fake 或受信代理配置不匹配必须启动失败。
- Redis 不可用时注册、重发、OTP 校验、密码重置和新的密码登录统一 fail closed 并告警；已有合法 session 的只读请求可继续。禁止退化为进程内限流或无限密码尝试。
- 恢复扫描处理超过短阈值仍为 `mail_deliveries.queued` 的记录：只有能证明未离开本机才可重试，否则转 `outcome_unknown`，不得自动发第二封。
- 拿到真实邮件账号后，staging 必须完成受控邮箱的注册验证和密码重置 smoke，检查 `email_verified_at`、旧 session 撤销、投递状态、到达时延、SPF/DKIM/DMARC、模板和退信/投诉观测能力。
- 腾讯 SES webhook/查询能力、验签材料、去重 ID、地域、模板和配额必须先 spike；若平台能力不满足退信/投诉观测，production 门禁失败并评估同区域适配器。
- 未完成真实邮件 smoke 不阻塞 local S03 业务实现和测试，但阻塞 beta/production 上线；不得把 mocked SDK 测试描述为真实投递验收。

### 7.2 备份、恢复与 Redis 全丢演练

Beta 初始目标需在上线评审时再次确认：

| 数据         | RPO                                 | RTO                | 验收方式                                             |
| ------------ | ----------------------------------- | ------------------ | ---------------------------------------------------- |
| PostgreSQL   | 24 小时以内；真实资金上线前必须收紧 | 4 小时以内         | 加密备份恢复到隔离环境，执行关键查询与 ledger replay |
| 对象存储     | 按版本和生命周期裁决                | 4 小时内恢复读取   | manifest 抽样校验 hash、大小、权限和签名 URL         |
| Redis/BullMQ | 不作为业务 RPO                      | 2 小时内重建控制面 | 从 DB intent/outbox 恢复且不重复 Provider 投递       |

- 只有备份文件而没有成功恢复演练视为门禁失败；至少按季度在隔离环境恢复 PostgreSQL。
- 24 小时 PostgreSQL RPO 不是资金产品承诺。Beta 一旦产生真实付费积分、账本或用户付费数据，必须明确批准该风险或启用 WAL/PITR 并收紧 RPO。
- Redis 全量丢失演练必须覆盖 pending、dispatched、accepted/polling 和 outcome_unknown：pending 与仍需执行的 dispatched job 可恢复，终态不重跑，accepted/polling/outcome_unknown 不重投 Provider。
- 演练通过删除唯一测试 `REDIS_PREFIX` 下的 BullMQ key 与 recovery sentinel 模拟丢失，禁止在共享或非隔离 Redis 执行 `FLUSHALL`/`FLUSHDB`。
- reconciler 必须在数据库 session advisory lock 下成为唯一 owner，完成全量分页核对后才写 sentinel；中途崩溃应可被下一实例接管。
- sentinel 缺失期间 queue control-plane readiness 必须失败，禁止新的生成/收费写流量；只读、诊断和恢复流程可继续。
- S05 的 `queue_dispatch_intents` dispatcher/sweeper 未交付前，不得宣称 Redis 全丢后任务可完整恢复。

## 8. 最小运营看板

必需卡片：

- 今日生成任务数。
- 成功率。
- 失败率。
- Provider unknown 数。
- 当前冻结积分。
- 账本不一致数。
- 单小时成本。
- 申诉待处理数。
- Worker 在线状态。
- 熔断中的模型。
- 批量运行数、条目成功/失败/部分完成数。
- 套图运行数、分组成功/失败/部分完成数。
- 导出队列长度、失败数、过期未清理数。

## 9. 故障手册

### 管理请求参数诊断（2026-10-02）

管理 API 的 schema 校验失败记录 `admin_request_invalid`：request ID、HTTP method、注册 route 和最多八项字段路径/校验类别。不记录请求体、输入值、Zod 原文、Key 或 Provider 回执。模型列表错误仍用 `admin_model_probe`；前者表示尚未进入 Provider 探测，不能误报模型能力或上游故障。

### Provider 大量失败

1. 熔断对应模型。
2. 停止新任务。
3. 检查错误分类和供应商状态。
4. 对 `not_dispatched` 任务允许重试。
5. 对 `accepted/outcome_unknown` 任务进入人工处理。

S14 前人工恢复 open 或租约已过期/无有效租约的 half-open circuit 使用 `pnpm ops:recover-provider-circuit`，必须在受控交互终端输入 scope key、expected revision、操作者和原因并二次确认；有效租约内的 half-open 必须拒绝恢复，禁止手工 SQL、命令行参数或绕过 CAS。恢复失败不得反复覆盖 revision。

### 账本不一致

1. 立即停止新收费任务。
2. 导出 ledger replay 报告。
3. 找到首条不一致流水。
4. 禁止直接改余额。
5. 使用人工冲正流水修复。

### 成本异常

1. 熔断高成本模型。
2. 检查模型配置和计价版本。
3. 检查是否重复投递。
4. 暂停高风险 Skill。
5. 更新积分配置前需产品确认。

单个 model snapshot 的小时预算命中只熔断该 model scope；只有 Provider 级鉴权、配额或跨模型故障证据才能熔断整个 Provider，避免一个高成本模型误伤同厂商其它能力。

### 回执未知激增

1. 检查 Provider 回调和轮询。
2. 检查 Webhook 验签和队列。
3. 暂停自动提交新任务。
4. 人工处理已受理任务。
5. 自 unknown attempt 的服务端 `ended_at` 起满 30 分钟，自动释放该 task 对应的未结算冻结；进入 unknown 后的回执（含 30 分钟内）只记异常证据，不改变释放期限，也不等待人工核对。

### 内容安全误拦或漏拦

1. 标记样本。
2. 暂停相关导出。
3. 调整审核供应商或策略。
4. 保留用户通知和申诉入口。

### Redis 控制面不可用

1. 立即阻断新的注册、OTP、密码重置和密码登录，返回 `AUTH_TEMPORARILY_UNAVAILABLE`。
2. 保留已有合法 session 的只读访问，不开放新的生成或收费动作降级路径。
3. 检查 Redis 连接、认证、容量和主从状态，触发认证不可用告警。
4. 恢复后验证限流窗口、ticket/claim 与数据库真相一致，再解除门禁。
5. 禁止使用单进程 Map 或关闭限流作为临时恢复方案。

### 邮件 queued 或 outcome_unknown 激增

1. 暂停新注册邮件或提高前端可见的暂不可用状态，不宣称“验证码已发送”。
2. 检查 adapter、网络、服务商配额和 `mail_deliveries` 状态。
3. 仅对明确 `not_dispatched` 执行有界短重试；accepted/outcome_unknown 禁止自动重发。
4. 恢复扫描把无法证明未投递的悬挂 queued 收敛为 `outcome_unknown`。
5. 用户冷却结束后可明确请求新 OTP；该请求轮换旧 OTP/ticket 并重新执行全部限流。

## 10. 内测指标

| 指标                | 目标                 |
| ------------------- | -------------------- |
| 内测用户            | 20-50 名电商卖家起步 |
| 新用户 24h 首次成功 | >= 40%               |
| 首次生成成功率      | >= 92%               |
| D7 留存             | 观察，目标 >= 25%    |
| 退款率              | <= 5%                |
| 账本不一致          | 0                    |
| 白底精修闭环完成率  | 建立基线             |
| 指令编辑复用率      | 建立基线             |
| 愿付费信号          | 访谈和行为双记录     |

## 11. 自媒体反馈

自媒体反馈不改 PRD，只进入运营记录：

- 来源渠道。
- 用户画像。
- 使用场景。
- 失败样例。
- 愿付费表达。
- 需求标签。
- 是否影响阶段计划。

每周形成一份内测反馈摘要，作为 1B/2A 排期输入。
