# S25 3b 画布第二刀：整链运行、导出与模板

| 项     | 内容                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 状态   | v0.2 待产品评审                                                        |
| 阶段   | 3b                                                                     |
| 优先级 | P2                                                                     |
| 目标   | 在 S24 手工画布上实现确定性整链编译/运行、失败恢复、导出和画布模板版本 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` §1.2、§2.5、阶段 3b
- `docs/01-architecture-and-transaction-contract.md`
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/research/01-full-site-product-interaction-benchmark.md` §6
- `docs/spec/S24-canvas-first-cut-node-editing-version-history.md`

## 产品边界

- 整链是用户已手工搭建 DAG 的确定性执行，不由 Agent 重新规划、增删节点或改参数。
- 点击“运行工作流”即授权当前整链动作，不出现计划确认或费用确认；图结构/参数变化后旧报价失效。
- 单节点运行始终保留，整链不是唯一入口。
- 画布模板保存图结构和公开允许的参数/占位，不携带原作者私有素材、密钥、商品事实或修改权。

## 上游契约实施门禁

`05/06` 已冻结 canvas compile、run quote 绑定、export job/template 不可变版本、SSE 投影和错误码；整链状态继续复用 `04` 的 workflow/task/attempt，不新增 canvas-only 状态机。S25 开工前只需确认 S24 已按这些契约完成 migration/API；S25 通过前向 migration 启用 `export_jobs/export_job_items` 和 canvas template 版本字段，任何 payload 或模板字段变更仍须先回写 `05/06` 并复审。

## 当前模块范围

包含 C02 的 3b 状态：DAG 编译、整链报价/直接提交、依赖调度、节点进度、部分失败、恢复/明确重试、结果打包导出、发布画布模板、从模板创建副本。

不包含 UGC 模板审核市场、多人实时协作、复杂时间线和自动 Agent 铺图，归后续阶段。

## 交付面

| 交付面    | 要求                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| 前端/UI   | 顶栏整链运行、编译问题面板、预计积分、节点/边进度、任务日志、导出、发布模板               |
| 后端/API  | canvas compile/quote/run/status/export/template version                                   |
| Worker    | DAG 依赖调度、幂等任务创建、失败隔离和恢复                                                |
| 数据/账本 | graph/plan/version 快照、workflow/task/attempt、artifact lineage、一次 reservation 和结算 |
| 测试      | DAG 校验、并发/恢复、部分失败、导出权限、模板隐私和账本一致性                             |

## 整链编译契约

用户点击“运行工作流”后先做只读编译，至少校验：

1. 节点/边 schema、稳定 ID、重复 ID、悬空边和未知节点类型。
2. DAG 环检测；错误返回最短可解释环和可定位节点，不只返回“编译失败”。
3. 输入类型/数量/顺序/角色、必填输入、失效 `@` 和上游 readiness。
4. 用户/租户、R1-R5、素材/产物权限、隔离和删除状态。
5. Skill/模型/Provider 准入、版本、配额、内容安全和平台规则要求。
6. 每个收费节点参数规范化、幂等指纹、成本和整链 token/积分/节点预算。
7. Provider 限流与排队计划；整链 workflow_run 不占用户并发位，超出实际执行吞吐的 task 保持排队。

编译输出是确定性执行快照，包含拓扑序、节点输入版本、模型/Skill/计价版本、参数和费用；LLM 不可修改编译结果。`graph_json` 不是运行真相，真实进度落 `workflow_run -> task -> task_attempt`。

## 整链单动作提交

- 点击运行后先完成只读编译；界面可展示收费节点数、预计产物数、总积分、费用构成、并发/预计等待和退款/结果未知说明，但不要求第二次点击确认。
- 编译通过后由内部 submit intent 同事务创建 reservation + workflow_run，并按编译快照创建/入队任务。
- 重复点击返回同一 run；报价过期、图/参数/输入版本变化时重新编译和报价。
- 编译失败、权限失败或余额不足不得创建收费 run。
- 运行中新增/移动/删除节点不改变已提交快照，只影响下一次运行。

## 调度与进度

- 仅 readiness 满足的节点入队；同一节点只由稳定幂等键创建一次任务。
- 每个节点显示未运行/等待上游/排队/生成/检查/成功/失败或需处理；边展示依赖已满足与流向，不用动画作为唯一信息。
- 顶栏展示整链用户状态、成功/失败/等待数量和费用摘要；任务日志提供可访问的节点文字列表、时间和 trace ID。
- 成功分支产物立即按内容安全规则可见；隔离产物不进入下游 readiness。
- 用户离开、刷新或 SSE 断开不终止整链；恢复先拉 run/task 快照再续订事件。

