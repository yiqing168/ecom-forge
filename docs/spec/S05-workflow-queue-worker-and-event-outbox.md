# S05 Workflow、队列、Worker 与事件底座

| 项     | 内容                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| 状态   | v0.3 实现完成待验收                                                                                         |
| 阶段   | 1A / D2                                                                                                     |
| 优先级 | P0                                                                                                          |
| 目标   | 实现 workflow/task/attempt 持久化访问、BullMQ 投递底座、Worker 生命周期、event outbox 与 Redis 可重建控制面 |

## 开工前必读

- `docs/01-architecture-and-transaction-contract.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/spec/S04-credit-ledger-quote-and-transaction.md`
- `docs/spec/S06-sse-realtime-state-and-recovery.md`

## 1. 依赖与职责边界

主线实现顺序为 `S03 -> S05 -> S04 -> S06`。因此本轮只冻结并实现可被后续业务复用的执行底座，不提前伪造资金、Provider、Agent、素材或 SSE 闭环。

### 1.1 本轮包含

- `workflow_runs/tasks/task_attempts` 的 repository、状态 guard 和按当前用户过滤的只读查询基础。
- `packages/queue` 的队列名、公共 payload envelope、判别联合 schema、稳定 job ID 和连接装配。
- `queue_dispatch_intents` 的创建端口、dispatcher、sweeper、owner-safe lease、退避和 poison intent 收敛。
- Redis 全量丢失后的 reconciliation sentinel、唯一恢复 owner 和 `dispatched` intent 重建。
- `event_outbox` 的同事务 append、scope 内单调 `event_seq` 分配和按 seq 查询 primitive。
- `task_attempts.attempt_no` 的并发安全分配 primitive；本轮不调用真实 Provider。
- Worker heartbeat、SIGTERM drain、超时退出与恢复接管。
- 只推进测试数据的 workflow/task test processor，用于证明重复消费、恢复和状态 guard；仅 `APP_ENV=test` 注册，其他环境不得存在该处理器。

### 1.2 本轮不包含

- S04 的 quote、reservation、结算、释放、退款和资金最终裁决。
- S08 的 Agent turn/工具循环，S07/S10 的真实 evaluation/asset processor，真实 Provider 投递、回调和轮询。
- S06 的 SSE endpoint、Redis pub/sub fanout、前端 `last_event_seq` 重连和 watchdog。
- `agent/asset/evaluation/settlement` 的真实业务 processor；本轮仅消费 `06` 已定义的 payload 契约测试，不能宣称这些能力可用。
- `provider-callback` 与 `notification` 本轮只保留队列名，不冻结业务 payload：分别由 S07、S16 回写 `06` 后才加入判别联合并激活 Producer/Consumer。

### 1.3 cancel/retry 分阶段交付

- S05 提供 workflow 状态校验、目标 task 校验、取消/重试 orchestration port 和测试夹具，不开放缺少资金动作的半成品写接口。
- `POST /api/v1/workflow-runs/{run_id}/cancel` 与 `POST /api/v1/workflow-runs/{run_id}/retry` 由 S04 接入 Credit 服务后才对外激活。
- S04 必须完成 reservation 释放、人工处理、新 quote/新冻结和 ledger/event_outbox 同事务语义；S05 不得用临时状态绕过这些动作。

## 2. 既有数据模型

`workflow_runs`、`tasks`、`task_attempts`、`event_outbox`、`worker_heartbeats` 已由阶段 0 migration 创建；`queue_dispatch_intents` 已由 S03 的前向 migration 创建。S05 必须先复用既有 schema，不重复建表、不修改历史 migration。

只有在实现审查证明既有字段或约束无法满足本 SPEC 时，才允许先回写 `05`，再用 Drizzle 生成新的向前 migration。禁止手写删库、重建库或 destructive reset。

数据库访问统一封装在 Drizzle repository/transaction；PostgreSQL advisory lock 只允许通过集中、参数化的数据库 helper 调用，不散落业务 SQL，不提供独立 SQL 脚本修改或清理业务数据。

`queue_dispatch_intents` 与 `event_outbox` 职责独立：前者保证已提交业务任务最终进入 BullMQ，后者记录可供详情/SSE 恢复的用户可见事件。两者分别幂等、分别恢复，不能互相替代。

## 3. 交付面

