# 后端环境与扩容约束规范

| 项       | 内容                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 状态     | 已评审通过，正式契约回写中                                                            |
| 适用工程 | ecom-forge pnpm monorepo、Next.js、NestJS、Worker、PostgreSQL、Redis/BullMQ、对象存储 |
| 目标     | 本地开发 -> 香港单机 Beta -> 云服务拆分 -> 多实例扩容时不重写核心业务语义             |
| 适用任务 | 评审通过并回写正式契约后，作为 S03-S06 编码前必读                                     |
| 最后更新 | 2026-08-09                                                                            |

> 本文件记录已通过评审的工程依据。编码前先回写 `05`、`06`、`08`、`09`、`10` 与相关 SPEC；完成后以正式裁决文档为准。

## 1. 目标与边界

### 1.1 要保证的“不重构”

用户量增长和部署拆分时，下列内容不得因基础设施变化而重写：

- 认证、邀请、验证码和注册奖励语义。
- `run_quote -> reservation + workflow_run -> settlement` 交易链路。
- `credit_ledger` 真相和 ledger replay 不变量。
- workflow/task/attempt 状态机和 Provider 三态回执。
- API DTO、队列 payload、事件和错误码契约。
- R1-R5、权限、幂等和用户数据边界。

扩容可以修改或新增：

- 部署清单、网络、环境变量、容量参数和监控规则。
- composition root、连接工厂和基础设施 adapter。
- 新供应商 adapter、队列 dispatcher/reconciler、SSE fanout 和运维脚本。
- 数据迁移、对象复制、兼容层和基础设施专项测试。

“扩容不重写业务”不等于“任何扩容都零代码 diff”。禁止为了满足形式上的空 diff，把供应商、连接池、重试或恢复逻辑塞进业务组件。

### 1.2 真相分层

| 数据                                       | 真相位置                      | 说明                                                  |
| ------------------------------------------ | ----------------------------- | ----------------------------------------------------- |
| 账号、资金、任务、状态、权限、幂等业务记录 | PostgreSQL                    | 事务与长期结构化真相                                  |
| 原图、产物、视频、缩略图、导出文件         | StorageAdapter 背后的持久存储 | 二进制真相；数据库只保存所有权、状态、hash 和逻辑 key |
| 队列 job、限流、冷却、短锁、fanout         | Redis/BullMQ                  | 可重建控制面；可丢失不等于无需恢复机制                |
| SSE 连接与增量推送                         | 进程/Redis fanout             | 临时投影；恢复仍依赖 `event_outbox` 和详情 API        |
| 邮件投递状态                               | PostgreSQL `mail_deliveries`  | 不保存 OTP、完整收件人或正文                          |

对象存储不是缓存。数据库完好但二进制对象丢失，仍属于数据事故。

## 2. 环境模型

### 2.1 两个环境维度

必须区分运行时优化和部署环境：

```text
NODE_ENV=development|test|production
APP_ENV=local|test|staging|beta|production
```

- `NODE_ENV` 只服务于 Node/框架构建和测试行为。
- `APP_ENV` 决定 adapter 准入、网络安全、密钥要求、日志和启动门禁。
- `APP_ENV` 只能由受信部署编排或服务器启动配置注入；不得由客户端、HTTP header、query 或用户可控配置决定。缺失、非法或与部署目标不一致时启动失败。
- staging、beta、production 的 `NODE_ENV` 都是 `production`。
- 业务服务不得散落 `NODE_ENV/APP_ENV` 分支；环境判断集中在配置解析和 composition root。

### 2.2 环境矩阵

| 项            | local               | test           | staging            | beta                | production                  |
| ------------- | ------------------- | -------------- | ------------------ | ------------------- | --------------------------- |
| 邮件          | console 或本地 SMTP | fake           | 真实受控邮箱 smoke | 真实邮件服务        | 真实邮件服务                |
| PostgreSQL    | Docker PG 16        | 隔离测试库     | 独立测试实例       | 香港单机或托管实例  | 托管 PostgreSQL/RDS         |
| Redis         | Docker Redis 7      | 隔离测试 Redis | 独立测试实例       | 单机/托管 Redis     | 托管 Redis                  |
| 二进制存储    | local               | 临时目录/fake  | 测试桶             | 香港私有桶          | 正式私有桶                  |
| 外部 Provider | fake/封闭 PoC       | fake           | 测试密钥           | 已准入真实 Provider | 已准入真实 Provider         |
| 调试能力      | 明确白名单          | 测试钩子       | 仅受控诊断         | 关闭                | 关闭                        |
| 密钥          | Git 忽略的本地文件  | 测试注入       | 服务器 secret      | 服务器 secret       | 密钥管理服务或服务器 secret |

