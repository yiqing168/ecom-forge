# S17 1B 创意质量版本、Preset 与高清工具扩展

| 项     | 内容                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 状态   | v0.2 首版 Skill 前移后待复审                                                             |
| 阶段   | 1B                                                                                       |
| 优先级 | P1                                                                                       |
| 目标   | 基于 1A 数据扩展首版 Skill 的质量版本、原创 Preset、评测覆盖和高清工具，并筛选后续新候选 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` §2.4
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/09-validation-and-operations.md`
- `docs/research/01-full-site-product-interaction-benchmark.md` §4.7、§5
- `docs/research/02-agent-skill-content-adoption.md` §10-§13
- `docs/spec/S13B-first-release-specialized-creative-skills-e2e.md`

## 当前模块范围

包含 1A 已发布的 10 个创意 primary 的评测扩容、基于真实内测失败样本形成的质量版本、原创 Preset、高清放大，以及经产品评审的新 Skill 候选实验。当前清单中的 10 个创意 primary 均由 S11/S13A/S13B 在 S15 前交付，S17 不把它们重新计为新增能力，也不能成为首版缺口的补交任务。

不包含公开模板市场、视频、画布，也不承诺某个新候选必然发布。公开参考只用于需求与方法研究，不复制正文、配置、命名、示例或资产。

## 交付面

| 交付面      | 要求                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| Agent/Skill | 现有 Skill 新版本、原创 Preset/L2、eval dataset 版本；新候选仅在独立评审通过后成包   |
| 前端/UI     | 现有 Skill/Preset 的版本化展示、质量版本灰度和高清放大结果；不增加无能力支撑的空入口 |
| Provider    | 高清模型能力校验、真实 PoC、成本估算和 SKU/quote                                     |
| 测试        | 1A 失败样本回归、每个变更 Skill 至少 5 类样本 x 3 用例、高清质量与费用断言           |

## 业务规则

- Skill、Preset、L2 和 eval dataset 的新版本都不可原地覆盖；运行中 turn 固定 1A 创建时快照。
- 未通过扩展 golden eval、原 1A 回归集和来源权利检查不得发布；不能用只提高漂亮样片得分的版本替换安全、保真或素材职责稳定性。
- 新 Skill 候选必须来自 1A 数据或独立产品评审，重新证明用户任务、素材职责或输出结构确实不同；单纯美术方向继续建模为 Preset。
- 新版本或新候选不得放宽 R1-R5、交易、内容安全、人物授权、原像素 lineage 和事实边界。
- 高清放大使用独立模型能力契约，必须先完成真实 PoC、失败成本摊销和定价审批；未通过前不得进入可收费路由。
- 本 SPEC 开工前按主计划 2-5 个开发日规则重新估算；若质量版本、Preset、评测扩容、高清放大和新候选实验无法在上限内完整交付，先拆出非阻断的新候选，不得减少安全、保真、文字、合成或 golden eval 覆盖来维持单 SPEC。

## 测试标准

- 单测覆盖 Skill/Preset/eval 版本、loader 和 release closure。
- golden eval 同时覆盖 1A 回归集、内测失败样本、意图、计划、素材职责和计价断言。
- Playwright 覆盖至少一个现有 Skill 质量版本灰度、回滚和高清放大；只有实际发布新候选时才要求对应入口链路。
- 实现并通过 `pnpm validate:golden-eval-extension`，覆盖变更 Skill、Preset、可选新候选、高清放大质量和 quote 成本断言。

## 验收清单

- [ ] 1A 首版内容不依赖本 SPEC 补交，S15 上线门禁可独立通过。
- [ ] Skill 质量版本、Preset 和可选新候选可灰度发布和回滚，旧 turn 不漂移。
- [ ] 评测记录和来源权利记录可追溯，并证明没有回归 1A 安全/保真边界。
- [ ] 高清放大成本进入 quote。
- [ ] 高清放大 PoC、成本审批和 `validate:golden-eval-extension` 通过。
- [ ] 失败不重复扣费。
