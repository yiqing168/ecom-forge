# S18 1B 批量处理与生成记录导出

| 项     | 内容                                                                              |
| ------ | --------------------------------------------------------------------------------- |
| 状态   | v0.1 可评审                                                                       |
| 阶段   | 1B                                                                                |
| 优先级 | P1                                                                                |
| 目标   | 支持图片资产文件夹组织、电商常见批量上传、批量确认、批量生成、打包下载和 CSV 导出 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/design/01-full-site-screen-flow-spec.md`
- `docs/design/03-v0-full-site-ui-interaction-prompt.md`

## 当前模块范围

包含图片资产文件夹的最小 CRUD/移动、批量任务入口、拆分为多个 workflow/task、并发控制、批量下载、生成记录 CSV。文件夹不是 1A 运行前置；S18 激活前 A07 只提供搜索、筛选、上传、删除和显式加入当前输入。

不包含团队协作、ERP 同步。

## 交付面

| 交付面   | 要求                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| 前端/UI  | 文件夹列表/新建/重命名/删除/移动、批量上传、批量选择商品、单动作开始生成、打包下载                  |
| 后端/API | batch list/create/detail/update/run、内部 quote submit、failed retry、export create/status/download |
| Worker   | 批量拆分、并发队列、失败隔离                                                                        |
| 测试     | 50 SKU fake 批量、并发限制、部分失败                                                                |

## 接口

- 按 `06` §4.2 实现 `GET/POST /api/v1/batches`、`GET/PATCH /api/v1/batches/{id}`、`POST /api/v1/batches/{id}/retry-failed`。
- 文件夹 API 使用 `GET/POST/PATCH/DELETE /api/v1/asset-folders` 及 `POST /api/v1/asset-folders/{id}/move`；所有写操作带 expected revision、幂等键和用户边界，删除前必须处理非空文件夹的明确迁移/拒绝语义，不级联删除资产。
- batch 草稿 PATCH 使用 `expected_revision` compare-and-set；冲突返回 `AGGREGATE_REVISION_CONFLICT`，不得覆盖其他请求的导入或参数。
- “开始批量生成”请求固定 batch revision 和生成动作 digest；服务端创建 quote 并通过内部 submit 原子创建父 workflow_run/reservation，浏览器不二次提交 quote。
- 导出按 `06` §4.2 实现 batch/records export create、status、retry-failed 和 file，不返回持久签名 URL。
- S18 前向 migration 增加 `batches`、`batch_items`、`export_jobs`、`export_job_items`，并给 tasks 增加可空 `batch_item_id`；不得修改 S02 历史 migration。

## 业务规则

- 批量任务必须拆分为可审计 workflow/task。
- 单个 SKU 失败不影响其他 SKU。
- 配置页可以展示总张数和预计积分；点击“开始批量生成”即授权当前动作，不弹费用确认框。
- 打包下载需校验权限。
- 单次批量上限默认 50 个 SKU，这是 1B 的产品和压测基线；运营可按用户等级、队列容量和成本预算下调，提升上限必须重新压测并审批。
- 文件夹名称在同一用户/父文件夹内唯一；跨用户、已删除父文件夹、循环移动和并发 revision 冲突统一 fail closed。

## 测试标准

- 实现并通过 `pnpm validate:batch-50-sku`，覆盖排队、并发限制、部分失败、明确重试、导出和账本一致性。

## 验收清单

- [ ] 50 个 SKU 可排队处理。
- [ ] CSV 包含 SKU、任务、参数、成本、结果。
- [ ] 部分失败可重试。
- [ ] 并发限制生效。
- [ ] 文件夹 CRUD/移动有 revision、空/非空删除、跨用户和循环移动反例；文件夹不影响资产访问授权，删除文件夹不删除资产。
