# S02 数据库 Schema、迁移与索引

| 项     | 内容                                                    |
| ------ | ------------------------------------------------------- |
| 状态   | v0.1 可评审                                             |
| 阶段   | 1A / D1                                                 |
| 优先级 | P0                                                      |
| 目标   | 按 `05` 实现 Drizzle schema、迁移、索引、约束和 DB 校验 |

## 开工前必读

- `docs/05-data-model-and-constraints.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`

## 当前模块范围

实现 1A 所需全部表结构及后置表占位。不得临时删减 `05` 已裁决字段。

在创建任何 `numeric` 字段前，先在 `packages/shared` 建立基于 `decimal.js` 的金额工具。金额输入输出使用规范化字符串，统一保留 2 位小数并采用 `ROUND_HALF_UP`；业务包不得直接依赖 `decimal.js` 或使用 `number` 做金额运算。

不包含业务 API、页面、Provider。

## 交付面

| 交付面   | 要求                                                     |
| -------- | -------------------------------------------------------- |
| 数据库   | Drizzle schema、migration、枚举、唯一约束、外键、索引    |
| 后端/API | 仅提供 DB client 和 repository 基础封装                  |
| 共享工具 | 金额解析、规范化、运算、比较和舍入；无 DB 或环境变量依赖 |
| 测试     | 空库向前迁移、索引存在、唯一约束、ledger replay 基础     |

## 数据契约

必须逐表覆盖 `05` 中以下 1A 表，不以笼统分类代替建表清单：

- 用户与鉴权：`users`，以及 Better Auth 管理的 session/account/verification 表。
- 邀请与风控：`invite_codes`、`invite_code_redemptions`、`referrals`、`user_activity_logs`。
- 积分交易：`credit_accounts`、`credit_ledger`、`credit_reservations`、`run_quotes`、`appeals`。
- 工作流执行：`workflow_runs`、`tasks`、`task_attempts`、`worker_heartbeats`、`event_outbox`。
- 对话 Agent：`chat_sessions`、`chat_messages`、`agent_turns`、`agent_traces`、`agent_trace_steps`、`skill_resource_snapshots`。
- 商品与资产：`products`、`product_fact_sets`、`asset_folders`、`assets`、`artifacts`、`artifact_evaluations`、`risk_confirmations`。
- 能力与运营：`skills`、`models`、`admin_audit_logs`。

`05` 中标注为后置阶段的表仍需提供占位 migration 或清晰的后置声明，但不得混入 1A 业务代码。

迁移只允许向前执行；本 SPEC 不生成生产回滚或 down migration。测试通过创建隔离的临时空库验证从零迁移，且只清理测试自己创建的随机数据库。

## 测试标准

- `packages/db/src/schema.spec.ts`：枚举和关键字段存在。
- `packages/db/src/schema.spec.ts` 必须断言 `artifact_visibility` 包含 `quarantined`，并覆盖其与 `artifact_evaluations` 的关联字段。
- `packages/db/src/migrations.spec.ts`：空库迁移成功。
- `packages/db/src/indexes.spec.ts`：Top 查询索引存在。
- `packages/db/src/ledger-replay.spec.ts`：账本投影可回放。
- `packages/shared/src/money.spec.ts`：覆盖金额正常值、非法输入、边界舍入、运算和比较；运行时拒绝 `number`。

## 验收清单

- [ ] `pnpm db:migrate` 成功。
- [ ] `pnpm db:check` 成功。
- [ ] 上述 1A 表及 `05` 裁决字段无遗漏。
- [ ] 关键唯一约束和索引可被测试证明。
- [ ] 所有 Drizzle `numeric` 列以 string 读写，金额运算只使用 `packages/shared` 工具。
