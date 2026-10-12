# 04 状态机与异常矩阵

| 项       | 内容                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| 状态     | v0.7 1A 生成提交排队、阻断与恢复状态回写后待复审                                               |
| 基准     | PRD v1.12                                                                                      |
| 完成节点 | 数据库前                                                                                       |
| 裁决范围 | `workflow_run`、`task`、`task_attempt`、后续聚合状态图，取消、超时、回执未知、退款、申诉、熔断 |
| 不裁决   | 表字段细节、HTTP payload、UI 展示文案                                                          |

## 1. 目标

本文定义所有异步任务和资金相关状态。后续数据库、API、Worker、SSE、运营后台必须引用本文枚举，不得各自扩展状态含义。

关键目标：

- 能恢复 Worker 中断后的任务。
- 能证明重复点击不会重复扣费。
- 能区分 Provider 未送达、已受理和结果未知。
- 能将账本状态和任务状态关联起来。
- 能支持模型熔断和停止新任务。
- 能按用户权益执行并发限制。

## 2. 状态与恢复设计

| 机制                      | 本项目要求                                                     |
| ------------------------- | -------------------------------------------------------------- |
| 提交前费用快照、TTL、幂等 | 由 `run_quote` 固化报价和执行快照。                            |
| 任务状态                  | 由 `task` 主状态表达生成任务的进度与终态。                     |
| BullMQ 业务 ID            | 使用 `task_id` 或 `task_attempt_id` 作为 jobId，实现队列幂等。 |
| Agent turn 状态           | 独立表达对话轮次，不与 task 状态混用。                         |
| Worker heartbeat          | 表达 Worker 存活、draining、stopped 和告警。                   |
| EventOutbox               | 可靠投递 SSE 与审计事件，保持项目事件顺序。                    |

## 3. run_quote 状态

`run_quote` 是提交前费用报价和服务端编译快照，不是用户侧规划流程。所有生成入口都由用户的生成/运行动作授权，服务端直接核对并预留；用户只处理必要商品事实、澄清和风险确认，不处理费用确认。

```text
quoted
  -> submitted
  -> superseded
  -> expired
  -> cancelled
```

| 状态         | 含义                                                                                                               | 可进入                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `quoted`     | 已生成费用预估和服务端编译快照，等待提交                                                                           | `submitted`、`superseded`、`expired`、`cancelled` |
| `submitted`  | 报价已按入口契约提交并原子创建 reservation/workflow；1A 使用服务端生成动作证据，非 1A 入口按各自 SPEC 校验确认快照 | 终态                                              |
| `superseded` | 被新 turn 或新报价替代，原报价不再可提交                                                                           | 终态                                              |
| `expired`    | 报价超过 TTL，不能继续提交                                                                                         | 终态                                              |
| `cancelled`  | 用户或系统取消报价                                                                                                 | 终态                                              |

规则：

- 1A 电商任务必须完成必要商品事实确认；确认后与创意任务一样由服务端直接完成报价、积分核对和预留，不插费用卡。
- 1A 用户点击“生成/继续改并生成”形成不可变 `generate_action@v2` 证据，服务端可以据此创建并立即提交 `run_quote`；证据不包含用户金额上限。
- 画布工作流只在点击生成前显示费用预估，不引入用户侧规划流程。
- `submitted` 后不得修改报价和编译快照，只能创建新报价。
- `superseded` 只由新 turn 或新报价触发，不由用户手工选择。

## 4. run_quote 与 reservation 的关系

三入口统一走两段式：

```text
run_quote(费用报价和编译快照)
  -> submit
  -> credit_reservation(冻结)
  -> workflow_run
```

规则：

- Agent、电商套图、画布节点生成均先生成 `run_quote`。
- 创意低阈值直执行可以由服务端内部创建并立即提交 `run_quote`，但仍必须有报价记录。
- `workflow_runs.run_quote_id` 只允许历史兼容或人工补录为空；1A 新建运行必须非空。
- 重复点击在 `run_quote` 和 `workflow_run` 两层都必须幂等。

## 5. workflow_run 状态

```text
reserved
  -> queued
  -> running
  -> waiting_manual_review
  -> succeeded
  -> failed
  -> cancelling
  -> cancelled
  -> refunding
  -> refunded
  -> disputed
```

