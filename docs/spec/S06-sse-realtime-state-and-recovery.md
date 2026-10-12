# S06 SSE 实时状态与断线恢复

| 项     | 内容                                                                                        |
| ------ | ------------------------------------------------------------------------------------------- |
| 状态   | v0.3 实现完成，待验收                                                                       |
| 阶段   | 1A / D2-D3                                                                                  |
| 优先级 | P0                                                                                          |
| 目标   | 以 `event_outbox` 为真相，实现 workflow/task 的 SSE 实时投影、心跳、断线补齐和前端 watchdog |

## 1. 开工前必读与依赖

- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/spec/S03-auth-invite-beta-and-user-foundation.md`
- `docs/spec/S04-credit-ledger-quote-and-transaction.md`
- `docs/spec/S05-workflow-queue-worker-and-event-outbox.md`

S03 的 session、S04 的 workflow/资金事务和 S05 的 outbox primitive 必须已完成。S06 不修改资金、Provider、Agent 或任务状态机，只读取已提交状态并投影给当前用户。

编码前必须先审计所有已存在的 `event_outbox.event_type/payload` 是否符合 `06` §8。本轮已发现的 `workflow.queued`、`credit.settlement_applied` 与正式事件表不一致，必须在 SSE 公网透传前修正为已裁决事件名和 payload，并补生产者契约测试；不得把既有实现偶然写入的字符串反向固化为公网协议。

## 2. 范围与分阶段激活

### 2.1 本轮包含

- `GET /api/v1/events` 的 session 鉴权、scope owner 校验、outbox replay 和长连接生命周期。
- `workflow_run:{uuid}` scope；该流同时承载 workflow、task 和 credit 的用户可见事件。
- Redis pub/sub wake-up、API 多实例本地连接 fanout、丢 wake-up 后的数据库补齐。
- Web 可复用 SSE client/hook：snapshot-first、`last_event_seq`、去重、watchdog、退避重连和轮询降级。
- 连接中、在线、重连中、已恢复、轮询降级、已断开六种可访问状态；不清空已显示内容。
- Supertest/真实 PostgreSQL + 隔离 Redis 集成测试，以及 Playwright 断线/刷新恢复测试。

### 2.2 本轮不包含

- WebSocket、GraphQL subscription 或把 Redis Stream 当第二业务真相。
- 新 Agent turn/session 写接口、正式 Agent 工作台或任务中心产品页；这些分别由 S08/S11/S14 交付。
- `turn/session/canvas/batch/suite/export` scope 的公网激活。`06` 已保留未来总契约，但它们必须等所属 SPEC 提供 owner resolver、snapshot API 和事件 producer 后再启用；S06 不造空壳订阅能力。
- 管理员订阅。管理台是独立控制面，后续只能通过独立 Admin Session、permission、resource scope 和审计入口接入，普通用户 SSE 路由不接受管理员旁路参数。
- 自动删除或归档 outbox。当前按 `05/06` 保留全部事件；S15 引入清理前必须保证 scope 高水位不因删除归零，禁止直接删除某 scope 全部事件后继续使用 `max(event_seq)+1`。

现有 `apps/web` 任务中心仍是已评审 mock 原型，S06 不把 mock 数据与真实 API 混成双状态源。S06 交付可复用连接基础和测试承载面；S11/S14 接入正式页面时只能复用该客户端，不得另写第二套 SSE 状态机。

## 3. 公网接口契约

```text
GET /api/v1/events?scope=workflow_run:{uuid}&last_event_seq={0..2147483647}
```

请求规则：

- query 必须严格只含 `scope` 和可选 `last_event_seq`；未知字段、重复字段、空值、非十进制、负数、小数、指数形式、前导符号或超出 PostgreSQL integer 上限均返回 `REQUEST_INVALID`（400）。
- `last_event_seq` 缺省为 `0`。不得同时定义或接受 `Last-Event-ID` 作为恢复契约，防止代理/浏览器隐式游标与 query 双轨。
- 先验证 session，再按 `workflow_runs.id + user_id` 验证 owner，最后才发送 SSE headers。资源不存在和属于其他用户统一返回 `RESOURCE_NOT_FOUND`（404），不得以时序、状态码或首包差异泄露资源存在性。
- 未登录返回 `AUTH_SESSION_REQUIRED`（401）。SSE 只允许 cookie session，不接受 query token、Bearer token、分享 token 或前端传入 user ID。
- 同源浏览器请求携带 HttpOnly cookie；Web 不读取或复制 session token。响应刷新出的 cookie 仍通过既有认证适配器回写。

成功响应 headers 至少包含：

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Nginx/CDN 对该路径必须关闭响应缓冲和压缩聚合，不缓存、不做跨用户连接复用。普通产品 ingress 只代理 `/api/v1/events` 到 API；管理台 host 和普通 host 的访问边界不在 SSE 内降级。

### 3.1 事件帧

持久化业务事件固定使用：

```text
id: 42
event: task.status_changed
data: {"schema_version":1,"scope":"workflow_run:<uuid>","event_seq":42,"event_type":"task.status_changed","occurred_at":"UTC ISO-8601","payload":{...}}