“调试开/半开”不是有效配置。每项调试能力必须有独立开关、环境准入和测试；不存在一个可打开全部调试接口的总开关。

### 2.3 启动门禁

- `fake` 邮件只允许 `APP_ENV=test`；console 只允许 local。
- staging/beta/production 出现 fake、console、local storage、默认 secret 或空密钥时启动失败。
- endpoint、region、bucket、trusted proxy 和 origin 不符合白名单时启动失败。
- production 数据库未启用经过裁决的 TLS/私网策略、Redis 暴露公网或 API 信任任意代理时启动失败。
- 启动失败必须输出脱敏的配置项名称和修复方向，不能输出 secret 值。

## 3. 配置与密钥治理

### 3.1 每个进程最小注入

web、api、worker 可以由同一部署平台管理配置，但不能接收同一份完整环境变量：

- Web 浏览器 bundle 只允许显式 `NEXT_PUBLIC_*` 非敏感变量。
- API 只接收认证、DB、Redis、邮件、对象存储和其负责的 Provider 配置。
- Worker 只接收 DB、Redis、对象存储、Provider 和其处理器需要的配置。
- 迁移进程只接收 migration DB URL，不接收邮件、Provider 或对象存储密钥。

`packages/shared` 可以保存无副作用的 parser/schema/helper，但不得在 import 时读取 `process.env`。各 deployable app 在入口调用自己的 typed config loader；同名变量通过共享 schema 和契约测试保持语义一致。

### 3.2 变量分组

```text
App:
  NODE_ENV APP_ENV WEB_ORIGIN API_PORT AUTH_TRUSTED_ORIGINS TRUSTED_PROXY_CIDRS

Database:
  DATABASE_URL DB_POOL_MAX DB_STATEMENT_TIMEOUT_MS DB_TRANSACTION_TIMEOUT_MS DB_OPS_RESERVED_CONNECTIONS

Redis:
  REDIS_URL REDIS_PREFIX

Storage:
  STORAGE_DRIVER LOCAL_UPLOAD_ROOT
  COS_SECRET_ID COS_SECRET_KEY COS_BUCKET COS_REGION COS_ENDPOINT

Auth/Mail:
  AUTH_SECRET AUTH_OTP_HASH_SECRET AUTH_RATE_LIMIT_SECRET
  AUTH_VERIFICATION_TICKET_SECRET
  AUTH_INVITE_CODE_ACTIVE_KEY_ID AUTH_INVITE_CODE_KEYRING
  AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID AUTH_REWARD_FINGERPRINT_KEYRING
  MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID MAIL_RECIPIENT_HASH_KEYRING
  MAIL_PROVIDER MAIL_FROM MAIL_FROM_NAME
  MAIL_SMTP_HOST MAIL_SMTP_PORT MAIL_SMTP_SECURE
  MAIL_TENCENT_SECRET_ID MAIL_TENCENT_SECRET_KEY MAIL_TENCENT_REGION
  MAIL_TENCENT_ENDPOINT MAIL_TENCENT_TEMPLATE_ID_VERIFY
  MAIL_TENCENT_TEMPLATE_ID_RESET MAIL_WEBHOOK_SECRET

Ops:
  ALERT_WEBHOOK_URL COST_BUDGET_HOURLY
```

最终变量名需回写 `10` 后冻结；本节不授权代码先行新增。

### 3.3 secret 分域与轮换