| 交付面           | 要求                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/queue` | queue 常量、公共 envelope、`06` 已定义 job type 的 schema、job ID helper、BullMQ connection factory 与契约测试           |
| `apps/api`       | workflow/task 当前用户只读查询、outbox/intent application port、queue readiness；Controller 薄层，不在事务内调用 Redis   |
| `apps/worker`    | dispatcher/sweeper/reconciler、test processor、heartbeat、drain、typed config 与结构化日志                               |
| 数据库访问       | Drizzle repository、短事务、行锁/advisory lock、owner CAS；优先复用既有表                                                |
| 测试与脚本       | 单元、真实 PostgreSQL/隔离 Redis 集成、并发/崩溃反例、`validate:worker-recovery` 与 S05 范围内的 `validate:webhook-lost` |

本轮对外接口固定为：

- `GET /api/v1/workflow-runs/{run_id}`：S05 基础快照，费用/产物字段按 `06` 保持 `null`/空数组。
- `GET /api/v1/tasks`：当前用户稳定 cursor 分页。
- `GET /api/v1/health/live` 与 `GET /api/v1/health/ready`：存活和 queue control-plane 就绪探针；保留既有 `/health` 兼容入口。

cancel/retry 只交付内部 port，不注册公网写路由。

## 4. 队列与 payload

队列名固定为：

- `workflow`
- `task`
- `provider-callback`
- `agent`
- `asset`
- `evaluation`
- `notification`
- `settlement`
- `moderation`（S12 生成后图片审核；S05 仅冻结名称，所属 SPEC 激活 Consumer）

所有 job payload 必须扩展 `06` 的公共 envelope：

```json
{
  "schema_version": 1,
  "job_type": "task.execute",
  "trace_id": "uuid"
}
```

规则：

- `packages/queue` 从 `unknown` 解析判别联合；Producer 与 Consumer 共用同一 schema。
- 未支持的 `schema_version/job_type` fail closed，intent 转 `cancelled` 并告警，不允许形成无限 poison 重试。
- payload 只携带持久化 ID、版本和必要路由字段；禁止密钥、二进制、完整 prompt、对象 key、签名 URL 或任意未经裁剪的数据库实体。
- payload 中的 `user_id` 只用于路由/诊断，Consumer 必须从 workflow/task 聚合重新校验 owner，不能把 payload 当作授权真相。
- 本轮真实消费只启用 `workflow`/`task` test job；其他 schema 只做契约测试，由所属 SPEC 激活 processor。
- test processor 必须由 typed config 强制限定 `APP_ENV=test`；local/staging/beta/production 不注册，且错误启用时启动失败。
- `provider-callback` 与 `notification` 在 S07/S16 回写前不得创建 `queue_dispatch_intents`；任何对应的未定义 job type 均按未知类型 fail closed，不能由实现临时补字段。

### 4.1 稳定 job ID

- BullMQ 自定义 job ID 禁止包含 `:`；禁止随机 job ID。
- task 首次执行直接使用 `task_id`；明确创建新 attempt 后使用 `task_attempt_id`。
- 其他单一聚合优先使用其 UUID；复合业务键使用 canonical payload hash 的 base64url/hex 表示，只允许 `[A-Za-z0-9_-]`。
- `queue_name + job_id` 必须与 `queue_dispatch_intents` 唯一约束一致；相同业务动作重放产生同一 job ID。
- `aggregate_id` 始终保存该 intent 的主持久化聚合 UUID，与可为 canonical hash 的 `job_id` 相互独立。例如 export 任务使用 `aggregate_type=export_job`、`aggregate_id=export_id`，job ID 可由 `export_id + operation + attempt_no` 计算；不存在主聚合 UUID 时必须先创建持久化 operation 记录，禁止把 hash 填入 UUID 字段。
- BullMQ attempts 只处理 Redis 写入或本地 processor 明确未触达外部系统的短暂失败，不代表业务重试。

## 5. outbox 与 attempt 并发规则

### 5.1 event sequence

- 业务状态与对应 `event_outbox` 必须在同一数据库事务写入。
- advisory lock 的 canonical 输入固定为 UTF-8 `${scope_type}:${lowercase_uuid}`，取 SHA-256 digest 前 8 字节并按 big-endian two's-complement 解释为 signed int64，供 `pg_advisory_xact_lock` 使用；所有调用方复用同一 helper。
- 在事务内获取锁后查询该 scope 的 `max(event_seq)` 并写入 `max + 1`；首个事件为 `1`。极低概率 hash 碰撞只会让不同 scope 保守串行，唯一约束仍是正确性兜底。
- 唯一约束 `(scope_type, scope_id, event_seq)` 是最终兜底；不得在无锁条件下先查 max 再写。
- S05 只提供 `append` 和 `listAfter(scope, last_event_seq, limit)` primitive。SSE 投影、fanout 和客户端恢复属于 S06。

### 5.2 attempt number

- 新建 `task_attempt` 时在事务内锁定目标 task 行，重新读取最新 task/attempt 状态并校验是否允许创建。
- `attempt_no = max(existing attempt_no) + 1`，首个 attempt 为 `1`；`unique(task_id, attempt_no)` 兜底并发。
- 同一 task execution intent 在 task 行锁内发现已有当前 attempt 时必须复用，不创建新 attempt；后续公网 retry 的请求幂等由 S04 接入统一写接口幂等层。
- accepted/polling/outcome_unknown 状态不得经此 primitive 自动形成新的 Provider 投递；真实投递由后续 Provider SPEC 裁决。
- S07 激活 Provider 投递时，集中 `ATTEMPT_TRANSITIONS` 必须增加 `dispatching/not_dispatched -> outcome_unknown/outcome_unknown`，以及仅在已有“请求可能写出”持久化证据时允许的 `created/not_dispatched -> outcome_unknown/outcome_unknown` 恢复迁移。该迁移仍走 repository CAS；禁止 Processor 直接更新状态。
- 集成测试必须模拟 attempt 已提交为 `dispatching` 后进程崩溃，断言恢复只收敛为 `outcome_unknown`、不创建新 attempt、Provider submit 调用次数不增加。

## 6. dispatcher 与 sweeper

### 6.1 intent 创建

- 创建 workflow/task 的事务必须同事务写入 `queue_dispatch_intents(status=pending)`；网络调用发生在提交之后。
- intent payload 在写库前通过 `packages/queue` schema 校验；`payload_version` 与 envelope `schema_version` 必须一致。
- API/领域服务只提交 intent，不直接调用 BullMQ。

### 6.2 claim 与派发

1. dispatcher 以有界 batch 使用 `FOR UPDATE SKIP LOCKED` 领取到期的 `pending` 或 lease 已过期的 `dispatching` intent。
2. 在短事务内写入不可预测的 owner token、`status=dispatching`、`lease_expires_at`，并把 `next_attempt_at` 同步设为 lease 到期时间后提交；sweeper 由此复用既有 `(status, next_attempt_at)` 索引。
3. 在事务外调用 BullMQ `add`，使用稳定 job ID。
4. 成功后以 `id + lease_owner` CAS 更新为 `dispatched` 并清空 lease；失败则 owner CAS 释放为 `pending`，增加 attempt_count，写脱敏错误码和下一次时间。
5. Redis add 成功但 DB 更新失败时，以同 job ID 重放；Consumer 仍须先查 DB 当前状态并幂等 no-op。

Consumer 的每次状态推进必须使用数据库状态 CAS：更新条件包含实体 ID、允许的旧状态和必要 version/owner，受影响行数不是 1 时重新读取并按已完成/非法迁移 no-op 或拒绝。状态变化与对应 `event_outbox` 同事务提交；禁止 Processor 采用无条件 update 或仅靠 BullMQ job 去重保证幂等。

默认每次最多 100 条，指数退避加 jitter，退避有最大值。batch、poll、lease 和退避参数由 typed config 校验，禁止无界并发。

### 6.3 poison intent

- schema/version/job type 永久非法时不得重试：intent 转 `cancelled`、写稳定错误码并触发告警。
- 聚合已终态或被取消时 Consumer no-op；intent 可保持 `dispatched` 作为审计事实，不伪造执行成功。
- lease 状态更新必须 owner CAS；过期旧 owner 不得继续推进 intent。
- 术语必须带领域前缀：`intent.status=dispatching` 表示 DB 到 BullMQ 派发租约，`attempt.status=dispatching` 表示 Provider 请求尚未确认送达；日志、指标和代码类型不得只写裸 `dispatching`。

### 6.4 dispatcher 与 sweeper 职责

- dispatcher 是高频 poller，只领取到期 `pending` intent 并执行 BullMQ add。
- sweeper 是低频恢复扫描，只寻找过期 `dispatching` lease、长期 overdue intent 和终态 no-op 候选。
- 两者必须调用同一 claim/CAS repository，不能各写一套状态更新逻辑；`SKIP LOCKED + owner CAS` 允许短暂重叠但只会产生一个有效 owner。
- Redis 全量丢失的 `dispatched` intent 不属于 sweeper，由 §7 reconciler 处理。

## 7. Redis 全量丢失 reconciliation

普通 sweeper 只能找回 pending/过期 lease，无法找回“DB 已是 dispatched、Redis job 已丢失”的意图，因此必须实现独立 reconciliation：

1. 每个 `REDIS_PREFIX` 维护版本化 recovery sentinel；sentinel 缺失表示该 Redis 控制面尚未完成 DB 对账。
2. reconciler 使用数据库 session advisory lock 竞争唯一 owner；锁占用一个专用 ops 连接，但不得开启跨 Redis 调用的数据库事务。未持锁实例只观察，不并发全量重建。
3. owner 获取锁后再次检查 sentinel，分页扫描 `dispatched` intent，并读取聚合/attempt 的数据库真相。
4. 非终态且仍需执行的本地步骤以原 queue/job ID 重建；终态、取消、过期聚合 no-op。
5. `accepted/polling` 只能重建查询或等待回调 job，`outcome_unknown` 只能重建核验/人工处理 job；任何分支都不得重新提交 Provider。
6. 完成全部分页和核对后才原子写 sentinel；中途崩溃时 sentinel 继续缺失，由下一 owner 重新执行。
7. 提供受控 ops 命令显式触发 reconciliation，并输出计数摘要，不输出 payload 敏感字段。

reconciler advisory lock 使用同一 SHA-256 -> signed int64 helper，canonical 输入为 `queue-recovery:${REDIS_PREFIX}:${recovery_schema_version}`。

sentinel 缺失期间 queue control-plane readiness 必须为失败：只读 API、健康诊断和恢复流程可运行，新的生成/收费写操作 fail closed，不得把未完成恢复的 Redis 当成可接流状态。sentinel 完成后才恢复写流量；sentinel 不设置 TTL，只有 Redis 数据丢失或 `packages/queue` 明确提升 recovery schema version 时触发新一轮全量 reconciliation。

演练只能删除本次测试唯一 `REDIS_PREFIX` 下的 BullMQ key 与 sentinel；禁止在共享或非隔离 Redis 执行 `FLUSHALL`/`FLUSHDB`。

## 8. Worker heartbeat 与 drain

默认参数：

| 参数                       | 默认值 |
| -------------------------- | ------ |
| heartbeat interval         | 15 秒  |
| heartbeat stale threshold  | 45 秒  |
| dispatcher lease           | 30 秒  |
| dispatcher lease renew     | 10 秒  |
| dispatcher poll            | 1 秒   |
| dispatcher batch           | 100    |
| dispatcher backoff base    | 1 秒   |
| dispatcher backoff maximum | 60 秒  |
| graceful drain timeout     | 30 秒  |

- Worker 每次进程启动生成一个生命周期内稳定的 UUID 作为 `worker_heartbeats.id`，按该 id 周期 upsert；重启产生新 id。
- metadata 只保存实例/版本/队列/并发等非敏感诊断摘要，不保存环境变量、payload 或用户内容。
- SIGTERM/SIGINT 顺序固定：暂停 dispatcher claim 和 Worker 领取新 job -> heartbeat 置 `draining` -> 对本实例已领取且仍在处理的 intent/job 继续续约 -> 等待 active job 完成并完成最终 CAS -> 停止续约 -> 置 `stopped` 后退出。
- 到达 drain timeout 时先停止续约并放弃后续状态写入，再退出；其他实例只能在 lease 真实过期后接管，旧实例不得在超时后继续推进。
- 超过 drain timeout 后退出并记录告警；未完成工作由 BullMQ stalled 检测、DB intent 和 reconciliation 接管。
- heartbeat 写失败不得让 Worker 静默伪装健康；持续失败必须告警，但不得中断正在进行的短数据库事务。

## 9. 可观测性与安全

- 日志使用 `trace_id/queue_name/job_id/intent_id/worker_id/task_id/attempt_id` 关联，禁止完整 payload、密钥、完整 prompt、对象 key、签名 URL 和二进制。
- 指标至少包含 dispatcher claim/add/success/failure、lease takeover、poison intent、reconciliation 扫描/重建/no-op、队列 backlog、active job、heartbeat age 和 drain timeout。
- Redis 不可用时不得接收新的生成/收费动作并伪装成功；已提交 intent 保留在 DB，恢复后有界派发。
- Worker 不直接写 consume ledger；后续 settlement processor 只能调用 `packages/credit`。

## 10. 测试标准

### 10.1 单元与契约测试

- 所有 payload 正常、未知版本、未知 job type、缺字段和敏感字段反例。
- job ID 对相同输入稳定、不同业务动作不碰撞且不含 `:`。
- 复合 job ID 与主聚合 UUID 映射正确；hash 不得写入 `aggregate_id`。
- config 默认值、非法关系（如 renew >= lease）、边界值启动失败。
- test processor 在 `APP_ENV=test` 可注册，在 local/staging/beta/production 不可注册且误配置启动失败。

### 10.2 PostgreSQL/Redis 集成测试

- 测试进程必须为 `APP_ENV=test`，并使用 `TEST_DATABASE_URL` 指向独立数据库；本地默认库名 `ecom_forge_test`，CI 可使用 `ecom_forge_test_<run_id>`。规范化后的测试 database 不得与 `DATABASE_URL` 指向同一数据库，名称不满足 `_test`/`_test_` 边界时启动失败。
- Redis 使用 `TEST_REDIS_URL` 的独立实例或逻辑 DB，并叠加每次运行唯一的 `TEST_REDIS_PREFIX=s05-test-<run_id>`；不得与开发/生产 `REDIS_URL + REDIS_PREFIX` 组合相同。Redis Cluster 不支持逻辑 DB 隔离时必须使用独立测试实例。
- 数据库不执行 drop/recreate/reset；test harness 保存本次创建的精确主键清单，并在可用的 idempotency/business key 中加入 `test_run_id` 前缀，结束时只按这些白名单 ID 删除记录。
- 同 scope 并发 append 产生从 1 开始、无缺口无重复的 event_seq。
- 同 task 并发创建 attempt 恰好一个成功/重放，attempt_no 单调。
- 当前用户可读取自己的 workflow/task；伪造 user_id 或读取其他用户资源返回统一 404/权限错误且不泄露存在性。
- 多 dispatcher 竞争时每个 intent 只有一个有效 owner；旧 owner 过期后 CAS 失败。
- 模拟 add 成功后 DB mark 失败，重放不产生第二个业务消费。
- 验证当前 BullMQ 版本对同 job ID 的 waiting/active/completed 行为；dispatcher 不依赖重复 add 覆盖 payload/options，旧 job 已清理后重新 add 仍由 Consumer DB CAS no-op 保证安全。
- pending、过期 lease、poison payload、终态 no-op 全覆盖。
- 删除隔离 prefix 后，reconciliation 恢复仍需执行的 dispatched job；终态不重跑，accepted/polling/outcome_unknown 不调用 Fake Provider。
- reconciler 在 sentinel 写入前崩溃可由新 owner 接管；完成后第二次运行无额外重建。
- sentinel 缺失时 queue readiness 失败且新生成/收费写入 fail closed；写入 sentinel 后才恢复接流。
- `/health/live` 在依赖恢复期间仍表示进程存活；`/health/ready` 在 Redis/sentinel 未就绪时返回 503，且响应不泄露连接信息。
- Worker drain 停止取新任务、允许 active job 有界完成；超时退出后由恢复机制接管。

### 10.3 验收命令

- `pnpm test:worker`
- `pnpm test:integration`
- `pnpm validate:worker-recovery`
- `pnpm validate:webhook-lost`
- `pnpm check`
- `pnpm build`

`validate:webhook-lost` 在 S05 只通过 Fake attempt 证明 accepted/polling 缺少最终回调时的恢复底座和“不重新投 Provider”反例；provider-callback 完整 payload、真实验签和 Provider 回执联调由 S07 完成。

## 11. 验收清单

- [ ] workflow/task/attempt repository 和状态 guard 可追踪、按用户隔离。
- [ ] intent 与业务任务同事务创建，dispatcher 在事务外以稳定 job ID 幂等投递。
- [ ] sweeper 可恢复 pending/过期 lease，owner CAS 阻止旧 owner 越权更新。
- [ ] Redis 全丢后 dispatched 非终态工作可从 DB 重建；终态不重跑，accepted/outcome_unknown 不重投 Provider。
- [ ] outbox 并发写入 event_seq 单调无重复，可按 `last_event_seq` 查询；未提前宣称 SSE 客户端闭环。
- [ ] attempt_no 并发分配安全，业务重试与 BullMQ attempts 分离。
- [ ] heartbeat、draining、stopped 和超时接管可观测。
- [ ] `agent/asset/evaluation/settlement` 只有已定义 schema 的契约测试，没有伪造真实业务能力；`provider-callback/notification` 在所属 SPEC 回写前不进入联合类型并 fail closed。
- [ ] 两个 validation 脚本在隔离 DB/Redis 上通过且不使用 destructive Redis/数据库命令。
- [ ] Codex 正反向代码审查通过，外部复审通过，用户验收后才允许提交。