| 状态                    | 含义                                 |
| ----------------------- | ------------------------------------ |
| `reserved`              | 积分预留已创建                       |
| `queued`                | 所有前置条件满足，等待 Worker        |
| `running`               | 至少一个 task 正在运行               |
| `waiting_manual_review` | 产物或资金证据等待人工裁决           |
| `succeeded`             | 全部必须 task 成功，产物已入库       |
| `failed`                | 工作流最终失败                       |
| `cancelling`            | 正在请求取消，可能已有 Provider 受理 |
| `cancelled`             | 未执行或可取消部分已停止             |
| `refunding`             | 正在解冻或退款                       |
| `refunded`              | 退款/解冻已完成                      |
| `disputed`              | 用户发起申诉                         |

状态不变量：

- `reserved` 之后必须存在 `credit_reservation`。
- `succeeded` 之前必须完成结算。
- `failed/cancelled` 后必须处理未结算预留。
- `disputed` 不改变原始任务结果，只追加申诉流程。

### workflow_run 显式转换

| from                    | to                      | 触发                                         | 账本动作                               |
| ----------------------- | ----------------------- | -------------------------------------------- | -------------------------------------- |
| `run_quote=quoted`      | `submitted`             | 有效生成动作证据由统一 submit 事务消费       | 同事务创建并冻结 reservation           |
| `run_quote=submitted`   | `reserved`              | 同一事务创建 workflow_run 并关联 reservation | 不新增账本动作                         |
| `reserved`              | `queued`                | task 创建并入队                              | 无                                     |
| `queued`                | `running`               | Worker 抢占                                  | 无                                     |
| `running`               | `waiting_manual_review` | 生成后审核 unknown 或结算证据需人工处理      | 保持未结算冻结                         |
| `waiting_manual_review` | `running`               | 人工 release 且仍有发布/结算 task            | 无                                     |
| `waiting_manual_review` | `failed`                | 人工 reject 或审核 SLA 到期                  | 待解冻                                 |
| `running`               | `succeeded`             | 全部必需 task 成功                           | 结算 reservation                       |
| `running`               | `failed`                | 终局失败且非 unknown                         | 待解冻                                 |
| `failed`                | `refunding`             | 开始释放未结算金额                           | 写 release 流水                        |
| `refunding`             | `refunded`              | 解冻完成                                     | 更新账户投影                           |
| `queued`                | `cancelling`            | 用户取消                                     | 无                                     |
| `running`               | `cancelling`            | 用户取消                                     | 已 accepted 的 attempt 不承诺停止      |
| `cancelling`            | `cancelled`             | 确认无 accepted attempt 或本地停止           | 待解冻                                 |
| `cancelled`             | `refunding`             | 有冻结未结算金额                             | 写 release 流水                        |
| `succeeded`             | `disputed`              | 用户申诉                                     | 无，申诉另写 appeal                    |
| `failed`                | `disputed`              | 用户申诉                                     | 无，申诉另写 appeal                    |
| `disputed`              | `succeeded`             | 申诉处理结束，原 run 为成功                  | 申诉通过时写 appeal_refund；驳回时不写 |
| `disputed`              | `failed`                | 申诉处理结束，原 run 为失败                  | 申诉通过时写 appeal_refund；驳回时不写 |

## 6. task 状态

```text
pending
  -> queued
  -> running
  -> succeeded
  -> failed
  -> cancelled
  -> blocked
  -> waiting_manual_review
```

| 状态                    | 含义                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pending`               | 等待依赖或必要的事实/风险确认；生成任务不等待费用确认                                                                   |
| `queued`                | 已入队                                                                                                                  |
| `running`               | Worker 已抢占                                                                                                           |
| `succeeded`             | 任务成功并产生必要产物                                                                                                  |
| `failed`                | 任务失败且不可自动恢复                                                                                                  |
| `cancelled`             | 执行前或可取消时被取消                                                                                                  |
| `blocked`               | 被内容安全、权限、保真 hard block 或熔断阻止                                                                            |
| `waiting_manual_review` | 兼容等待态：生成后审核/账本异常可待受控裁决；生成 Provider `outcome_unknown` 只等待 30 分钟自动释放，不存在人工核对角色 |

S12 生成后审核 task 的显式转换为 `running -> succeeded | blocked | waiting_manual_review`；其中人工独立判断 release 后 `waiting_manual_review -> succeeded`，reject 或 24 小时到期为 `waiting_manual_review -> blocked`。转换必须与不可变 evaluation、review case revision、publication/settlement 或 release intent 和 outbox 在同一短事务推进；重复/并发裁决只有一个赢家。

## 7. task_attempt 状态

`task_attempt` 表示一次实际投递或一次本地执行尝试。

```text
created
  -> dispatching
  -> accepted
  -> polling
  -> succeeded
  -> failed
  -> timeout
  -> outcome_unknown
