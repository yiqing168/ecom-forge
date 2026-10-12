# S14B 完整运营管理台

| 项     | 内容                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 状态   | v0.1 从原 S14 拆分后待复审                                             |
| 阶段   | 1A / S13B 后、S15 前                                                   |
| 优先级 | P0 上线门禁，不阻塞 S11-S13B 开发                                      |
| 依赖   | S11、S12、S13A、S13B、S14A 已验收                                      |
| 目标   | 在真实生图闭环已经跑通后，补齐封闭内测上线所需的运营、风控和审计控制面 |

## 开工前必读

- `docs/spec/S14-user-center-and-minimal-admin-console.md`
- `docs/proposals/admin-control-plane-architecture-and-security.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/spec/S12-commerce-white-background-refine-e2e.md`
- `docs/spec/S13-creative-generation-and-chat-edit-e2e.md`
- `docs/spec/S13B-first-release-specialized-creative-skills-e2e.md`

## 1. 边界与顺序

S14B 复用 S14A 的独立 Admin 身份域、权限 Guard、step-up、幂等、审计、查询分页适配器和应用壳，不建立第二套管理系统。固定顺序为：

```text
S14A -> S11 -> S12 -> S13A -> S13B -> S14B -> S15
```

S14B 是 S15 的前置，但不是 S11-S13B 的前置。S14A 已经提前实现的 S14B 后端能力可以直接收口和补测；不得为了文件数量或重写界面回滚可用领域代码，也不得把未完成菜单显示给管理员。

`S14-user-center-and-minimal-admin-console.md` §8 是本阶段用户中心与运营 API 的唯一契约索引：其中除 S14A 五个页面直接使用的接口外，其余用户、任务、资金、申诉、奖励、Skill、管理员和审计健康接口均由 S14B 负责产品化页面、权限覆盖和验收。S14B 不复制或改写这些接口的路径、payload、错误码、权限和状态语义；需要新增或变更时，必须同时回写 `docs/06-api-queue-and-event-contract.md` 并完成复审。

## 2. 交付模块

S14B 补齐以下 7 个运营模块，并增强 S14A 已有页面：

| ID  | 模块             | 完整闭环                                                                                |
| --- | ---------------- | --------------------------------------------------------------------------------------- |
| O01 | 运营总览         | 环境/时间筛选、任务/成本/失败/unknown、队列积压、风险告警和待审批入口                   |
| O03 | 用户与风险       | 脱敏查询、详情、风险 revision、冻结/限制、普通 Session 撤销和操作历史                   |
| O04 | 任务与运行       | workflow/task/attempt 查询、证据摘要、允许的取消/恢复；禁止任意改状态或重投 unknown     |
| O09 | 资金、申诉与奖励 | ledger 对账、只追加冲正、申诉裁决、奖励活动版本/预算/停用；禁止修改历史流水             |
| O10 | Skill 与发布     | `.skillpkg` 上传、隔离验证、审批、release diff、发布、停用和回滚                        |
| O11 | 管理员与安全     | principal、角色/scope、enrollment、MFA、恢复码、Session 撤销、最后 super_admin 并发保护 |
| O12 | 审计与系统健康   | actor/action/target/result/time 查询、敏感读取/拒绝审计、DB/Redis/队列/存储/Worker 健康 |

S14A 已交付 O02（邀请码）、O05（Provider）、O06（Storage）、O07（模型）、O08（规格与积分）。S14B 对这些页面的增强包括：邀请码活动/批次/转化与奖励联动；Provider/Storage 高级健康与轮换证据；模型/价格影响检查和批量运营能力。S12 激活内容安全人工处置 API 后才注册 O13“内容安全审核”菜单；API 未激活时不得显示空入口。

## 3. 用户中心

`apps/web` 补齐注册昵称只读展示、积分余额/流水、任务列表与详情、用户取消/明确重试、申诉提交、我的资产逻辑删除、我的作品、账号安全和退出。1A 使用昵称首字头像，不增加头像上传/审核链路；头像编辑归 S21。用户中心只调用普通用户 API，不访问或链接 `apps/admin`，也不复用 Admin Session。

## 4. 领域规则