- OTP、ticket、限流、邀请码、奖励邮箱族、邮件收件人摘要和 Better Auth secret 不复用。
- secret 记录 key ID 和用途，不把 secret 本身写入 DB、日志或错误。
- OTP/ticket secret 紧急轮换允许使当前验证码/ticket 失效，必须提前向用户显示可重试状态。
- 邀请码只存 HMAC 时无法从旧 digest 重算新 digest；`AUTH_INVITE_CODE_KEYRING` 使用版本化 key ID，active key 只负责新写入，旧 key 至少保留到对应邀请码全部过期/撤销。
- 奖励邮箱 fingerprint 参与历史唯一性；`AUTH_REWARD_FINGERPRINT_KEYRING` 轮换后必须同时对仍有效活动的旧 key 做查重，不能只用新 key，否则同一邮箱可再次领奖励。
- 邮件收件人摘要记录 key ID；轮换期间 bounce/complaint 匹配需要查询仍在保留期内的 key，过期后按 `08` 删除旧 key 和不可关联记录。
- keyring 是受 schema 校验的服务器 secret 映射，不写普通 JSON 配置文件；数据库只保存非敏感 key ID。
- `.env.example` 只放占位；服务器 secret 文件限制权限；禁止通过命令行参数、前端变量或构建日志传 secret。

## 4. 网络、代理与来源身份

### 4.1 网络边界

- 公网只开放 Nginx/CDN 的 HTTPS 入口；API、PostgreSQL、Redis、Worker 管理端口只绑定 loopback 或私网。
- PostgreSQL 和 Redis 不直接暴露公网。云服务使用安全组、最小来源 CIDR、独立账号和 TLS/私网连接。
- Webhook 路由保留原始请求体和签名头，但仍经过独立限流、body 大小限制和来源验证。
- local Compose 的 PostgreSQL/Redis 端口显式绑定 `127.0.0.1`，不能使用会监听所有网卡的裸 `5432:5432`/`6379:6379`；CI 按 runner 网络单独配置。
- production 容器镜像固定已验证版本或 digest，不使用 `latest`；升级按独立变更执行门禁。

### 4.2 可信代理链

Nginx 必须覆盖客户端伪造的转发头，单层代理最小语义：

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

若前面还有 CDN/LB，必须配置其固定 CIDR、real-ip 模块和明确 hop，不能直接信任任意 XFF 链。

API 规则：

- 只有 socket peer 在 `TRUSTED_PROXY_CIDRS` 内时才解析代理 header。
- 非受信 peer 的 XFF/X-Real-IP/Forwarded 一律忽略，只取 socket remote address。
- staging/beta/production 的代理拓扑与配置不一致时健康门禁失败。
- IPv4 按地址限流，IPv6 默认按 `/64` 聚合后 HMAC。
- IP hash 不进入高基数指标 label；原始 IP 的安全审计和保留期由 `08` 裁决。

## 5. PostgreSQL 与迁移

### 5.1 连接工厂

- 所有业务连接只通过 `packages/db` 的 client factory；禁止模块直接创建 `postgres()`/裸 pg client。
- migration/check 可以使用独立 max=1 的短生命周期 client。
- API/Worker 必须显式注入池大小、statement timeout、transaction timeout 和 application name。
- 事务内禁止网络调用；热点行事务必须短且有超时。

### 5.2 总连接预算

固定的 api=20、worker=5 只能是单机 Beta 初始建议，不是多实例永久值。部署必须满足：

```text
sum(api_instances * api_pool_max)
+ sum(worker_instances_by_pool * worker_pool_max)
+ migration_connections
+ ops_reserved_connections
<= floor(database_max_connections * 0.8)
```

至少预留 20% 给迁移、管理、故障恢复和瞬时抖动。扩容实例前先重新计算连接预算；不能只增加副本而保持每实例连接池不变。
`ops_reserved_connections` 必须是显式配置项 `DB_OPS_RESERVED_CONNECTIONS`；单机 Beta 初始值为 `5`，正式上线前由 `09` 按备份、迁移、排障和监控需求复核，不能默认为 0。

引入 PgBouncer 前必须实测 postgres.js/Drizzle 的 prepared statement、事务、监听和 migration 兼容性。是否使用 transaction pooling、是否关闭 prepare 由 spike 结果决定，不能在业务代码各自设置。

### 5.3 迁移

