# SPEC 开发任务规格索引

| 项     | 内容                                                                            |
| ------ | ------------------------------------------------------------------------------- |
| 状态   | v0.2 S13A/S13B 与 S14A/S14B 拆分回写后待复审                                    |
| 基准   | PRD v1.10 + 阶段 0 文档 01-10                                                   |
| 目的   | 把 PRD 和架构契约拆成可交给 AI/工程师独立实现、独立测试、独立评审的最小开发任务 |
| 不包含 | 直接编码、临时改表、绕过上游文档裁决                                            |

## 1. SPEC 的位置

项目文档按以下层级使用：

```text
PRD 产品需求
  -> 01-10 阶段 0 架构/数据/API/UI/运维契约
  -> research 成熟产品证据与采用/拒绝决策（辅助，不改变裁决顺序）
  -> SPEC 开发任务规格单
  -> 代码实现、测试、评审
```

SPEC 不重新裁决产品边界和工程架构。若 SPEC 与上游文档冲突，按 `docs/README.md` 的裁决规则处理，并优先修改 SPEC。

拆分顺序必须是：

```text
全项目开发总计划
  -> 任务组 README
  -> 单个最小 SPEC
  -> 编码与测试
```

全项目开发总计划见：[00-master-development-plan.md](./00-master-development-plan.md)。

## 2. SPEC 拆分原则

- 每个 SPEC 是一个可独立交付的最小任务单，必须能被一个开发会话读懂、实现、测试和评审。
- “最小”指最小完整交付闭环，不是最小函数、最小接口或最小页面。当前全项目主计划为 25 个完整 SPEC，其中 1A 封闭内测上线固定为 15 个完整 SPEC。
- SPEC 是全流程任务，不按“只后端/只前端/只 UI”机械切割；同一个业务闭环涉及前端、后端、数据库、队列、测试、监控时，应在同一 SPEC 写清各自范围。
- 正式 SPEC 预计 2-5 个开发日；超过 5 天才允许拆分，少于半天的小功能应合并到同一业务 SPEC。
- UI 设计进入对应业务 SPEC 的“前端/UI 交付”章节；跨页面的设计系统、组件规范、视觉基线可单独拆 `UI-SPEC`。
- 涉及正式产品 UI 的 SPEC 必须读取 `docs/research/01-full-site-product-interaction-benchmark.md` 和主计划 §8，引用页面族 ID、Stitch 评审稿及正反状态；不得在编码时新增核心页面或确认步骤。
- 不允许 SPEC 私自扩展字段、状态、错误码、队列 payload。新增项必须先回写 `04/05/06/07/10` 等上游文档。
- 不允许把 1A 做成画布 Agent。1A 的第一入口始终是对话 Agent，画布只作为后续工作流模块。

## 3. 每份 SPEC 必须包含

```text
1. 基本信息
   - SPEC ID、标题、状态、所属阶段、来源文档、优先级

2. 开工前必读
   - 必须读取的 PRD/阶段 0 文档章节
   - 必须读取的上游 SPEC 或已有代码模块

3. 当前模块范围
   - 本次要实现什么
   - 明确不实现什么

4. 交付面
   - 后端/API
   - 前端/UI
   - 数据库/迁移
   - Worker/队列/Cron
   - Provider/外部服务
   - 测试/验收脚本
   - 监控/日志/审计

5. 接口、函数与数据契约
   - API 路由、Service/函数名建议
   - 入参、出参、错误码
   - 数据表、字段、枚举、索引、幂等键

6. 业务规则与异常
   - 权限、费用、状态流转、重试、超时、取消、退款

7. 测试标准
   - 单元测试
   - 集成测试
   - E2E/UI 测试
   - 回归验收脚本
   - 必须列出测试文件建议路径、测试库、关键用例名

8. 验收清单
   - 可人工核对的完成标准
```

## 4. 测试库与命令基线

所有 SPEC 默认使用 `10` 裁决的测试体系，不得在单个任务里临时换测试库。

