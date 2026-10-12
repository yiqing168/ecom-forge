# S04 积分账本、报价与交易闭环

| 项目   | 内容                                                                     |
| ------ | ------------------------------------------------------------------------ |
| 状态   | v0.7 S04 已验收，1A 生成提交排队语义回写后待复审                         |
| 阶段   | 1A / D2                                                                  |
| 优先级 | P0                                                                       |
| 目标   | 实现 `quote -> reservation -> workflow_run -> settlement` 的资金安全闭环 |

## 1. 开工前必读

- `docs/01-architecture-and-transaction-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/09-validation-and-operations.md`
- `docs/spec/S05-workflow-queue-worker-and-event-outbox.md`
- `docs/spec/S07-provider-gateway-poc-and-cost.md`
- `docs/spec/S09-deterministic-compiler-r1-r5-and-plan-validation.md`

S05 提供队列 intent/outbox 和 `settlement.execute` payload 基础设施；S04 负责资金状态和结算裁决。S06 只能在 S04 公网提交、取消和重试语义完成后接入。

## 2. 范围与门禁

本轮交付：

- `packages/credit`：账本、账户投影校验、冻结、消费、释放、退款基础能力。
- API：报价创建、报价提交、账户余额和流水查询。
- Worker settlement handler：成功消费、明确失败释放、部分结算和幂等重放。
- 与 S05 的 settlement intent/outbox 对接，以及真实数据库并发/恢复测试。

本轮不交付：第三方支付、充值、会员购买、Provider 真实成本模型、S09 编译器本体、S06 公网 cancel/retry 控制器。

### 2.1 S07/S09 收费门禁

- 报价只能来自服务端 `QuoteProducer`/`PricingPort`。客户端不得提交或覆盖价格、plan snapshot、pricing snapshot、provider cost 或 task 金额。
- `QuoteProducer` 的输入必须是服务端已鉴权的编译结果或持久化草稿快照。S09 未完成时使用显式的本地测试实现，禁止把前端 JSON 当作生产报价来源。
- S07 Provider PoC 和成本核算未通过前，`APP_ENV` 为 test/local 可使用 fake quote producer；staging/beta/production 的真实收费路由启动或请求时必须 fail closed，返回 `COST_MODEL_UNAVAILABLE`，不得用 mock 价格扣费。
- 同一门禁适用于 settlement consumer：当前只允许 local/test Worker 注册；staging/beta/production 在 S07 真实成本能力回写并通过前不得注册该 consumer，即使队列中出现 `settlement.execute` 也不得消费。
- S09 编译失败、输入版本过期、未知价格或计划校验失败时，不创建 quote 以外的资金记录；不得创建 reservation、workflow_run 或 settlement intent。

### 2.2 当前支持的入口

当前只支持 `chat | canvas | suite`。`batch` 等待 S18 前向 migration 和契约回写；S04 不扩展 `trigger_mode` 枚举，也不接受 `batch` 请求。

## 3. 金额和资金不变量

- 所有金额在 API、队列、数据库和日志中使用非负十进制字符串，精度统一由 `packages/shared` 的 Decimal 工具处理；禁止 `number` 算术、隐式转换和各模块自行舍入。
- `credit_ledger` 是唯一资金事实；`credit_accounts.balance/frozen` 是投影。每次余额或冻结变化必须在同一事务写入一条账本记录和新的快照。
- 2026-09-30 重放复核：锁定账户后，对已版本化流水从零或历史空版本前缀的末条快照出发，使用共享 Decimal 工具按 type/amount 逐笔核对余额和冻结快照；中间漂移不得因末条与账户相等而放行。旧无版本前缀只保留原兼容口径，不回填或重写。须覆盖错误符号、中间漂移、冻结不足和后续赠送不产生写入。
- 新流水以锁定账户的 `version + 1` 写入 `credit_ledger.account_version`，重放按账户版本而非 `created_at` 排序；历史空版本仅作前向迁移兼容。`unique(user_id, account_version)` 与账户行锁共同防止并发乱序。
- `reservation_freeze.amount`、`consume.amount` 为负数；`release.amount`、`appeal_refund.amount` 为正数。不得通过相反符号或双写抵消实现同一动作。
- 账户锁定顺序固定为：先锁 `credit_accounts`，再锁目标 reservation/quote；所有热点事务必须有有限超时，事务内禁止网络调用。
- 可用余额不足时返回 `INSUFFICIENT_CREDITS`，不写 reservation、freeze ledger、workflow_run 或 queue intent。
- 每个资金动作拥有稳定幂等键，并由 ledger 唯一约束和事务内状态检查共同防重。相同幂等键和相同语义重放返回原结果；相同键不同语义返回 `IDEMPOTENCY_CONFLICT`。
- 成功提交后必须满足 `estimated_amount = settled_amount + released_amount + outstanding_amount`，其中 `outstanding_amount` 是尚未消费或释放的冻结额；不能释放或消费超过剩余冻结额。