```

| 状态              | dispatch_state    |                       自动重试 | 含义                         |
| ----------------- | ----------------- | -----------------------------: | ---------------------------- |
| `created`         | `not_dispatched`  |                             是 | 尚未离开平台                 |
| `dispatching`     | `not_dispatched`  |                             是 | 正在发起请求，本地未确认送达 |
| `accepted`        | `accepted`        |                             否 | Provider 已受理              |
| `polling`         | `accepted`        |                             否 | 已受理，等待轮询/回调        |
| `succeeded`       | `accepted`        |                             否 | Provider 返回成功            |
| `failed`          | 视情况            | 仅 `not_dispatched` 可自动重试 | Provider 或本地失败          |
| `timeout`         | `outcome_unknown` |                             否 | 请求已离开平台但超时         |
| `outcome_unknown` | `outcome_unknown` |                             否 | 回执丢失或无法确认最终结果   |

`dispatching/not_dispatched` 只表示本地尚未获得受理证据，不等于请求一定未送达。只有 Provider adapter 能证明请求未离开本机时才可转 `failed/not_dispatched`；请求体可能写出、响应读取超时、连接复位、响应不可解析，或状态已提交为 dispatching 后进程崩溃且无法证明未送达时，必须转 `outcome_unknown/outcome_unknown`，不得自动创建新 attempt。

**临时错误的统一重试口径（产品裁决）**：模型调用的临时失败由 Provider adapter / Worker 自动重试，**最多 3 次**（指数退避），重试不另行向用户收费——①Provider 返回**空响应**（HTTP 200、无文本、无工具调用、`usage=0`，即无任何 token 消耗）时，adapter 在三态分类前先重试，仍为空才归 `outcome_unknown/outcome_unknown`（零资金风险，不违反本节禁令）；②`not_dispatched` 且命中临时/基础设施错误码时，Worker 在同一 attempt 记录内重试。**余额不足、预算超限、账号冻结等资金与权限类失败一律不重试**，立即以准确用户文案终局；其余永久性错误（schema/权限/协议不合规）也不重试，走各自的拒绝或修复路径。

图片管线的本地重试保持同一 task、attempt、operation key 和 reservation，首次调用加最多三次重试，固定退避 250/500/1000 ms。只有回执 `retryable=true`、错误码为 `provider_unavailable|provider_rate_limited|provider_timeout|provider_internal_error`，且数据库仍为 `dispatching/not_dispatched`、task/workflow 仍在运行时才可继续。当前 Dispatcher 只把准入阶段明确的配额控制面暂时不可用标记为可重试；已耗尽准入等待窗口、熔断、无效绑定、权限和配置错误不重试。写出栅栏一旦已标记可能投递，任何相矛盾的未发送回执均收敛为 unknown，不能重投；停止信号打断退避，接管不重启重试循环，BullMQ attempts 与 task attempt 上限不变。

集中状态 repository 的允许集合必须显式包含以下恢复迁移，不能只在 Processor 中特殊处理：

- `dispatching/not_dispatched -> outcome_unknown/outcome_unknown`
- `not_dispatched` 在本表指 dispatch state；若 attempt 仍为 `created/not_dispatched`，只有已经存在“请求可能写出”的持久化恢复证据时，才允许 `created/not_dispatched -> outcome_unknown/outcome_unknown`。正常未调用 Provider 的 created attempt 不得无故转 unknown。

S07 实现必须同步更新 `ATTEMPT_TRANSITIONS`，并以真实数据库集成测试证明：提交 `dispatching` 后模拟崩溃会收敛为 `outcome_unknown`，Fake Provider submit 计数仍为 1，且不会创建新 attempt。

### 状态推进并发规则

- workflow/task/task_attempt 的每次推进必须通过集中状态 repository 执行数据库 CAS，更新条件包含实体 ID、允许的旧状态和必要 version/owner；禁止 Processor 直接无条件写 status。
- CAS 受影响行数为 0 时必须重新读取：目标状态已完成则幂等 no-op，状态已被其他 Consumer 推进则按最新状态继续或停止，非法迁移返回稳定错误并告警。
- 业务状态、dispatch_state 和对应 `event_outbox` 必须在同一短事务提交；不能先改状态后异步补用户事件。
- reconciler 与存活 Worker 短暂双消费时，只允许一个 CAS 成功；BullMQ jobId 去重和唯一约束是辅助防线，不能替代状态 CAS。
- 文档、日志和指标必须区分 `intent.status=dispatching` 与 `attempt.status=dispatching`，不得用裸 `dispatching` 混淆队列派发租约和 Provider 投递状态。

## 8. credit_reservation 状态

```text
created
  -> frozen
  -> partially_settled
  -> settled
  -> releasing
  -> released
  -> correction_required