| 测试类型            | 默认库/工具                          | 默认命令                                           | 适用范围                                           |
| ------------------- | ------------------------------------ | -------------------------------------------------- | -------------------------------------------------- |
| TypeScript 类型检查 | `tsc --noEmit` 或框架内置 typecheck  | `pnpm typecheck`                                   | 全工程                                             |
| 单元测试            | `Vitest`                             | `pnpm test`                                        | service、纯函数、编译器、账本规则、Provider 适配器 |
| 前端组件测试        | `Vitest` + Testing Library           | `pnpm test`                                        | React 组件、hooks、表单状态、状态映射              |
| API 集成测试        | `Vitest` + Supertest                 | `pnpm test:integration`                            | NestJS controller、guard、service 与数据库事务     |
| 浏览器 E2E/UI       | `Playwright`                         | `pnpm test:e2e`                                    | 登录、对话、积分阻断、SSE、结果页、运营后台        |
| DB/迁移校验         | Drizzle migration check + 自定义脚本 | `pnpm db:check`                                    | schema、索引、唯一约束、账本 replay                |
| 队列/Worker 集成    | `Vitest` + Redis/BullMQ 测试环境     | `pnpm test:worker`                                 | job 幂等、重试、heartbeat、settlement              |
| 压测/并发           | `k6`，若本地安装困难可用 `Artillery` | `pnpm test:load`                                   | turn 创建、quote 提交、SSE、worker 消费            |
| 阶段验收脚本        | `09` 指定脚本                        | `pnpm validate:*`                                  | 资金异常、Provider PoC、部署 smoke                 |
| 格式与静态检查      | Prettier + ESLint + TypeScript       | `pnpm format:check`、`pnpm lint`、`pnpm typecheck` | 全工程和包边界                                     |
| 本地提交门禁        | Husky + lint-staged + commitlint     | `git commit` / `pnpm commit`                       | 暂存文件和 Conventional Commits                    |

SPEC 的“测试标准”必须按涉及范围写清：

- 测试文件建议路径，例如 `packages/credit/src/reservation.service.spec.ts`。
- 至少 3 类用例：正常路径、异常路径、幂等/并发路径。
- 涉及资金、权限、Provider 回执、SSE 恢复的任务必须有集成测试，不接受只写 mock 单测。
- 前端任务必须包含至少一个用户视角 E2E 或组件状态测试。
- 修改数据库约束或索引的任务必须补 DB 校验或迁移回滚说明。

### 4.1 代码审查、用户验收与提交门禁

每个 SPEC 必须按以下顺序关闭：

1. 完成实现、测试和该 SPEC 要求的验证命令。
2. Codex 审查完整工作区 diff，重点检查契约一致性、失败路径、资损、权限、幂等、并发、迁移和测试覆盖。
3. 修复全部阻塞发现并重新运行受影响的验证；有未修复问题或必需检查未运行时不得报告通过。
4. Codex 明确输出“代码审查通过”，并列出已执行验证与残余风险。
5. 等待用户验收；代码审查通过不等于用户验收通过。
6. 只有用户明确回复验收通过后，才允许暂存并执行 `git commit`；未经授权不得合并或推送。

若用户验收发现问题，任务回到第 1 步，修复后必须重新代码审查，不沿用上一次通过结论。

## 5. SPEC 目录

| 来源文档 | SPEC 索引                                                            | 状态        |
| -------- | -------------------------------------------------------------------- | ----------- |
| 全项目   | [00 全项目开发总计划与 SPEC 拆分树](./00-master-development-plan.md) | v0.5 待复审 |

后续拆分以 `00-master-development-plan.md` 的任务组和依赖顺序为准。

## 6. 完整 SPEC 文件

### 1A 封闭内测上线

S13、S14 各保留一个主编号，但因范围超过单个 SPEC 的 5 日上限，分别拆为可独立评审、验收和提交的 A/B 子 SPEC；因此下表有 17 个交付行，但仍是 S01-S15 共 15 个主编号。