- 所有列表必须有领域查询条件、用户/环境边界和 cursor 分页；筛选变化清空 cursor 链，不伪造 total。
- 所有高风险写操作必须携带 reason、expected revision、`Idempotency-Key` 和有效 step-up；成功业务变化与成功审计同事务。
- 风险冻结、任务取消/恢复、申诉退款、账本冲正和奖励发放必须调用现有领域 Service，不能由 Controller 或前端直接改状态/账本。
- `accepted/outcome_unknown` 不得重投、切换模型或提前退款；只允许进入证据和人工处置视图。
- Skill 发布复用 S08 package/release Service，运行中 turn 保持创建时版本，不热升级。
- `DELETE /api/v1/assets/{asset_id}` 只允许本人并要求幂等键；存在非终局 turn/workflow 引用时返回 `ASSET_IN_USE`，不得破坏运行中输入。成功后立即逻辑删除、关闭新访问/绑定并写用户安全审计；物理对象只由 S15 的保留期清理 Worker 处理。
- 用户任务中心启用 `POST /api/v1/workflow-runs/{run_id}/cancel` 与 `POST /api/v1/workflow-runs/{run_id}/retry`。取消只对服务端确认未送达且可释放的部分生效；活动中的 `accepted/polling/outcome_unknown` 返回稳定冲突并保留人工证据。明确重试必须指定结果已确定失败的 task，点击本身作为新动作授权；原终态记录不变，并以新 quote/reservation/workflow/task 只重试该项，不弹费用确认框。两条路径都复用 S04/S05 领域 Service，不允许前端改状态或直接退款。
- S12 激活后，S14B 提供内容安全人工处置页面，消费 S12 的 `/api/v1/admin/content-reviews` 队列/详情/裁决 API；未激活前不注册 O13 菜单。
- 管理员不得给自己提权、停用最后一个可用 super_admin 或移除自己唯一有效 MFA；并发变更使用同一 advisory lock + revision CAS。
- 列表、详情、审计和日志继续禁止完整邮箱、prompt、签名 URL、Key、TOTP、恢复码、邀请码明文/digest、Provider 原始错误和图片二进制；只有 S14A 已裁决的生成/显式 reveal 接口可在 step-up、权限、审计和 `no-store` 约束下返回邀请码明文，不得扩展到其他响应。

## 5. 前端要求

- 复用 S14A 的 Next.js + antd/ProComponents 技术栈和固定/可收起侧栏，不引入 Umi/Max 或第二套路由、表单、权限框架。
- 页面采用筛选区、表格、详情抽屉和明确领域动作；右侧内容不重复菜单分组标题。
- 下拉框显示中文 `label`，API 使用稳定英文 `value`；状态必须使用中文用户语义，内部枚举可在详情证据区辅助显示。
- 覆盖加载、空、错误、403、409、step-up 过期、幂等重放和部分依赖不可用状态。
- 桌面支持完整动作；390px 仅支持查询和明确允许的紧急熔断，不提供批量发布或复杂资金操作。

## 6. 测试标准

- API 集成测试覆盖最小角色逐模块 403、跨用户/环境隔离、审计失败回滚和 step-up/幂等/revision 反例。
- 资金、风险、任务、奖励和管理员变更必须覆盖失败与真并发单赢家，不接受纯 mock。
- Playwright 使用真实 Admin API 覆盖用户冻结与撤销、任务证据、申诉裁决、Skill 发布、管理员 enrollment 和审计追踪。
- Playwright 使用真实普通用户 API 覆盖任务查询、可取消/不可取消、not_dispatched 明确重试、accepted/outcome_unknown 新报价重试、资产删除和申诉；刷新/重复点击不得重复投递或扣费。
- 所有查询页覆盖筛选、上一页/下一页、筛选重置、空页、重复 cursor、请求失败和 409 刷新。
- E2E 使用隔离 test DB/Redis/object root，按 run ID 精确清理；禁止删库、重建库、`FLUSHALL`/`FLUSHDB`。
- 新增 `pnpm validate:operations-control-plane`，以真实 PG/Redis/私有测试对象根验证七个模块的权限、幂等、revision、审计回滚、资金/任务三态和真并发；新增 `pnpm test:e2e:s14b-live`，用真实 Admin/普通用户浏览器分别验证管理闭环与用户中心。建议测试归属：`apps/api/test/s14b-operations.e2e-spec.ts`、`apps/admin/e2e/s14b-operations-live.spec.ts`、`apps/web/e2e-live/s14b-user-center-live.spec.ts`。

## 7. 验收清单

- [ ] 7 个 S14B 模块和 S14A 高级增强均使用真实 API，无 mock、万能入口或空菜单。
- [ ] 用户/环境隔离、权限、step-up、幂等、revision 和审计失败回滚全部有反例测试。
- [ ] 资金只追加、申诉/风险/奖励/任务操作均经领域 Service，unknown 路径不发生资损或重复投递。
- [ ] Skill 安装、验证、审批、发布、停用和回滚闭环，运行中 turn 不升级。
- [ ] 管理员 enrollment、MFA/恢复码轮换、Session 撤销、角色变更和最后 super_admin 保护闭环。
- [ ] 用户中心的注册昵称、任务查询/取消/明确重试、积分、申诉、资产逻辑删除、作品、账号安全和退出可用；删除立即关闭访问且不破坏活动任务，未激活的头像、通知、会员或购买入口不显示。
- [ ] S12 激活后 O13 内容安全人工处置可查询隔离证据并裁决，审核 unknown 不得直接通过；S12 未激活时 O13 不显示。
- [ ] 桌面/移动截图、真实 Playwright、全仓门禁和人工安全检查通过。