```

| 状态                  | 含义                       |
| --------------------- | -------------------------- |
| `created`             | 预留记录创建，尚未成功冻结 |
| `frozen`              | 积分已冻结                 |
| `partially_settled`   | 多步任务部分结算           |
| `settled`             | 已全部结算                 |
| `releasing`           | 正在解冻未结算金额         |
| `released`            | 已解冻                     |
| `correction_required` | 对账发现异常，需要人工冲正 |

## 9. 取消规则

| 位置                                                 | 用户取消结果                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `run_quote=quoted`                                   | 直接 `cancelled`，不涉及积分                                                          |
| `run_quote=quoted` 被新 turn 或新报价替代            | 进入 `superseded`，不涉及积分                                                         |
| `workflow_run=reserved/queued` 且无 attempt accepted | 取消任务并解冻                                                                        |
| `task_attempt=accepted/polling`                      | 标记 `cancelling`，不能承诺 Provider 已停止                                           |
| `outcome_unknown`                                    | 原请求禁止自动重投；用户可立即发起新的收费生成动作，系统按 §10.1 执行 30 分钟自动释放 |

## 10. 人工/用户明确重试

`accepted` 或 `outcome_unknown` 后的重试必须显式建模为新收费意图：

| 原状态                  | 重试方式                                                              | 费用处理                 | 原任务处理                                                      |
| ----------------------- | --------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `accepted` 但用户不想等 | 用户发起新的生成动作，再建 `run_quote -> reservation -> workflow_run` | 新报价、新预留，无费用卡 | 原任务继续等待终局；若后续成功，按原 reservation 结算或人工退款 |
| `outcome_unknown`       | 用户看到重复生成风险提示后明确发起新的生成动作                        | 新报价、新预留，无费用卡 | 原 reservation 最多冻结 30 分钟，超时自动释放                   |
| `failed/not_dispatched` | 同 task 新 attempt                                                    | 不新增费用               | 仍使用原 reservation                                            |

禁止在 `accepted/outcome_unknown` 上直接追加自动 attempt，避免同一 Provider 请求和新请求同时产生成本却无法审计。

## 10.1 outcome_unknown 30 分钟自动超时释放

`outcome_unknown` 不允许自动重试，但不能永久冻结用户积分。

默认策略：

- `task_attempt` 进入 `outcome_unknown` 后不等待人工核对，也不承诺平台会确认结果。用户侧立即停止生成动画，显示本次未完成，并可明确发起新的收费生成动作。
- 以 unknown attempt 的服务端 `ended_at` 为起点；满 30 分钟时，定时任务自动释放该 task 对应的未结算冻结积分。进入 unknown 后的回执不改变此期限，也不成为原 task 的结算或发布依据。
- 自动释放时原 `task_attempt` 保持 `outcome_unknown` 作为审计证据，`task` 转 `failed`；全部 task 已终局且资金已核销后，`workflow_run` 转 `failed`。不得把 unknown attempt 改写成未投递。
- 用户侧文案不得使用“平台核对”“人工确认”等不存在的角色；只说明本次未完成、可立即重新生成，以及原冻结积分最迟 30 分钟自动退回。
- 进入 `outcome_unknown` 后 Provider 补发成功/失败回执或账单（包括 30 分钟内），只写内部异常证据；原 attempt 保持 unknown，不得自动发布产物、`consume` 原 reservation 或补扣用户积分。相关 Provider 成本由平台承担。
- 运营可对 Provider 成本和异常证据做内部对账，不得以该回执追扣用户积分；如已有误扣，须通过申诉/人工冲正流程退回，不得改写历史 ledger。
- Provider unknown 兜底释放不等于 Provider 成本为 0；成本损失计入失败成本摊销。

## 11. 并发限制

生成提交与执行并发分离：

- 用户已有 `queued/running/waiting_manual_review` workflow 不阻断新生成动作；通过余额、风险和单次计划数量校验后创建任务并排队。
- 单次生成 N 张按 N 个输出 task/slot 计价和跟踪，不把它折算成用户并发位。
- Worker、Provider adapter 与模型网关按 Provider/model 配置控制实际执行并发和速率；额度用满时任务保持 `queued`，不返回用户级并发错误。
- `waiting_manual_review` 只进入运营待处理池，不占 Provider 实际执行槽。

## 11.1 用户视角状态映射

内部状态用于审计和恢复，前端用户侧只展示 8 类状态：

| 用户看到              | 内部状态                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `待确认`              | `agent_turn=waiting_user_confirmation`；只表示必要澄清、商品事实或风险确认                          |
| `核对中`              | `run_quote=quoted`、内部 submit intent 正在核对价格/余额/并发并创建 reservation                     |
| `排队中`              | `workflow_run=reserved/queued`、`task=pending/queued`                                               |
| `生成中`              | `workflow_run=running`、`task=running`、`attempt=dispatching/accepted/polling`                      |
| `检查中 / 需人工复核` | `artifact_evaluation` 未完成、保真/内容安全检查中；`artifact_visibility=quarantined` 时用户禁止访问 |
| `部分完成`            | `batch/suite/export=partially_succeeded`；成功项可用，失败项可明确重试                              |
| `已完成`              | `workflow_run=succeeded`                                                                            |
| `未完成/已退款`       | `workflow_run=failed/cancelled/refunded`、30 分钟 `outcome_unknown` 自动释放                        |

用户侧不得展示 `dispatch_state`、`attempt_no`、`reservation_status` 等诊断字段，只展示必要解释和下一步。

`waiting_manual_review` 必须按等待原因映射为稳定的非失败状态，不得继续显示生成动画或普通重试动作：

- `moderation.image` 等生成后内容审核未知显示“结果复核中”，说明平台将在 24 小时内完成复核；逾期未通过则释放本次未结算积分。
- Provider 结果未知或回执丢失时显示“本次生成未完成”，停止生成动画；说明用户可立即明确重新生成，旧请求可能迟到，新请求独立计费，原请求未结算冻结最迟 30 分钟自动退回。
- 已经公开可见的同轮产物继续展示；unknown 槽位使用静态失败态并提供明确重新生成入口。该入口必须新建收费意图，绝不能重投原 attempt。

运营诊断视图按异常聚合：

| 诊断分组              | 内部条件                                                  |
| --------------------- | --------------------------------------------------------- |
| Provider 已受理未回执 | `attempt=accepted/polling/timeout/outcome_unknown`        |
| 本地未送达可重试      | `dispatch_state=not_dispatched`                           |
| 账本待核销            | `reservation=correction_required` 或 ledger replay 不一致 |
| 人工待处理            | `task=waiting_manual_review`                              |
| 熔断影响              | provider/model/skill circuit breaker 命中                 |

## 12. 熔断规则

熔断对象：

- Provider。
- 模型。
- Skill。
- 任务类型。
- 用户风险账户。

触发条件：

- Provider 错误率超过阈值。
- `outcome_unknown` 比率超过阈值。
- 单小时成本超过阈值。
- 账本不一致。
- 内容安全异常激增。

熔断结果：

- 停止新任务进入队列。
- 已入队但未投递的任务回到 `blocked` 或 `waiting_manual_review`。
- 已受理任务等待自然完成或人工处理。
- 前端展示模型不可用，不静默切换计价或模型。
- `open -> half_open` 只允许一个带 revision CAS 的 probe owner；领取时将 `probe_after` 从最早探针时间原子改写为服务端 `now + circuit_open_ms` 的租约截止。owner 在截止前未回写时，下一次检查原子执行 `half_open -> open`、清空 owner 并记录 `half_open_probe_timeout`，本次仍拒绝；重新 cooldown 后才允许新 probe。
- owner 在真正发起 Provider 请求前若 attempt CAS 失败，必须用同一 probe token 原子释放为 `open` 并将 `probe_after` 设为当前服务端时间；该路径没有 Provider outcome，不增加 failure/unknown 样本，随后才允许新的 probe。
- 受控人工恢复可按 expected revision 将 open 或租约已过期/无有效租约的 half-open 转为 closed；有效租约内的 half-open 仍拒绝恢复。不得手工改表或绕过审计，运行时恢复不得修改 `models.status`。

## 13. 异常矩阵

| 场景                  | 前置状态                     | 触发                   | 目标状态                                                                    | 积分动作                                                                      |       自动重试 | 告警   |
| --------------------- | ---------------------------- | ---------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------: | ------ |
| 单次投递              | `queued`                     | Worker 抢占成功        | `running/accepted`                                                          | 无新增扣费                                                                    |             否 | 否     |
| 重复点击              | `run_quote=submitted`        | 同一幂等键再次提交     | 返回已有 run                                                                | 不新增预留                                                                    |             否 | 计数   |
| Worker 恢复           | `running` 但 heartbeat 丢失  | 新 Worker 扫描         | 按 attempt 状态恢复                                                         | 不新增扣费                                                                    | 仅未送达可重试 | 是     |
| Provider 未送达       | `dispatching/not_dispatched` | 本地网络失败           | 新 attempt 或 failed                                                        | 不重复计费                                                                    |  是，最多 2 次 | 是     |
| Provider 已受理但超时 | `accepted/polling`           | 超过超时阈值           | `outcome_unknown`；允许用户另发新请求，30 分钟后自动释放原冻结              | 最多冻结 30 分钟，超时释放                                                    |   否（原请求） | 是     |
| 回执丢失              | `accepted`                   | 查不到最终结果         | `outcome_unknown`；允许用户另发新请求，30 分钟后自动释放原冻结              | 最多冻结 30 分钟，超时释放                                                    |   否（原请求） | 是     |
| 内容安全生成前拦截    | 任务未投递                   | 文本审核失败或不可用   | `blocked`                                                                   | 不创建预留；已有 quote 不得 submit                                            |             否 | 是     |
| 内容安全生成后拒绝    | Provider 已产出              | 图片审核失败           | `artifact_visibility=quarantined`，task/workflow 转 `blocked`               | 释放全部未结算 reservation，平台承担已发生 Provider 成本                      |             否 | 是     |
| 内容安全生成后未知    | Provider 已产出              | 图片审核超时或结果未知 | `artifact_visibility=quarantined`，task/workflow 转 `waiting_manual_review` | 审核通过后才可结算；24h SLA 内未通过人工复核则转 `blocked` 并释放 reservation |             否 | 是     |
| 保真 hard block       | 2B 后输出冲突                | 校验器确认冲突         | `blocked`                                                                   | 按任务是否成功结算，允许申诉                                                  |             否 | 计数   |
| 用户申诉通过          | `disputed`                   | 运营裁决               | 原 run 不变                                                                 | 写 `appeal_refund`                                                            |             否 | 退款率 |
| 人工冲正              | `correction_required`        | 管理员审批             | 原状态不变                                                                  | 写 correction ledger                                                          |             否 | 是     |

## 14. Agent turn 状态

Agent turn 不替代 task 状态，用于对话体验和排障。

枚举：

```text
received_user_input
loading_context
detecting_intent
validating_context
clarifying
planning
plan_ready
waiting_user_confirmation
run_quote_created
waiting_provider_confirmation
done
blocked
failed
cancelled
superseded
```

Agent turn 可引用 `run_quote_id`、`workflow_run_id`，但不直接代表扣费状态。

公网 Agent API/SSE 不返回上述内部枚举，只返回用户视角状态：

| `user_status`     | 内部状态                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinking`        | `received_user_input/loading_context/detecting_intent/validating_context/clarifying/planning/plan_ready/run_quote_created/waiting_provider_confirmation` |
| `waiting_for_you` | `waiting_user_confirmation`                                                                                                                              |
| `stopped`         | `cancelled/superseded`                                                                                                                                   |
| `completed`       | `done`                                                                                                                                                   |
| `failed`          | `blocked/failed`                                                                                                                                         |