| SPEC | 任务                               | 文件                                                                                                                 |
| ---- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| S01  | 工程 Bootstrap 与本地开发环境      | [S01-engineering-bootstrap-and-local-dev.md](./S01-engineering-bootstrap-and-local-dev.md)                           |
| S02  | 数据库 Schema、迁移与索引          | [S02-database-schema-migration-and-indexes.md](./S02-database-schema-migration-and-indexes.md)                       |
| S03  | 鉴权、邀请内测与用户基础           | [S03-auth-invite-beta-and-user-foundation.md](./S03-auth-invite-beta-and-user-foundation.md)                         |
| S04  | 积分账本、报价与交易闭环           | [S04-credit-ledger-quote-and-transaction.md](./S04-credit-ledger-quote-and-transaction.md)                           |
| S05  | Workflow、队列、Worker 与事件底座  | [S05-workflow-queue-worker-and-event-outbox.md](./S05-workflow-queue-worker-and-event-outbox.md)                     |
| S06  | SSE 实时状态与断线恢复             | [S06-sse-realtime-state-and-recovery.md](./S06-sse-realtime-state-and-recovery.md)                                   |
| S07  | Provider Gateway、PoC 与成本核算   | [S07-provider-gateway-poc-and-cost.md](./S07-provider-gateway-poc-and-cost.md)                                       |
| S08  | Agent Turn、Skill 运行时与循环保护 | [S08-agent-turn-skill-runtime-and-loop-guard.md](./S08-agent-turn-skill-runtime-and-loop-guard.md)                   |
| S09  | 确定性编译器、R1-R5 与计划校验     | [S09-deterministic-compiler-r1-r5-and-plan-validation.md](./S09-deterministic-compiler-r1-r5-and-plan-validation.md) |
| S10  | 商品/SKU、事实集与资产/产物组织    | [S10-product-sku-facts-assets-and-artifacts.md](./S10-product-sku-facts-assets-and-artifacts.md)                     |
| S11  | 1A Agent 工作台与首版 Skill 闭环   | [S11-agent-workbench-ui-loop.md](./S11-agent-workbench-ui-loop.md)                                                   |
| S12  | 图片执行、安全审核与发布公共管线   | [S12-commerce-white-background-refine-e2e.md](./S12-commerce-white-background-refine-e2e.md)                         |
| S13A | 创意生图公共闭环与本会话改图       | [S13-creative-generation-and-chat-edit-e2e.md](./S13-creative-generation-and-chat-edit-e2e.md)                       |
| S13B | 首版专门创意 Skill 真实闭环        | [S13B-first-release-specialized-creative-skills-e2e.md](./S13B-first-release-specialized-creative-skills-e2e.md)     |
| S14A | 生图内测最小控制面                 | [S14-user-center-and-minimal-admin-console.md](./S14-user-center-and-minimal-admin-console.md)                       |
| S14B | 完整运营管理台                     | [S14B-complete-operations-admin-console.md](./S14B-complete-operations-admin-console.md)                             |
| S15  | 安全合规、验收脚本与中国/HK 上线   | [S15-security-validation-china-hk-launch.md](./S15-security-validation-china-hk-launch.md)                           |

### 1B 到 3b 后续阶段

| SPEC | 任务                          | 文件                                                                                                           |
| ---- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| S16  | 1B 视频与长任务能力           | [S16-video-and-long-running-task-capability.md](./S16-video-and-long-running-task-capability.md)               |
| S17  | 1B 创意质量版本与高清工具扩展 | [S17-creative-skills-and-upscale-expansion.md](./S17-creative-skills-and-upscale-expansion.md)                 |
| S18  | 1B 批量处理与生成记录导出     | [S18-batch-processing-and-record-export.md](./S18-batch-processing-and-record-export.md)                       |
| S19  | 2A 创意分享与邀请增长         | [S19-creative-sharing-and-referral-growth.md](./S19-creative-sharing-and-referral-growth.md)                   |
| S20  | 2A 配方模板市场与参考图库     | [S20-recipe-template-market-and-reference-gallery.md](./S20-recipe-template-market-and-reference-gallery.md)   |
| S21  | 2A 会员中心与运营后台增强     | [S21-membership-center-and-admin-enhancement.md](./S21-membership-center-and-admin-enhancement.md)             |
| S22  | 2B 套图流水线                 | [S22-commerce-suite-pipeline.md](./S22-commerce-suite-pipeline.md)                                             |
| S23  | 2B 平台规范与保真升级         | [S23-platform-spec-and-fidelity-upgrade.md](./S23-platform-spec-and-fidelity-upgrade.md)                       |
| S24  | 3a 画布第一刀                 | [S24-canvas-first-cut-node-editing-version-history.md](./S24-canvas-first-cut-node-editing-version-history.md) |
| S25  | 3b 画布第二刀                 | [S25-canvas-chain-run-and-template.md](./S25-canvas-chain-run-and-template.md)                                 |