- 只做向前兼容 migration；已提交或已应用 migration 不修改、重命名或删除。
- 流程：生成 SQL 人审 -> 空库从零 -> staging dry-run -> 备份 -> production dry-run -> 执行 -> 专项查询和 ledger replay。
- 多实例发布时只允许一个 migration job；应用启动不隐式并发跑 migration。
- 新旧代码至少一个发布窗口兼容同一 schema，删除/重命名采用 expand-migrate-contract。

## 6. Redis、BullMQ 与可重建队列

### 6.1 Redis 定位

Redis 可以承载：

- BullMQ job、短期幂等 reservation、限流、冷却、分布式短锁和 pub/sub wake-up。

Redis 不得承载：

- OTP 真相、账本、workflow/task 终态、Provider accepted 真相、对象所有权或唯一审计记录。

本地 AOF 和云 Redis 持久化用于降低恢复频率，不改变“DB 可重建”的设计要求。

### 6.2 原子性与故障策略

- 冷却使用 `SET NX EX`；多维计数、幂等 reservation 和 owner-safe 解锁使用 Lua/Redis Function。
- Redis 故障时，注册、验证、找回密码和新密码登录 fail closed；已有合法 session 的只读访问可继续。
- Redis 故障时 API 不创建无法派发却伪装成功的任务；如果业务事务已提交，必须有 `queue_dispatch_intents` 供恢复 dispatcher 继续，用户可见事件才使用 `event_outbox`。
- Redis 恢复后不得把所有 pending 任务无界并发灌回队列，dispatcher 需限速并按优先级恢复。

### 6.3 DB -> Queue 恢复闭环

“Redis 可重建”只有在 S05 实现以下机制后才成立。`queue_dispatch_intents` 是独立于 SSE 的队列投递意图记录；它记录“数据库事务已提交但 BullMQ 尚未确认写入”的控制面状态，不承载用户进度事件。

1. 创建 workflow/task 的数据库事务同时写 `queue_dispatch_intents`；需要通知用户的状态变化另写 `event_outbox`，两者不能互相替代。
2. 事务提交后 dispatcher 才用稳定 `jobId=业务ID` 写 BullMQ。
3. dispatcher 崩溃时，sweeper 以 owner-safe lease 分页扫描 pending/过期 lease intent；Redis 网络调用在 DB 事务外执行，唯一 jobId 和 DB 状态检查保证幂等。
4. Worker 消费前读取 DB 当前状态，过期或已终态 job 直接 no-op。
5. `not_dispatched` 可以按策略重新调度；`accepted/polling` 只恢复查询/回调等待，禁止重新提交 Provider。
6. `outcome_unknown` 进入人工/定时核验，不自动重投。
7. 普通 sweeper 无法找回已标记 `dispatched` 但 Redis job 已丢失的工作；recovery sentinel 缺失时必须由数据库 session advisory lock 选唯一 reconciler，分页核对 dispatched intent 并以原 jobId 重建仍需执行的本地步骤。session lock 使用专用 ops 连接，但不得持有跨 Redis 调用的数据库事务。
8. reconciliation 对终态 no-op；accepted/polling 只恢复查询/等待，outcome_unknown 只恢复核验/人工处理。完成全部分页后才写 sentinel，中途崩溃允许下一实例接管。
9. Redis 全量丢失演练必须证明 pending 与仍需执行的 dispatched 工作可恢复、终态不重跑、accepted/outcome_unknown 不重复投递；演练只删除唯一测试 prefix，禁止对共享 Redis 执行 `FLUSHALL`/`FLUSHDB`。

sentinel 缺失期间 queue control-plane readiness 必须失败，只读/诊断/恢复可运行，新的生成/收费写操作 fail closed；sentinel 不设置 TTL，完成全量核对并写入后才恢复接流。

如果 S05 尚未交付该闭环，任何文档都不得宣称“Redis 丢失后任务不丢不重”。

### 6.4 Worker 扩容