映射只由服务端固定函数完成；内部状态、revision 或 continuation 不得被前端翻译成新的业务阶段。

S08 可执行转换：

```text
received_user_input -> loading_context
loading_context -> detecting_intent | blocked | failed
detecting_intent -> validating_context | clarifying | done | blocked | failed
validating_context -> clarifying | planning | blocked | failed
clarifying -> waiting_user_confirmation
waiting_user_confirmation -> loading_context
planning -> waiting_user_confirmation | done | blocked | failed
```

S09 激活 Compiler 后才允许：

```text
planning -> plan_ready -> run_quote_created
run_quote_created -> waiting_user_confirmation | waiting_provider_confirmation | done
```

其中 `run_quote_created -> waiting_provider_confirmation` 只能由 S04 的统一 quote submit 事务完成。内部自动提交 intent 必须携带与来源聚合、plan、revision/continuation 和 policy 绑定的生成动作 digest；事务重新校验余额、并发、价格和 quote 完整性后原子创建 reservation/workflow。校验失败就地阻断，不转费用确认。Worker/Compiler 不得直接冻结积分、创建 reservation 或把报价状态改为 submitted。

终局规则：

- `done/blocked/failed/cancelled/superseded` 终局不可逆。
- Agent 定期恢复只扫描当前 continuation、无报价/工作流且租约已过期的非终态 turn。completed job 再驱动保留累计 attempts，不重置有界预算；failed job 不自动重投。预算耗尽后以 session -> turn 行锁、revision/continuation/过期租约 CAS 原子收口为 failed，推进 trace 与安全失败事件，保留已发生的成本及 outcome_unknown 证据。活跃租约、等待用户、取消、已提交或已终局的 turn 不收口。扫描按稳定游标轮转，耗尽或损坏的旧记录不能永远占住首批窗口。
- 生成前安全审核的有效 running lease 是等待，不是处理失败。Agent 释放自己的处理租约并将同一 job 延迟到审核 lease 边界；不新增 turn 状态、不完成 job、不消耗 attemptsMade，也不重新调用 Brain。恢复扫描遇到 delayed job 不重驱。只有 preflight 的 CAS 确认仍为 not_dispatched 并成功退回 queued，才按首次尝试 + 最多三次重试的处理预算退避；可能写出后的异常不得归入此分支，lease 到期按原审核 operation 收敛为 outcome_unknown 并阻断。用户 interrupt/supersede 仍由既有 revision/owner 栅栏阻止晚到结果。
- 所有尚未提交 workflow 的非终局状态都可以由用户 interrupt 转 `cancelled`，或由同 session 新 turn 转 `superseded`；二者都必须递增 turn revision、清除 processing lease，并使旧 Worker 的晚到写 CAS 失败。
- 已关联 workflow 的 turn 不得由新消息或 turn interrupt 改写 workflow/资金/Provider 状态；取消必须走 workflow 状态机。
- Tool、Skill 和模型输出不能直接写 turn 状态；统一状态 repository 根据合法转换、owner、revision 和 continuation 执行 CAS。
- 每次状态变化与 `turn.status_changed` outbox 同事务；终局再同事务写对应 `turn.completed | turn.failed | turn.cancelled | turn.superseded`。`turn.interrupted` 只补充用户主动停止事实，不替代 cancelled 终局事件。