## 4. 服务端报价契约

### 4.1 内部 QuoteDraft

`QuoteProducer` 返回的内部对象至少包含：

```ts
type QuoteDraft = {
  userId: string;
  source: 'chat' | 'canvas' | 'suite';
  sourceId: string | null;
  productId: string | null;
  inputSignature: string;
  promptPreview: Record<string, unknown>;
  planSnapshot: Record<string, unknown>;
  skillSnapshot: Record<string, unknown>;
  pricingSnapshot: Record<string, unknown>;
  items: Array<{
    taskKey: string;
    taskType: string;
    estimatedCredits: string;
    provider: string;
    paramsSnapshot: Record<string, unknown>;
  }>;
  estimatedCallCount: number;
  estimatedTotalCredits: string;
  hasUnknownPrice: boolean;
  expiresAt: Date;
};
```

约束：

- `estimatedTotalCredits` 必须等于 items 金额之和；服务端重新计算并拒绝不一致的 producer 输出。
- 价格、provider、模型版本、计划、Skill 和参数均写入 quote/workflow 快照；submit 时只读取 quote 快照，不重新接受客户端版本。
- `prompt_preview` 只保存给用户看的输入摘要；费用明细单独保存到 `items_snapshot`，只含 task key/type 和预估积分，不得混入 Provider 参数或可执行计划。
- `inputSignature` 必须覆盖 user、source/sourceId、编译指纹或草稿 revision、目标、Skill、参数版本和 pricing rules version；相同活动输入只保留一个 quoted quote。
- `expiresAt` 默认由服务端配置为创建时间后 10 分钟，必须在未来且不得超过服务端最大 TTL 30 分钟。
- `estimatedCallCount` 为非负整数且不得超过单次计划的数量上限；该上限用于约束一次生成请求的规模，不是用户活动 workflow 并发位。空 items 只允许零金额的非收费运行，仍需由 producer 明确返回。
- `hasUnknownPrice=true` 时 quote 可以展示但不能 submit，返回 `COST_MODEL_UNAVAILABLE`，不以用户确认绕过未知价格。

### 4.2 创建报价

`POST /api/v1/run-quotes` 必须带 `Idempotency-Key`。客户端只可提交入口引用和服务端编译指纹：

```json
{
  "source": "chat | canvas | suite",
  "source_id": "uuid?",
  "target_ids": ["uuid"],
  "skill_id": "string?",
  "canvas_compile_fingerprint": "sha256?"
}
```

服务端按 `user_id` 重新鉴权并调用 `QuoteProducer`，不能接受 `estimated_total_credits`、items、plan/pricing snapshot、provider key、完整 prompt 或任意价格字段。无效输入、编译失败、版本过期和 S07/S09 门禁失败均不产生资金记录。

响应：

```json
{
  "id": "uuid",
  "status": "quoted",
  "estimated_total_credits": "12.00",
  "has_unknown_price": false,
  "expires_at": "datetime",
  "items": [{ "task_key": "node-1", "estimated_credits": "12.00" }]
}
```

不得返回 provider secret、内部 key、完整 prompt、数据库实体或未脱敏的资源信息。

## 5. 提交事务

`POST /api/v1/run-quotes/:quote_id/submit` 是历史兼容接口；新生成入口不得让浏览器用它完成第二次费用确认。历史请求必须带 `Idempotency-Key`：

```json
{
  "confirmation_snapshot": {
    "estimated_total_credits": "12.00",
    "currency": "credits",
    "confirmed_at_client": "datetime?"
  },
  "cost_confirmation": "required | not_required"
}
```

服务端不信任 `confirmed_at_client`、客户端 `cost_confirmation` 或调用方自报阈值，金额必须与 quote 快照完全一致。所有新生成 quote 固定 `auto_submit`，只能由内部 intent 调用，并匹配来源聚合的动作 digest、plan digest 与 revision/continuation；公网请求不得提交费用卡、费用模式或金额上限。历史确认证据缺失或内部证据分支不匹配返回 `COST_ACK_REQUIRED`；quote 过期返回 `RUN_QUOTE_EXPIRED`；已提交 quote 的幂等重放返回原 workflow。