- 队列名和 payload 只来自 `packages/queue`；processor 不发明业务状态。
- Processor 必须可重复执行，最终写入由 DB 唯一约束/状态 CAS/幂等键兜底。
- 按 agent/workflow/task/provider-callback/evaluation/notification 拆 worker pool 时只改装配和部署，不复制处理逻辑。
- Cron/恢复扫描多实例运行时使用数据库 advisory lock 或带 owner token、过期时间和续约的 lease，同时依靠 DB 幂等，不能只靠“应该只有一个实例”。lease 失联后必须允许其他实例接管，旧 owner 不能继续写入。
- SIGTERM 时停止领取新 job、等待有界 drain、续约必要锁并上报 draining；超时退出后依赖 DB/队列恢复。
- BullMQ attempts 只处理明确未送达的本地步骤；Provider accepted/outcome_unknown 禁止自动重投。

## 7. 邮件服务

邮件完整安全和 OTP 语义以 [S03 邮箱验证码与邮件投递方案](./S03-email-otp-and-mail-delivery.md) 为准，本节只裁决部署边界：

- 开发阶段不购买腾讯 SES；local 使用 console 或 Mailpit，test 使用 FakeMailAdapter。
- staging 首次真实投递 smoke 之前必须取得受控账号；没有账号时只是不具备 staging/production 邮件验收资格，不阻塞本地业务开发。
- staging/beta/production 不能启用 console/fake，也不能在发送失败后打印 OTP 降级。
- 只有 Mail 模块可导入具体 SDK；不提供任意收件人/正文接口，不注册为 Agent tool 或 Skill action。
- 发信前写 `mail_deliveries.queued`，网络调用在事务外，悬挂 queued 恢复为 outcome_unknown，不盲目重发。
- 腾讯 SES 的地域、配额、模板、退信/投诉 webhook 或查询 API 都是上线 spike，不在没有账号时假定已支持。
- 云账号使用最小发信权限、日配额和异常发送告警。

## 8. 对象存储与二进制迁移

### 8.1 统一能力接口

StorageAdapter 至少提供：

- 创建上传意图、确认上传、读取元数据、签发短期下载、复制、删除和存在性/hash 校验。
- 对外上传接口只使用 `06` 已裁决的 `POST /api/assets/upload-url` 与 `POST /api/assets/complete`；本提案中的 upload intent 是这两个接口背后的适配器语义，不新增第二套 `upload-intent` 路由或 payload。
- local 可以返回 API 托管的短期上传 URL；COS 可以返回预签名直传，不假定所有 driver 都支持同一种 SDK。
- complete 时服务端重新读取对象 metadata，校验所有权、实际 MIME sniff、大小、hash 和审核状态；不信任客户端自报。

图片 20MB、视频 200MB 上限来自 PRD/`08`；代理、API body parser、对象存储 policy 和前端提示必须一致。

### 8.2 换桶/区域

换 bucket/region 不是只改一个环境变量：

1. 冻结迁移范围并导出对象 manifest（logical key、size、hash、owner）。
2. 服务端复制并逐项校验 hash/size。
3. 增量追平迁移期间的新写入，必要时由 adapter 提供有界 dual-read/dual-write。
4. 验证签名、权限、生命周期、CORS 和下载审计。
5. 切换配置后保留回退窗口，再按 `08` 清理旧桶。

只要 `storage_key` 仍是稳定逻辑 key，以上属于基础设施和数据迁移，不要求重写资产/产物业务语义。

### 8.3 数据保护

- staging/beta/production 使用私有桶，测试和正式桶物理隔离。
- 子账号只授予指定桶和前缀所需权限；Web/API 不接收云密钥。
- 对象生命周期、软删、物理清理和备份过期以 `08` 为准。
- 必须监控数据库记录存在但对象缺失、对象存在但无 DB owner 的双向孤儿。

## 9. API 多实例、幂等与 SSE

### 9.1 API 无状态

- Session 真相、业务幂等、限流、ticket/claim 和任务状态不得只存在进程内存。
- 内存只允许请求级数据、有限缓存和可丢失连接状态；进程重启不能改变业务结果。
- 所有写接口使用 `Idempotency-Key` 或稳定业务 ID；相同 key + 不同 payload 必须冲突。
- 多实例发布前必须验证 Cookie/session、CSRF、trusted proxy、CORS 和幂等在任意实例结果一致。

### 9.2 SSE 扩容