turn 等待确认规则：

- `waiting_user_confirmation` 不触发收费动作，只等待入口契约允许的澄清、商品事实或风险确认；任何生成入口都不以该状态等待费用确认。
- 默认 30 分钟无用户确认则 pending confirmation 转 `expired`、turn 转 `cancelled`；若有关联 `run_quote` 且未提交，quote 按自身 TTL/状态契约转 `expired`，不得伪装为用户 interrupt。
- 有效确认必须按 confirmation ID/type/version/payload digest 校验并只消费一次；成功后递增 `continuation_no/revision`，转回 `loading_context`。过期、旧版本和已 supersede 的确认不得套用。
- 新用户消息创建新 turn 时，旧 turn 转 `superseded`；若旧 turn 只有未提交 quote，quote 转 `superseded`。并发新消息通过 session 行锁和唯一约束保证最多一个未提交 active turn。
- `waiting_user_confirmation` 尚未创建收费 workflow；提交后创建的 `workflow_run/task` 进入内部调度队列，不占用用户并发位。

费用提交规则：

- 1A 的“提交”是用户创建 turn 的“生成/继续改并生成”动作。公网请求不得携带费用模式或金额上限；API 同事务派生 strict `generate_action@v2` evidence/hash，并绑定 create request、Skill、模型、偏好和 policy version。
- 1A 仍先创建 `run_quote`，再由内部自动提交 intent 委派统一 S04 事务。余额不足、价格未知、目录/计价漂移或单次计划数量越界时取消未提交 quote 并收敛为公开阻断/失败状态，不进入 `waiting_user_confirmation`，不生成费用卡。已有活动 workflow 不阻断提交。
- 自动路径和显式 `POST /api/v1/run-quotes/{quote_id}/submit` 必须委派同一个 S04 quote submit application service。该事务原子完成账户冻结、reservation、workflow/task/queue intent、quote submitted、`agent_turn.workflow_run_id`、turn 状态和 outbox；任一步失败则资金与 turn/workflow 关联全部回滚。
- 自动提交 intent 可安全重放：稳定幂等键由 `turn_id + continuation_no + plan_digest + authorization_digest` 派生。同一 quote 只能产生一个 workflow；不得因 Worker 崩溃、队列重复或 SSE wake 失败重复冻结。
- quote 过期、余额不足、账号禁止收费或授权/计划漂移时不得降级为 0 元、减少张数、换模或绕过核对。明确不可重试的结果按固定公开错误收敛 turn；数据库/队列暂时故障保留可恢复 intent，不把失败伪装成已提交。
- 每个 Agent quote 创建服务端延迟 expiry intent。expiry 与 submit 以 `turn -> quote` 同序锁和状态 CAS 竞争；到期仍未提交则 quote expired、turn/trace cancelled 与 outbox 同事务收敛。余额不足的自动提交直接公开阻断且不后台重试、不生成费用 action card；账号权限或风险禁止则 fail closed。