```

- `id` 必须等于数据库 `event_seq` 的十进制表示；事件名等于已裁决 `event_type`。
- `data` 由服务端白名单 DTO 映射，不直接序列化数据库实体。payload 禁止密钥、完整 prompt、签名 URL、对象 key、图片二进制、Provider 原始响应、内部堆栈和其他用户标识。
- 未知 `event_type`、非法 payload 或不支持的 schema 版本 fail closed：不向客户端发送该 payload，记录脱敏告警并关闭连接；不得跳过后继续推进游标，否则会永久掩盖投影缺口。
- SSE encoder 必须拒绝 event name、id 或字符串字段中的 CR/LF 注入；JSON 使用结构化序列化，不拼接客户端输入。

控制帧不占用业务 seq，不写 `event_outbox`，也不设置 SSE `id`：

- `heartbeat`：`{"server_time":"UTC ISO-8601","scope":"...","last_event_seq":42}`。
- `recovery_required`：发现保留期/数据完整性缺口时发送 `{"reason":"event_gap","scope":"...","last_event_seq":42}` 后主动关闭；客户端必须重新请求 snapshot，禁止猜测缺失状态。

## 4. Snapshot、回放与实时交接

前端初次进入或页面刷新顺序固定：

1. 调用 `GET /api/v1/workflow-runs/{run_id}` 获取服务端 snapshot 和 `last_event_seq=S`。workflow、tasks、latest attempts 与事件高水位必须在同一个 PostgreSQL `REPEATABLE READ READ ONLY` 事务视图内读取；禁止多次独立查询造成“旧状态 + 新游标”或“新状态 + 旧游标”。
2. 用 `scope=workflow_run:{run_id}&last_event_seq=S` 建立 SSE。
3. 只应用 seq `> S` 的事件；详情 snapshot 是连接建立前的状态真相。

服务端连接顺序固定为“先订阅 wake-up，再回放 DB”，避免回放结束与订阅建立之间丢事件：

1. 完成 session/owner/连接额度校验。
2. 在 API 实例的单一 Redis subscriber 上注册该 scope 的本地 listener。
3. 从 `last_event_seq` 开始按 `event_seq asc`、每批最多 100 条读取 `event_outbox`。
4. 每批顺序写入响应；游标只在完整 frame 成功交给响应流后前移。
5. 追平后等待 Redis wake-up；收到 wake-up 只触发同一 DB drain，不直接转发 Redis payload。
6. heartbeat 前也执行一次 DB drain。因此发布进程在 commit 后崩溃、Redis 短暂丢消息或订阅重连时，最多一个 heartbeat 周期后仍能收敛。
7. 完成鉴权和 response headers 后立即发送一次注释/heartbeat 以刷新代理缓冲；之后按配置间隔发送 heartbeat，不能让客户端首包无界等待。

同一连接的 drain 必须串行；连续 wake-up 只合并为一个 pending 标记，禁止并发查询或为每次通知创建无界 Promise/内存队列。

### 4.1 游标与缺口

- `last_event_seq` 大于当前 scope 高水位不是成功空流；返回 `REQUEST_INVALID`（400），避免客户端永久跳过真实事件。
- 回放中任意相邻业务事件不满足 `next.event_seq = cursor + 1`，发送 `recovery_required` 并关闭。客户端 snapshot-first 后以 snapshot 的高水位重建。
- 重复 wake-up、Redis 重连或网络重放不得产生重复 UI；服务端只查 `> cursor`，客户端仍以 `scope + event_seq` 去重。
- 当前 schema 以 scope 内 `max(event_seq)+1` 分配。未来执行保留期清理时必须保留独立高水位或每 scope 最新锚点；在该能力落地前不得删除会导致 seq 复用的数据。

### 4.2 慢客户端与背压

- 单连接最多保留当前 replay batch 和一个 pending wake-up，不缓存完整历史。
- 响应 `write` 产生背压时等待 `drain`；超过 10 秒仍不可写则关闭连接。关闭只影响投影，绝不回滚业务状态或阻塞 Worker。
- request aborted、response close、认证失败、Redis subscriber 重建或应用 shutdown 时必须清理 timer/listener；不得泄漏连接、定时器或用户 scope。
- API 每实例最大 1000 个 SSE 连接、每用户每实例最大 5 个，均由 typed config 配置并校验。超限在发送 SSE headers 前返回 429；入口网关另设每 IP 新建连接速率和总连接上限。

## 5. Redis fanout/wake-up

Redis channel 固定为 `${REDIS_PREFIX}:sse:wake:v1`。每个 API 实例只维护一个专用 subscriber 连接，不能为每个浏览器连接创建 Redis client。

wake-up payload 固定为：

```json
{
  "schema_version": 1,
  "scope_type": "workflow_run",
  "scope_id": "uuid",
  "event_seq": 42
}
```

规则：

- payload 只含路由和高水位，不含业务 payload、user ID 或敏感字段。
- API/Worker 在业务事务提交后 best-effort publish；事务内禁止 Redis 调用。publish 失败不回滚数据库，只记录指标/脱敏日志，由 heartbeat DB drain 收敛。
- subscriber 从 `unknown` 严格解析；非法消息丢弃并告警。即使 Redis 被伪造消息污染，也只能触发 owner 已验证连接重新读 DB，不能把消息本身发给用户。
- subscriber 断线期间已有 SSE 连接保持；API 进入定时 DB drain 降级。重连后重新订阅，不把 Redis 连接恢复误报为业务事件恢复。
- Redis pub/sub 不是 readiness 的业务真相；DB 不可读时无法安全 replay，连接关闭并由客户端退避/轮询。Redis 不可用时允许 SSE 退化为 heartbeat 周期 DB 查询，不影响只读 snapshot。

S06 必须提供统一 `EventWakePublisher` 端口，并接入本轮已存在的 workflow/task/credit outbox producer。后续 SPEC 新增用户可见 outbox 时必须在事务提交后调用该端口；不能在各模块复制 channel、JSON 或容错逻辑。

S07 及后续 SPEC 新增公网事件类型时，必须在同一交付中同步扩展服务端 `projectPublicEvent` 投影白名单、Web `SUPPORTED_EVENTS` 白名单和对应契约测试。任一环节未完成时保持 fail closed：不得向客户端发送未知 payload，也不得通过跳过未知事件推进游标。

## 6. Web 客户端状态机

连接状态固定为：

```text
idle -> connecting -> live
live -> reconnecting -> live(recovered)
connecting/reconnecting -> polling
polling -> reconnecting -> live(recovered)
任意状态 -> closed（组件卸载、登出或资源终态后的显式关闭）
```

规则：

- 15 秒内至少收到业务事件或 heartbeat；45 秒无任何合法 frame 触发 watchdog，主动 abort 并重连。
- 浏览器原生 `EventSource` 无法读取非 2xx 错误 envelope、不能自定义精确退避且难以测试背压，本轮使用 `fetch` streaming + `AbortController` 和受测 SSE parser；不得手写按单行 `split` 的脆弱解析器。
- 重连指数退避为 1s、2s、4s、8s，最大 15s，并加入 0-20% jitter；在线 60s 后重置退避。离线事件到来时暂停连接，`online` 后立即以最近游标重连。
- 连续 3 次连接失败或收到 429/503 后进入轮询：workflow snapshot 默认每 5 秒一次；页面不可见时降到 30 秒。SSE 后台继续按最大 15 秒退避探测，恢复后停止轮询。
- 401 表示 session 失效，停止自动重试并进入登录流程；404 表示资源不可见，关闭；400 表示客户端/游标错误，先清除本地游标并重新取 snapshot，仍失败则显示错误，不无限重试。
- `recovery_required`、解析错误、seq 缺口或未知事件均不得继续应用增量；保留当前 UI，重新拉 snapshot 后再建流。
- cursor 只属于当前 `scope`，保存在运行时 store；需要刷新恢复时以详情 API 返回的 `last_event_seq` 为准。不得把 session/token 或事件 payload 写入 URL、localStorage、日志或错误上报。
- UI 只显示用户视角文案：连接中不清空内容；重连中/轮询为非阻塞提示；恢复成功短暂提示后回到在线；终态 workflow 仍先消费到终态事件并刷新 snapshot，再显式关闭。

S06 的事件 reducer 对当前 workflow/task 只做白名单状态投影；资金余额、费用结算、artifact 可见性和权限变化必须重新读取对应服务端 snapshot，不能由前端对事件 payload 自行算账或推导权限。

## 7. Typed config、日志与指标

API typed config 新增：

| 变量                                  | 默认值 | 约束                                                 |
| ------------------------------------- | -----: | ---------------------------------------------------- |
| `SSE_HEARTBEAT_INTERVAL_MS`           |  15000 | 正整数                                               |
| `NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS` |  45000 | 至少 heartbeat 的 3 倍；由 Next 构建注入浏览器客户端 |
| `SSE_REPLAY_BATCH_SIZE`               |    100 | 1-500                                                |
| `SSE_BACKPRESSURE_TIMEOUT_MS`         |  10000 | 正整数                                               |
| `SSE_MAX_CONNECTIONS`                 |   1000 | 正整数                                               |
| `SSE_MAX_CONNECTIONS_PER_USER`        |      5 | 1-20 且不大于总连接数                                |

Web watchdog、退避和轮询常量集中在 SSE client，不读取服务端 secret 或 Redis 配置。`10` 环境变量清单同步补以上 API 配置；`.env.example` 只放非敏感默认值。

结构化日志至少包含 `event/request_id/user_scope_hash/scope_type/event_seq/connection_id/reconnect_reason`，不得记录完整 session、user ID、scope ID、event payload 或 URL query。指标至少包含：

- active/accepted/rejected/closed connections；
- replay batch/events/latency/gap；
- wake publish/receive/invalid/failure/coalesced；
- heartbeat sent、watchdog reconnect、polling fallback；
- slow client/backpressure timeout、DB replay failure、unauthorized/foreign scope rejection。

## 8. 实现边界

- API Controller 只校验 query、取得当前 session、调用 SSE application service 并映射响应；owner 校验、回放、背压和连接额度不写在 Controller。
- outbox query repository 复用 S05 schema/index，按 `scope_type + scope_id + event_seq` 有界读取；不新增表、不修改历史 migration。
- workflow snapshot 与 `last_event_seq` 必须通过统一 read-only transaction service 生成；不能由 Controller 或 Web 端拼接多个独立响应。
- Redis subscriber/publisher 通过共享端口注入，测试可替换；业务 Service 不直接读取环境变量或拼 Redis key。
- Worker/API producer 只在事务成功返回后 publish wake-up；测试必须证明 publish 抛错不改变已提交业务状态。
- Web SSE parser、连接状态机、workflow reducer 分离，单文件不超过 `apps/web/AGENTS.md` 的 400 行限制。

## 9. 测试标准

### 9.1 单元与组件

- scope/query 严格解析、事件 DTO 白名单、SSE CR/LF 注入拒绝。
- parser 覆盖分块边界、多行 data、heartbeat、非法 JSON、未知事件和不完整 frame。
- 状态机覆盖 watchdog、指数退避、离线/在线、401/404/429/503、轮询降级和恢复。
- reducer 覆盖正常顺序、重复 seq、乱序/缺口和终态关闭；不得用事件 payload 计算资金。

### 9.2 API/Redis/PostgreSQL 集成

使用与 S04/S05 相同的 `_test` 数据库和唯一 `TEST_REDIS_PREFIX`。禁止 drop/recreate/reset、修改历史 migration、`FLUSHALL`/`FLUSHDB`；只按 `test_run_id` 精确清理本轮记录。

- 未登录 401；资源不存在与其他用户资源均 404，且均在 SSE headers 前结束。
- `last_event_seq=0` 完整顺序回放；从中间 seq 只回放缺失部分；未来游标 400。
- “先订阅后回放”竞态中，在初次查询期间并发提交新事件，客户端最终无缺口收到且不重复。
- 两个 API 实例通过隔离 Redis wake-up 都能收到同一已提交事件；删除一次 wake-up 或 Redis 短断后由 heartbeat DB drain 补齐。
- 伪造 Redis payload、其他用户 scope wake-up、未知 event type 均不能泄露业务 payload或推进游标。
- 慢客户端触发背压超时后连接关闭，Worker/事务已提交状态不受影响；abort 后 listener/timer/额度全部释放。
- 并发超过用户/实例上限时多余连接 429，已建立连接不被错误挤掉。

### 9.3 Playwright

- 真实 snapshot + SSE：任务从 queued -> running -> succeeded，页面按序更新。
- 页面刷新后先重建 snapshot，再从其 `last_event_seq` 继续，终态不回退。
- 浏览器断网超过 watchdog 后进入重连/轮询，恢复网络后不重复展示事件，并出现短暂“已恢复”。
- session 失效停止重试并显示登录入口；外部用户 workflow 不显示任何事件。

测试 harness 只能连接 loopback `_test` 基础设施并由环境门禁启用；测试人员的临时用例、截图和运行产物不得提交。

## 10. 正反向验收

正向：snapshot(S) -> subscribe -> replay `>S` -> Redis wake-up -> DB drain -> UI reducer -> heartbeat -> 终态 snapshot -> close，全链路保持 scope 内 seq 单调且刷新可恢复。

反向：伪造 scope/游标/Redis 消息、直接访问其他用户资源、pub/sub 丢失、发布进程 commit 后崩溃、Redis 断线、DB 暂时失败、客户端读得过慢、浏览器离线、重复/乱序 frame 和保留期缺口，均不得导致越权、丢失业务真相、无界内存、状态回退或资金前端推导。

## 11. 验收清单

- [x] 已有 producer 事件名/payload 与 `06` §8 一致，并有契约测试。
- [x] 当前用户 workflow snapshot + SSE 全链路可用，其他用户统一 404。
- [x] 回放与实时交接无窗口，pub/sub 丢失可由 DB drain 补齐。
- [x] heartbeat/watchdog、退避、轮询降级和恢复状态可观测。
- [x] 重复、乱序、未知事件和过期缺口不会静默推进客户端游标。
- [x] 慢客户端、连接上限、abort/shutdown 不泄漏资源。
- [x] 真实 PostgreSQL/隔离 Redis 集成测试与 Playwright 断线恢复通过。
- [x] `pnpm check`、`pnpm test:integration`、`pnpm test:worker`、`pnpm test:e2e`、`pnpm test:e2e:s06-live`、`pnpm build`、`git diff --check` 全部通过。