- `event_outbox` 与 scope 内 `event_seq` 是恢复真相；多实例通过 Redis pub/sub 做低延迟 fanout/wake-up，但 pub/sub 丢消息不改变真相。
- 单机 Beta 可由 API 直接读取并投影 outbox；多实例可由共享 SSE/fanout 服务订阅 Redis pub/sub，并按连接的 `last_event_seq` 从 `event_outbox` 补齐，不能依赖某个实例内存看见全部事件。直接查询只用于重连补齐或 fanout 故障降级，不替代正常连接的实时推送路径。
- 15 秒 heartbeat、45 秒 watchdog、`last_event_seq` 恢复沿用 `06`。
- Redis fanout 丢消息后客户端仍可从 outbox 补齐；不可恢复的 message delta 必须有最终消息摘要。
- SSE 容量不足可以降级详情 API 轮询，但账本、终态和 artifact 真相不降级。

## 10. 可观测性、日志与告警

- 日志结构化并使用 UTC；通过 trace/run/task/attempt/delivery ID 关联。
- 禁止密钥、OTP、完整邮箱、邀请码、完整 prompt、签名 URL、Cookie、Authorization、图片二进制和 Provider 原始敏感响应进入结构化日志、日志文件或采集系统。唯一例外是 `APP_ENV=local` 的 ConsoleMailAdapter 专用终端输出，该输出不得经过通用 logger/sink。
- 邮箱/IP/设备 HMAC 不作为 Prometheus label，避免高基数和跨表关联泄露。
- 指标至少覆盖 API 错误/延迟、DB 池等待、Redis/BullMQ backlog、worker heartbeat、Provider 三态、账本不一致、成本、邮件失败/outcome_unknown/退信。
- 告警必须包含环境、模块、关联 ID、阈值和处理 runbook，不发送敏感 payload。
- critical：账本不一致、Provider unknown 激增、队列恢复失败、DB 连接耗尽、备份失败、邮件异常发送、worker heartbeat 丢失。

## 11. 备份、恢复与灾难演练

### 11.1 Beta 初始目标（待 `09` 评审冻结）

| 数据         |               建议 RPO |             建议 RTO | 方法                                       |
| ------------ | ---------------------: | -------------------: | ------------------------------------------ |
| PostgreSQL   |            24 小时以内 |           4 小时以内 | 每日加密 dump、迁移前备份、异地/独立桶保存 |
| 对象存储     | 按桶版本和生命周期裁决 |   4 小时以内恢复读取 | 版本/复制/manifest 校验                    |
| Redis/BullMQ |         不作为业务 RPO | 2 小时以内重建控制面 | DB outbox + reconciler 重建                |

- 只有备份没有恢复演练不算通过。至少按季度在隔离环境恢复 PostgreSQL，并执行 schema、行数、关键查询和 ledger replay。
- PostgreSQL 的 Beta 建议 RPO 为 24 小时，意味着最坏情况下可能丢失最近 24 小时的数据；这不是默认可接受的产品承诺。若 Beta 已产生真实付费积分、账本或用户付费数据，必须在 `09`/产品评审中明确批准，或改用 WAL/PITR 并把 RPO 降到可接受范围；未裁决前不得宣称资金数据可按 24 小时 RPO 上线。
- DB dump 加密，备份 bucket 与业务写账号权限隔离；保留周期和删除遵循 `08`。
- Redis 恢复演练必须包含 pending、accepted、outcome_unknown 三类任务，证明不会重复调用 Provider。
- 对象恢复演练随机抽样 hash、尺寸、权限和短期签名 URL。

## 12. 扩容阶段与允许改动

