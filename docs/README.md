# AI 创作平台文档索引

| 项         | 内容                                                     |
| ---------- | -------------------------------------------------------- |
| 文档集版本 | v0.5 1A 首版范围与 S11-S15 承接关系待复审                |
| 基准 PRD   | [PRD-AI创作平台需求文档.md](./PRD-AI创作平台需求文档.md) |
| 当前阶段   | 阶段 1A：S11 工作台与首版 Skill 内容闭环                 |
| 文档负责人 | 产品/工程评审指定                                        |
| 最后更新   | 2026-08-17                                               |

## 工程参考

阶段 0 文档会参考历史项目 `D:\agent\image`，但不直接照搬产品形态。参考重点是其中已经实现的对话 Agent、tool calling、Skill runtime、上下文与恢复机制；本项目 1A 的核心入口是通用对话式生图 Agent，用于创意生图、电商从零生成和本会话产物迭代，无限画布只属于后续专业工作流。

可复用的是工程模式，不是交互主线：

- 多包结构：`apps/web`、`apps/api`、`apps/worker`、`packages/agent`、`packages/compiler`、`packages/credit`、`packages/provider`、`packages/queue`、`packages/db`、`packages/types`、`packages/shared`、`packages/skills`。
- Agent/Skill：Skill loader、Skill snapshot、能力依赖提示、guardrails、Agent turn 状态，可迁移到对话式 Agent；Skill 不迁移执行授权。
- 画布：节点、边、引用角色、执行计划、下游影响和确认，仅作为阶段 3a/3b 画布设计参考。
- Worker/Queue：BullMQ 队列、`jobId=业务ID` 幂等、worker heartbeat。
- Provider：统一 ProviderId、请求超时、下载超时、请求摘要脱敏、Provider 成本回传。
- 事件：EventOutbox + SSE 恢复。

产品形态红线：

- 不把 1A 做成画布 Agent。
- 不要求用户先进入画布才能创意生图或电商从零生成。
- 不复刻旧项目的画布主交互、节点优先体验或画布上下文 Agent。
- 对话 Agent 是 1A 第一入口；画布是后续工作流和专业加工模块。
- 旧项目只吸收工程优点：Agent 架构、Skill 设计、Provider、Worker、Queue、事件、状态和测试经验；不吸收旧画布 Agent 的产品形态。

## 文档裁决规则

当文档之间出现冲突时，按以下顺序裁决：

```text
 PRD v1.10
  > 01 架构/交易契约、02 Agent/Skill 契约
  > 04 状态机、05 数据模型、06 API/队列/事件契约
  > 07 UI 与最小运营界面
  > 08 安全合规与资产生命周期
  > 09 验证、监控、灰度与故障手册
  > 10 工程架构、目录与部署
```

补充规则：

- PRD 裁决产品边界、阶段范围、R1-R5、商业/合规原则。
- 阶段 0 文档裁决工程实现细节，但不得改变 PRD 已定产品边界。
- 同一工程细节重复出现时，以更专门的文档为准：状态枚举以 `04` 为准，表结构和约束以 `05` 为准，接口、队列和 Webhook payload 以 `06` 为准，验收脚本以 `09` 为准。
- 模型准入、Provider 能力和真实成本以 `03` 为准；`02` 的计划编译器必须拒绝未通过 `03` PoC 的模型进入可收费路由。
- Provider、模型、Skill、规范、计价和提示词均采用版本快照；已发布版本不得原地覆盖。
- 任何可收费功能编码前，必须完成 `01`、`02`、`03`、`04`、`05`、`06`、`10` 的评审；内测前必须完成 `07`、`08`、`09` 的评审。

## 阶段 0 文档

| 顺序 | 文档                                                                                             | 本文裁决内容                                                                                  | 状态            |
| ---- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------- |
| 1    | [01-architecture-and-transaction-contract.md](./01-architecture-and-transaction-contract.md)     | 模块边界、R1-R5 落地、交易总契约、积分预留、Provider 回执、保真接口与三级处置                 | v0.1 可评审草案 |
| 2    | [02-agent-and-skill-orchestration-contract.md](./02-agent-and-skill-orchestration-contract.md)   | 意图 schema、解析确认 schema、Skill JSON schema、计划编译、引用授权、Agent 与确定性编译器职责 | v0.5 待复审     |
| 3    | [03-provider-poc-and-cost-model.md](./03-provider-poc-and-cost-model.md)                         | Provider 能力探测、模型回执、配额、成本、Workflow 候选、Plan B、PoC 脚本                      | v0.4 待复审     |
| 4    | [04-state-machine-and-exception-matrix.md](./04-state-machine-and-exception-matrix.md)           | `workflow_run/task/task_attempt` 状态图、取消、超时、回执未知、退款、申诉、熔断               | v0.5 待复审     |
| 5    | [05-data-model-and-constraints.md](./05-data-model-and-constraints.md)                           | 表、字段、枚举、唯一约束、索引、账本不变量、迁移策略                                          | v0.7 待复审     |
| 6    | [06-api-queue-and-event-contract.md](./06-api-queue-and-event-contract.md)                       | API、SSE、队列 payload、Webhook、错误码、幂等、权限校验                                       | v0.7 待复审     |
| 7    | [07-1a-user-flow-and-ui.md](./07-1a-user-flow-and-ui.md)                                         | 邀请内测、Agent、事实确认、成本确认、结果、风险提示、改图、资产、最小运营 UI                  | v0.4 待复审     |
| 8    | [08-security-compliance-and-asset-lifecycle.md](./08-security-compliance-and-asset-lifecycle.md) | 认证安全、签名 URL、删除策略、分享隐私、密钥、权限、协议/法务门禁                             | v0.5 待复审     |
| 9    | [09-validation-and-operations.md](./09-validation-and-operations.md)                             | 资金/认证验收、模型 PoC、内测指标、监控告警、灰度、环境门禁、故障手册                         | v0.5 待复审     |
| 10   | [10-engineering-architecture-and-deployment.md](./10-engineering-architecture-and-deployment.md) | 工程技术栈、环境配置、服务边界、本地开发、中国内测部署、无重构扩容预案                        | v0.4 待复审     |

## SPEC 开发任务规格

| 目录                                                                       | 内容                                                       | 状态        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------- |
| [spec/README.md](./spec/README.md)                                         | SPEC 任务规格总规则、模板、测试库基线和拆分顺序            | v0.1 可评审 |
| [spec/00-master-development-plan.md](./spec/00-master-development-plan.md) | 全项目开发总计划、任务组、依赖顺序、上线门禁和画布后置边界 | v0.1 可评审 |

## 产品交互调研

`docs/research/` 是维护者本地的调研和审查记录，不随公开仓库交付，也不是启动依赖。
公开设计依据参见 [象塑浅色界面设计](./design/05-xiangsu-light-style-update.md) 和上述产品契约、SPEC。

调研文档只记录证据和设计依据，不改变裁决顺序。产品边界仍由 PRD 裁决，工程交付仍由对应阶段文档和 SPEC 裁决；若调研结论与上游契约冲突，必须先修改上游契约并复审，不能直接按调研文档编码。

## 不再单独拆分

- 保真校验器：归入 `01`，但状态和存储细节分别由 `04`、`05` 裁决。
- 工程验收脚本：归入 `09`，必须给出可执行命令和脚本路径。
- 主流程：业务主流程归入 `07`，任务状态流转归入 `04`。
- 部署拓扑、工程目录和扩容预案：归入 `10`；`09` 只保留验证、运营告警和故障手册。
- 邀请内测与自媒体反馈：归入 `09`，不修改 PRD。