Agent trace 状态固定为 `running/succeeded/failed/blocked/cancelled/superseded`。turn 与 trace 的对应终局必须在同一事务推进；用户停止和确认过期使用 `cancelled`，不能记成模型失败。

## 15. Skill package 与 catalog release 状态

Skill 包验证、人工审批和 catalog 发布是三套独立状态机；禁止用一个 `published` 布尔值同时表达三件事。

```text
quarantined -> uploaded -> validating -> validation_failed
                                    -> ready_for_review -> approved -> disabled
uploaded | validation_failed | ready_for_review -> validating  # 新 validation attempt
quarantined | uploaded | validation_failed | ready_for_review -> rejected
```

- `quarantined` 只表示平台已分配上传对象；完成接口重新读取对象并解析 manifest 后才进入 `uploaded`。客户端自报的 package ID、版本、MIME、大小和 hash 均不可信。
- 每次 `validating` 都创建新的 validation attempt/report：`queued -> running -> passed | failed | cancelled`。旧 report 不覆盖；`running` 必须有 owner/lease/revision，过期后只接管同一 attempt，旧 owner 晚到 no-op，终态 report 不再修改或重跑。
- `ready_for_review` 必须指向最新 passed report；审批固定 package/report/validator/eval-suite digest。审批不自动上线。
- 已 `approved` package 的重新验证不倒退主状态：新 report 独立运行，passed 保持 `approved + risk=clear`；非 critical failed 为 `approved + risk=needs_review` 并写服务端 `risk_review_due_at`；达到 deadline 后 catalog/turn create 直接 fail closed，sweeper 只补持久化 `risk_blocked_at`/审计；critical failed 原子进入 `disabled + risk=critical`。审批证据仍指向原 approved report。
- `rejected` 和 `disabled` 为终局。disabled 是安全熔断，立即拒绝新 turn 和新 release 引用；恢复只能安装新 package version。
- 已批准 package 不因其所在 release retired 而退回 ready 状态；历史 release/turn 仍保留精确引用。

