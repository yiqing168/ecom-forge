# S22 2B 套图流水线

| 项     | 内容                                                     |
| ------ | -------------------------------------------------------- |
| 状态   | v0.1 可评审                                              |
| 阶段   | 2B                                                       |
| 优先级 | P1                                                       |
| 目标   | 实现商品套图流水线、主图套图、详情页/A+ 子模式和上架文案 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` 阶段 2B
- `docs/01-architecture-and-transaction-contract.md`
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/design/01-full-site-screen-flow-spec.md`
- `docs/design/03-v0-full-site-ui-interaction-prompt.md`

## 当前模块范围

包含套图配置表单、资产库参考图、智能匹配、批量出图、上架文案、对话电商第二批技能。

不包含送入画布的前端入口和画布编辑体验；S22 只实现产物可挂载到画布的数据准备。S22 可独立完成 staging 验收，但套图能力不得在 S24 前单独对外发布。

## 交付面

| 交付面   | 要求                                                                 |
| -------- | -------------------------------------------------------------------- |
| 前端/UI  | 套图表单、结果组、批量下载、文案卡                                   |
| 后端/API | suite list/create/detail/update/run、内部 quote submit、failed retry |
| Worker   | 多任务 DAG、并发、失败隔离                                           |
| 测试     | 7 张套图单动作生成、积分预留、部分失败                               |

## 业务规则

- 套图必须按商品/SKU 组织。
- A04 新会话空态在 2B+3a 发布门禁通过后显示 PRD §2.4.6 的单卡双入口；“套图”进入 B09，“对话”聚焦 A04 输入框，不新增首页页面族，1A 不显示未开放套图按钮。
- S22 前向 migration 按 `05` 增加 `suites`、`suite_items` 并给 tasks 增加可空 `suite_item_id`；草稿、报价、分组结果和部分失败不得只存在前端状态。
- 按 `06` §4.2 实现 suite list/create/detail/update/run/retry；运行请求固定 suite revision 和生成动作 digest，服务端创建 quote 并通过内部 submit 预留积分。
- suite 草稿 PATCH 使用 `expected_revision` compare-and-set；商品事实、输入素材或配置变化必须使旧 quote 失效。
- 套图批量下载/记录导出复用 `POST /api/v1/suites/{suite_id}/exports` 和统一 export status/file 接口，不在 HTTP 请求中同步打包。
- 套图流程顺序：同商品 1-6 张素材 -> 平台/国家/语言/比例 -> 商品卖点/事实 -> 智能匹配或自定义图类型 -> 附加项 -> 明确总张数和预计积分 -> 点击生成 -> 分组结果。智能匹配只给建议，不替用户确认商品事实或自动点击生成。
- 点击“生成套图”即授权当前配置，服务端在 Provider 前报价、核对并预留，不弹费用确认框。
- 套图产物支持画布挂载所需的稳定 artifact 元数据和 `canvas_node_id` 回填协议必须在 S22 实现。
- S24 完成前，前端不渲染“送入画布”按钮，不使用灰色占位或“即将上线”文案；S24 上线时再接入并开放该入口。
- 2B 套图与 S24 的 3a 修改出口使用同一对外发布门禁，避免向用户交付无法继续精调的半闭环。

## 测试标准

- 实现并通过 `pnpm validate:suite-7-images`，覆盖单动作提交、7 张结果、部分失败、商品归档和账本一致性。

## 验收清单

- [ ] 上传 1 张商品图可产出一套主图。
- [ ] 费用和任务可审计。
- [ ] 结果按商品归档。
- [ ] S24 未完成时页面不存在画布入口；挂载数据协议可由契约测试验证。
- [ ] S24 未通过验收时，S22 只允许在 staging/内部账号验证，不进入公开发布。