以下步骤必须在一个数据库事务中完成，事务内禁止网络调用：

1. 按固定顺序锁定用户 `credit_accounts`，校验可用余额和风险/收费权限。
2. 普通 quote 再按 `quote_id + user_id` 锁定 quote；S09 Agent quote 先锁关联 `agent_turn` 再锁 quote，确认 status=`quoted`、TTL 未过期、输入/授权快照完整。所有涉及 Agent turn + quote 的路径统一 `agent_turn -> run_quote` 子顺序，禁止与 supersede/expiry 反向。
3. 创建 `credit_reservations`，`estimated_amount=quote.estimated_total_credits`，初始 status=`frozen`。
4. 写一条 `reservation_freeze` 负流水并更新账户 `balance/frozen/version`。
5. 创建 `workflow_runs`，写入 quote 的 plan/skill/pricing snapshot，status=`reserved`。
6. 为每个 QuoteDraft item 创建 task，将前置条件满足的 task 标记为 `queued`。
7. 将 workflow 从 `reserved` 推进为 `queued`，标记 quote 为 `submitted` 并回填 `workflow_run_id`。
8. 为首个可执行阶段创建 S05 `workflow.advance`/`task.execute` intent，并在相同事务写入所需 outbox 事件。

用户已有 `queued/running` workflow 不得导致本次 submit 失败；余额与风险校验通过后仍创建 workflow/task 并进入队列。Worker、Provider adapter 和账号级 Provider 配额可以限制实际同时执行数，超出的 task 保持排队，不得把内部吞吐限制转换成用户级“并发位已满”。

若任一步失败，整个事务回滚，不能留下单独 reservation、冻结流水、workflow 或 dispatch intent。网络发布由 S05 dispatcher 在事务提交后执行。

S09 前向扩展时，以上事务主体下沉为 `packages/credit` 的共享 application function。API 显式 submit 与 Worker `agent.quote.submit` Consumer 只构造 strict submission evidence 并共同调用该函数；queue intent/outbox 以 transaction-aware port 注入。Worker 不得 import `apps/api`、内部回调 HTTP 或复制资金事务。

提交响应至少返回 `workflow_run_id`、`reservation_id`、用户可展示的费用摘要和 `status=queued`，不返回内部 dispatch 状态。

## 6. Settlement 结算

Worker 只发布 `settlement.execute` intent，不能直接写账本。payload 使用 06/S05 已冻结的 schema，`idempotency_key` 固定为 `settle:task_attempt:{task_attempt_id}`。

Credit settlement handler 在数据库事务内：

- 锁定 task attempt、reservation 和 account，验证它们属于同一 user/workflow，且回执状态允许结算。
- `succeeded` 且内容安全已通过时，消费该 task 对应的实际/封顶金额；实际成本缺失时只能使用 quote item 已冻结金额，不得从客户端读取。
- provider 明确 `not_dispatched`、任务明确失败或内容安全拒绝时，释放该 task 尚未消费的冻结额；没有任何已消费金额时不写 consume。
- 部分成功只消费已确认金额，剩余冻结额保持 reservation 的 outstanding；全部 task 终局后再将剩余额一次性 release，reservation 进入 `settled` 或 `released`。
- `accepted`、`polling`、`outcome_unknown`、回执丢失或 Provider 账单未知时禁止 consume、release、refund 和自动重投，保持冻结并进入人工/定时处理队列。
- 已处理的 settlement 重放必须返回原 ledger/result，不产生第二条 consume/release；非法状态迁移 fail closed。

结算与 task/workflow 状态变更的原子边界遵循 S05：状态 CAS、资金账本和必要 outbox 在同一事务，外部 Provider 查询不在事务内。

## 7. 释放、退款与申诉

- 用户取消只对 `not_dispatched` 或明确未送达任务释放未结算冻结；`accepted/outcome_unknown` 进入人工处理，不自动退款。
- 运行完成、失败、内容安全拒绝和 outcome_unknown 30 分钟自动释放按 `04` 状态机处理。该超时只关闭用户资金冻结，不改变 Provider 结果证据，也不承诺有人核对。
- 退款/申诉只追加 `appeal_refund` 流水，不修改历史 `consume`；审批权限、幂等键和审计由 S14 管理台契约定义。
- release/refund 的金额不得超过 reservation 剩余冻结或可退款上限；所有冲正必须可由 ledger replay 重建。