```text
draft -> published -> retired
```

- release 是完整 catalog 快照。`draft` 可被放弃但不物理删除审计；只有 expected catalog revision 匹配时可发布。
- 发布事务原子把新 release 置为 `published`、旧 active 置为 `retired` 并更新 `skill_catalog_state.active_release_id/revision`；并发发布只有一个赢家。
- 回滚创建新的 draft/release_no 并复用目标历史 manifest，不能把 retired release 原地改回 published。
- package disabled、资源 hash 漂移或依赖不闭合时，即使 release 为 published，catalog query/turn create 仍 fail closed；不能以旧 pointer 绕过安全停用。

## 16. 后续聚合状态（1B-3b）

`batch`、`suite` 和 `export` 是多个 task/artifact 的持久化聚合，不替代 `workflow_run/task/task_attempt` 真相，也不自行写账本。

### batch / suite

```text
draft -> quoted -> submitted -> running
  -> succeeded
  -> partially_succeeded
  -> failed
  -> cancelled

quoted -> draft                    (配置修改，旧 quote superseded)
partially_succeeded|failed -> quoted (用户明确重试失败子集并重新报价)
```

规则：

- `draft/quoted` 可编辑，使用 revision compare-and-set；配置、条目或输入版本改变后必须回到 `draft` 并使旧 quote 失效。
- `submitted/running` 的本次快照不可编辑；后续修改只能创建新草稿版本或等待终态后明确重试。
- `succeeded/partially_succeeded/failed/cancelled` 由父 workflow 和条目投影，不由前端直接写入。
- `partially_succeeded` 表示至少一个条目成功且至少一个条目失败/取消；成功产物不回滚。
- 从 `partially_succeeded/failed` 重试只选择允许重试的失败子集，生成新 quote/run；`accepted/outcome_unknown` 原请求不自动重投，用户明确重生成走新 quote/run，unknown 原冻结按 30 分钟自动释放。

### export_job

```text
queued -> running -> succeeded | partially_succeeded | failed
succeeded|partially_succeeded -> expired
partially_succeeded|failed -> queued  (用户明确重试 failed items)
```

规则：

- `partially_succeeded` 的成功文件/清单可下载，失败项保留稳定错误码；重试不得重新生成 artifact。
- `expired` 只表示打包对象已清理，导出审计记录和 manifest 仍按保留策略存在；用户可基于原 selection snapshot 新建导出。
- Worker 重放通过 `export_id + operation + attempt_no` 幂等，不能创建重复包或越权加入新 artifact。