| 动作              | 现在必须具备                          | 扩容时允许改动                               |
| ----------------- | ------------------------------------- | -------------------------------------------- |
| PostgreSQL -> RDS | DB client factory、迁移 SOP、连接预算 | 配置、TLS、部署、数据迁移、连接 adapter 测试 |
| Redis -> 云 Redis | 统一 client、key prefix、DB 恢复闭环  | 配置、TLS、部署、恢复演练                    |
| API 多实例        | 外置 session/幂等/限流、可信代理      | 副本、负载均衡、池预算、装配                 |
| Worker 拆池       | 稳定 queue contract、幂等 processor   | worker entrypoint、并发和部署                |
| COS 换桶/区域     | 稳定 logical key、StorageAdapter      | adapter 配置、对象迁移、短期兼容层           |
| 换邮件供应商      | MailAdapter、结构化 AuthMailCommand   | 新 adapter、模板、webhook/query 接入、配置   |
| SSE 独立/fanout   | outbox、event_seq、客户端恢复         | fanout adapter、SSE 服务、部署               |
| pgvector 启用     | 当前 JSON 占位不进入检索语义          | 新 SPEC、migration、索引、检索代码和容量验证 |

扩容验收看“业务契约和核心状态机是否保持”，不以 `packages/*` 必须零 diff 作为形式指标。

## 13. 上线门禁

### Beta

- 配置矩阵、APP_ENV、错误 adapter 和默认 secret 启动失败测试通过。
- 受信代理/XFF 伪造测试通过；API/DB/Redis 不暴露公网。
- DB 连接预算、migration 单实例、每日备份和恢复演练通过。
- Redis 全量丢失恢复演练通过后，才能宣称队列可重建。
- 邮件真实受控 smoke、地域/配额/模板和退信观测 spike 通过。
- COS 私有桶、最小权限、签名、生命周期和对象完整性检查通过。
- 日志脱敏、告警、`pnpm validate:stage0` 和当期 validation 通过。

### Production

- 根据容量和可用性指标决定 RDS/云 Redis/多实例，不把固定用户数当唯一触发条件。
- 明确 RPO/RTO、托管备份/PITR、对象版本与恢复责任人。
- 生产域名、HTTPS、备案和 `08` 法务合规门禁完成。
- 灰度、回退、向前 migration、secret 轮换和供应商故障 runbook 演练通过。

## 14. 必须验证的反例

- Web 构建产物或 `NEXT_PUBLIC_*` 中出现任一服务器 secret，门禁失败。
- `APP_ENV=production + MAIL_PROVIDER=console`、local storage 或默认 secret，启动失败。
- 客户端伪造 XFF 不能改变限流身份；代理 hop 配错时健康门禁失败。
- 增加 API/Worker 副本后，总 DB 连接仍在预算内。
- Redis 测试 prefix 全量丢失后，pending 与仍需执行的 dispatched 工作可恢复，终态不重跑，accepted/outcome_unknown 不重新投递。
- Worker 在处理期间 SIGTERM，任务最终由原实例完成或由恢复机制接管，不重复 Provider 请求。
- Bucket 切换缺对象、hash 不符或权限不符时禁止切流。
- Secret 轮换不会让历史奖励 fingerprint 失去唯一性，也不会使有效邀请码永久不可查。
- SSE fanout 丢消息后，客户端通过 `last_event_seq` 补齐。
- 备份文件存在但无法恢复时，验收仍判失败。

## 15. 评审通过后的回写

1. `08`：代理/IP、secret 分域轮换、日志脱敏、对象/备份保留和 Cookie/CSRF。
2. `09`：环境门禁、限流、告警、RPO/RTO、恢复演练和容量指标。
3. `10`：APP_ENV、逐进程配置、环境矩阵、连接预算、可信代理、对象迁移和扩容允许改动。
4. `05`：`assets/artifacts.content_hash`、`invite_codes.key_id` 及对应唯一/查询索引；`queue_dispatch_intents` 已由 S03 的向前 migration 正式冻结，S05 复用既有表并补足 dispatcher/reconciliation 语义。
5. `06`：沿用 `/api/assets/upload-url` + `/api/assets/complete`，补充 `queue_dispatch_intents -> BullMQ` 恢复、Redis pub/sub fanout/断线补齐，且不改变对外 API 语义。
6. S03：邮件、认证 secret、trusted proxy 和 Redis fail-closed。
7. S05：`queue_dispatch_intents`、dispatcher/sweeper、Redis 全丢恢复和 Worker drain。
8. S06：多实例 SSE fanout、消息丢失恢复和降级轮询。

正式文档回写并复审前，不新增同义 validation 命令；验收命令名称由 `09` 统一裁决。
