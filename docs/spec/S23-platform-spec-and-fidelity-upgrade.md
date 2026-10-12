# S23 2B 平台规范与保真升级

| 项     | 内容                                                                                  |
| ------ | ------------------------------------------------------------------------------------- |
| 状态   | v0.1 可评审                                                                           |
| 阶段   | 2B                                                                                    |
| 优先级 | P1                                                                                    |
| 目标   | 上线平台规范首版和保真校准框架，支持高风险确认；hard block 仅在独立校准门禁通过后启用 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` §2.13
- `docs/01-architecture-and-transaction-contract.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/research/01-full-site-product-interaction-benchmark.md` §4.5、§4.7

## 当前模块范围

包含淘宝/天猫、亚马逊、TikTok 规则库，Prompt 注入，白底/尺寸校验，高风险确认，确定事实冲突 hard block 框架及校准门禁。

不包含从零训练专用保真模型、OCR 文案完整核对和主体占比高级算法。校准数据标注是主计划规定的前置工作流；S23 负责接入、评测、阈值审批和发布开关。

## 交付面

| 交付面   | 要求                                                          |
| -------- | ------------------------------------------------------------- |
| 后端/API | platform spec query、evaluation、risk confirmation            |
| 前端/UI  | 规范提示、高风险确认、blocked 展示                            |
| 数据库   | platform_spec_rules、artifact_evaluations、risk_confirmations |
| 测试     | 规则版本、确认快照、hard block                                |

## 业务规则

- 商品保真和平台规范是两条链路。
- high_risk_confirmation 记录用户看到的证据快照。
- hard_block 仅对确定事实冲突启用。
- `hard_block_enabled` 默认关闭；未通过校准审批时，生产环境继续只输出 warning/unknown，不得因开发完成而自动打开。
- 校准集至少包含 500 对经双人复核的“原商品/事实集/生成结果”分层样本，并保留独立 holdout；启用门禁要求 holdout 误拦率不高于 1%，`unknown` 永不 hard block，数据集版本、阈值和审批人可追溯。
- 用户确认不豁免平台合规责任。

## 测试标准

- 实现并通过 `pnpm validate:platform-spec-rules`，覆盖三平台规则版本、确认快照、开关默认关闭、holdout 误拦率和 `unknown` 不拦截。

## 验收清单

- [ ] 三平台规则可版本化。
- [ ] 高风险确认可审计。
- [ ] hard block 不误用于 1A，且 2B 未通过校准审批时保持关闭。
- [ ] 2B 对外发布前校准审批必须通过，并仅对审批绑定的规则/评估器版本启用 hard block；未通过时 S23 不得签字完成。
- [ ] 套图和对话电商可接入规范引擎。