## 8. API 查询

### `GET /api/v1/credits/account`

按当前 session 返回：

```json
{
  "balance": "88.00",
  "frozen": "12.00",
  "available": "88.00",
  "currency": "credits",
  "as_of": "datetime"
}
```

`balance` 在当前数据模型中就是可用余额投影，`available` 为同值的明确展示字段；`frozen` 单独表示已预留金额。客户端不得自行推导资金事实。若 projection 与 ledger replay 不一致，返回 `CREDIT_ACCOUNT_UNAVAILABLE`，不返回猜测值。

### `GET /api/v1/credits/ledger`

按当前用户分页返回脱敏流水：`id/type/amount/balance_after/frozen_after/reservation_id?/workflow_run_id?/created_at`。必须 user_id 隔离、keyset 分页、默认 20 最大 100，不返回 metadata 中的密钥、prompt、Provider 原文或内部凭据。

## 9. 错误语义

沿用 06 的统一错误 envelope 和错误码：`RUN_QUOTE_EXPIRED`、`COST_ACK_REQUIRED`、`INSUFFICIENT_CREDITS`、`RESOURCE_BUSY`、`IDEMPOTENCY_CONFLICT`。S04 不以用户已有活动 workflow 数量拒绝 submit。S04 新增并回写 06：

| code                         | HTTP | 用户可见消息                     |
| ---------------------------- | ---- | -------------------------------- |
| `COST_MODEL_UNAVAILABLE`     | 503  | 当前价格不可用，请稍后再试       |
| `CREDIT_ACCOUNT_UNAVAILABLE` | 503  | 积分账户暂时不可用，请稍后再试   |
| `RESERVATION_STATE_INVALID`  | 409  | 这笔任务状态已变化，请刷新后查看 |
| `SETTLEMENT_PROTECTED`       | 409  | 任务结果仍在确认中，请等待处理   |

内部错误不把 SQL、Provider 回执、价格计算堆栈或用户账户是否存在暴露给客户端。

## 10. 测试与验收

### 10.1 单元测试

- Decimal 金额、符号和边界；账本 projection 与 replay 一致性。
- grant/freeze/consume/release/partial settlement/refund 的状态迁移和非法迁移。
- 相同幂等键重放、不同 payload 冲突、过期 quote、确认快照不匹配、未知价格 fail closed。

### 10.2 真实集成测试

使用隔离的 `_test` 数据库。API 真实集成测试中，应用的 `DATABASE_URL` 与 fixture 的 `TEST_DATABASE_URL` 必须指向同一个 `_test` 数据库，确保测试覆盖真实事务边界；若数据库名不含 `_test`，测试启动失败。Redis 使用独立 `TEST_REDIS_PREFIX`。禁止连接开发/生产数据库，禁止删库、重建库、修改历史 migration、`DROP/RESET/FLUSHALL/FLUSHDB`；fixture 只删除带本次 `test_run_id` 的精确记录。

- 重复点击 submit 只创建一次 reservation、workflow 和 dispatch intent。
- 并发 submit 只有一个冻结成功，余额不足不产生半成品。
- 用户已有活动 workflow 时，新 submit 仍创建独立 reservation/workflow 并进入队列；每次动作只冻结一次。
- 事务故障回滚不留下 account、ledger、reservation、workflow 或 intent 半成品。
- 两个并发 settlement 重复回执必须恰好一个实际应用、一个幂等重放，只写一条 consume 和一条对应 outbox；accepted/outcome_unknown 不提前结算。
- Worker 崩溃/重启后 settlement 不重复扣费；ledger replay 能重建账户投影。
- 用户只能查看自己的 account、ledger、quote 和 workflow。

### 10.3 门禁

开发完成后执行相关包测试、`pnpm test:integration`、`pnpm test:worker`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm check`、`pnpm db:check` 和 S04 专项验证脚本。通过 Codex 正反向代码审查和用户验收后才允许提交。

## 11. 交付顺序

1. 复审并冻结本 SPEC 与 06 错误码/入口口径。
2. 实现 `packages/credit` 领域服务和测试。
3. 接入 API quote/submit/account/ledger；使用显式 `QuoteProducer` port。
4. 接入 S05 settlement intent、Worker handler 和恢复测试。
5. 完成全门禁、正反向代码审查，等待用户验收。
