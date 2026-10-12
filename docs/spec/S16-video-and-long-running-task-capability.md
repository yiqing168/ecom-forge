# S16 1B 视频与长任务能力

| 项     | 内容                                                  |
| ------ | ----------------------------------------------------- |
| 状态   | v0.1 可评审                                           |
| 阶段   | 1B                                                    |
| 优先级 | P1                                                    |
| 目标   | 接入视频/长任务能力前的异步恢复、通知、成本和回执闭环 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` 阶段 1B
- `docs/03-provider-poc-and-cost-model.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/09-validation-and-operations.md`
- `docs/design/01-full-site-screen-flow-spec.md`
- `docs/design/03-v0-full-site-ui-interaction-prompt.md`

## 当前模块范围

包含商品展示视频、创意短片、30 分钟级异步任务、轮询/回调恢复、站内通知、视频成本核算。

本 SPEC 先执行视频 Provider PoC spike，再进入网关与产品编码；PoC 不另拆 SPEC，但属于 S16 的前置交付。

不包含画布时间线、数字人、智能混剪。

## 交付面

| 交付面          | 要求                                       |
| --------------- | ------------------------------------------ |
| 前端/UI         | 视频任务提交、预计等待、任务详情、完成通知 |
| 后端/API        | 视频 quote、任务状态、通知查询             |
| Worker/Provider | 视频 Provider adapter、长轮询、回调幂等    |
| 测试            | 长任务恢复、回执丢失、成本超限、通知       |

## 业务规则

- 视频模型必须单独 PoC，不复用图片模型准入。
- `pnpm validate:video-poc` 必须在视频网关和收费功能编码前通过，冻结模型能力、配额、回执、质量、单位成本和目标毛利。
- 提交时展示预计等待区间和总费用。
- 长任务页面刷新后必须恢复状态。
- outcome_unknown 仍按三态回执处理。

## 测试标准

- fake video Provider 模拟 30 分钟任务。
- 集成测试覆盖轮询/回调重复和 Worker 重启。
- Playwright 覆盖提交后离开页面再回来。
- 实现并通过 `pnpm validate:long-task-recovery`。

## 验收清单

- [ ] 视频任务不会因长耗时丢状态。
- [ ] `validate:video-poc` 和 `validate:long-task-recovery` 通过。
- [ ] 成本核算完成并审批。
- [ ] 通知可达。
- [ ] 回执异常不重复扣费。