## 部分失败与恢复

- 一个节点失败只阻断其依赖下游；无依赖的其他分支继续。成功节点和产物不回滚。
- `not_dispatched` 可按 `04` 自动或明确重试；accepted/outcome_unknown 绝不由 BullMQ attempts 自动重投。
- 失败节点保留最后成功版本，但当前 run 的下游不得静默使用旧版本。
- 用户点击“重试失败分支”前重新编译受影响子图和费用；若属于同 reservation 内允许的未送达重试，清楚显示不新增费用，否则创建新 quote/run。
- 取消遵循 run/attempt 状态：未送达可释放，已受理只请求取消，结果未知进入兜底；UI 不承诺 Provider 已停止。
- 恢复 Worker 时从数据库任务和 outbox 真相重建，不从前端节点颜色推断。

## 导出

- 可选择本次成功产物、当前画布选定产物或全部可下载产物；默认排除失败、隔离、删除和无权限项。
- 导出任务异步执行，生成短期签名下载；每次下载重新鉴权并记录活动日志。
- `export_id` 必须落 `export_jobs`，逐项状态落 `export_job_items`；asset 队列 job 只传持久化 export ID。
- 文件名/目录含画布、节点、版本等可读信息，不泄露 storage key、Provider 请求或内部 prompt。
- 部分导出失败提供清单和明确重试，不重新生成原产物。

## 发布与使用画布模板

- 发布前列出将保留的节点/边/公开参数和将移除的私有素材、商品事实、签名 URL、用户 ID、密钥及产物修改权。
- 模板使用占位输入；原作者私有资产不会打包。引用公开参考素材时必须保留授权/来源。
- 每次发布创建新的 `templates.id` 不可变版本，同一系列复用 `template_key` 并满足 `unique(template_key,version)`；更新不覆盖已使用版本。
- 从模板创建的是当前用户的新画布副本，需补齐必填输入后才能编译；不继承原画布运行状态或修改权。
- 3b 只支持用户自己的私有/受控模板发布；UGC 市场审核后置。

## UI 交互

- 顶栏新增“运行工作流”；编译失败打开问题面板，点击问题定位并选中节点/边。
- 编译通过才允许创建 reservation/workflow；DAG 无效或余额不足时就地提示，不打开确认框。
- 执行中可继续编辑未来版本，但明确显示“本次运行使用已提交快照”。
- 任务日志抽屉可按失败/运行/成功筛选并定位节点；移动端 C02 只读态可查看该列表。
- 导出和发布使用独立 overlay；高风险动作说明影响范围并防重复提交。

## API/队列面

按 `06` §4.1 实现/复用 compile、quote/submit、run snapshot、cancel/retry、export create/status/download、template publish/version/create-from-template。失败子图重试仍通过 workflow retry 与新 compile/quote 表达，不新增私有状态接口；队列 payload 只引用持久化 run/task/export ID，不携带完整私有图快照或签名 URL。

## 测试标准

- 实现并通过 `pnpm validate:canvas-dag-run`。
- 编译测试：合法多模态链、环、悬空边、非法类型、缺输入、失效 `@`、隔离/越权、未准入模型、预算超限。
- 并发/幂等：重复运行点击、同节点重复 job、Worker 重启、outbox 重放、SSE 断档、图在报价后变化。
- Provider/账本：not_dispatched、accepted、outcome_unknown、30 分钟自动释放、部分结算、明确新建生成和 ledger replay。
- Playwright：商品原图 -> 精修 -> 一对多裂变 -> 图生视频；单动作运行且无费用确认框；部分失败后只恢复失败分支；刷新后状态一致。
- 导出/模板：跨用户拒绝、隔离排除、签名过期、私有字段剥离、模板版本不可变、从模板创建新归属。
- 可访问性：进度不用纯颜色，问题面板可键盘定位节点，移动端能查看任务和下载。

## 验收清单

- [ ] 整链编译能定位所有 DAG/权限/输入问题，LLM 不能改写结果。
- [ ] 用户点击“运行工作流”后直接进入编译、积分核对和执行，不出现计划确认或费用确认。
- [ ] 运行、刷新、Worker 恢复和 SSE 重连不重复任务/扣费。
- [ ] 部分失败不抹掉成功分支，明确重试遵循 Provider 三态。
- [ ] 导出排除隔离/越权内容并重新鉴权。
- [ ] 模板不泄露私有素材/事实/密钥，版本不可覆盖。
