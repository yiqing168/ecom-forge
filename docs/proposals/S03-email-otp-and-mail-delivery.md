# S03 邮箱验证码与邮件投递方案

| 项       | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 状态     | 已评审通过，正式契约回写中                               |
| 适用范围 | S03 注册、邮箱验证、登录恢复、找回密码、注册奖励         |
| 当前环境 | 本地开发不购买、不调用腾讯云 SES                         |
| 生产目标 | 上线时只切换邮件适配器和服务器环境变量，认证业务逻辑不改 |
| 最后更新 | 2026-08-09                                               |

> 本文件记录已通过评审的实施依据。编码前必须完成 `05`、`06`、`07`、`08`、`09`、`10`、设计文档和 S03 的回写与复审；完成后以正式裁决文档为准。

## 1. 结论

采用 Better Auth 的 `emailOTP` 插件实现验证码生命周期，不在 NestJS 中再手写一套验证码服务：

- Better Auth 负责 OTP 生成、有效期、错误次数、一次性消费、邮箱验证和密码重置。
- PostgreSQL 的 `auth_verifications` 保存 Better Auth 验证记录；OTP 只保存 HMAC，不保存明文。
- NestJS 只负责产品 API、邀请码/白名单门禁、限流、幂等、风控、审计和注册奖励编排。
- Redis 只保存限流、冷却、分布式串行锁和短期请求幂等状态，不保存 OTP 真相。
- 邮件通过 `MailAdapter` 投递。本地默认控制台，可选 Mailpit；自动测试使用 Fake；上线再切腾讯云 SES。
- 普通注册必须先通过邀请码门禁，才允许创建注册流程和发送验证码。无效邀请码不调用邮件适配器。
- 找回密码不能要求邀请码，否则已有用户可能无法恢复账号；该入口使用泛化响应和更严格的多维限流。
- 注册奖励只在邮箱验证成功后，由幂等 finalizer 经 `packages/credit` 发放。

## 2. 不采用原始 Redis 自研 OTP 的原因

不采用“`crypto.randomInt` + Redis JSON + 手写 attempts/TTL/delete”作为主方案，原因是：

1. Better Auth 已提供 OTP 长度、过期、尝试次数、存储策略和密码重置能力，自研会形成第二套认证状态机。
2. Redis 主从切换、并发校验和删除时序容易造成验证码重复消费或错误次数丢失。
3. 认证真相应与 Better Auth 的账号和 verification adapter 保持一致，Redis 只承担可丢失的控制面状态。
4. 后续升级认证框架时，使用公开插件能力比维护私有认证分支风险更低。

## 3. 威胁模型

本方案必须覆盖以下滥用，而不是只防正常 UI 操作：

| 威胁                         | 主要控制                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- |
| 脚本直接调用发信接口         | 邀请门禁、Origin 校验、幂等键、IP/设备/邮箱/邀请码多维限流                    |
| 枚举邀请码状态               | 无效、过期、用尽、停用、邮箱不匹配统一错误和近似响应时长                      |
| 枚举已注册邮箱               | 找回密码始终返回泛化响应；日志和指标不暴露账号存在性                          |
| 使用假邮箱占用邀请码         | 预核验格式和域名、邀请码 claim 有限期、验证成功才正式核销和发奖励             |
| 用一次有效邀请码轰炸多个邮箱 | 每邀请码、IP、设备和收件人限流；有效 claim 数计入邀请码容量                   |
| 反复申请新 OTP 重置错误次数  | 发送窗口总量限制；新 OTP 轮换旧 OTP，但不能绕过邮箱/IP 窗口                   |
| OTP 爆破或重放               | 6 位 OTP、每码 5 次、校验接口限流、成功后一次性消费、并发串行化               |
| 数据库泄露后离线枚举 OTP     | `AUTH_OTP_HASH_SECRET` 驱动 HMAC；数据库不存明文或普通快速 hash               |
| 邮件服务密钥泄露到前端       | 适配器仅在 `apps/api`，密钥只进服务端环境变量                                 |
| 业务模块任意发邮件           | `MailAdapter` 不对 Controller/Agent/Skill 暴露，只允许受审的 MailService 调用 |
| 邮件头或模板注入             | 业务层只传结构化 purpose/OTP/有效期，不接受客户端 subject/from/html           |
| Provider 超时后重复发信      | 区分未投递、已接受和结果未知；结果未知不自动重发                              |

前端是否显示按钮不构成安全控制。所有门禁必须在 API 服务端重新执行。

## 4. 模块职责

```text
Web 注册/验证/找回表单
  -> NestJS AuthController（DTO、Origin、Idempotency-Key）
      -> AuthApplicationService
          -> RegistrationGate（邀请码、白名单、claim、风控）
          -> Better Auth emailOTP（OTP 唯一生命周期）
          -> VerificationRateLimiter（Redis 控制面）
          -> MailService（唯一业务发信入口）
              -> MailAdapter
                   - FakeMailAdapter          测试
                   - ConsoleMailAdapter       本地开发
                   - SmtpMailAdapter          可选 Mailpit
                   - TencentSesMailAdapter    staging/beta/production
          -> EmailVerificationFinalizer
              -> invite redemption
              -> packages/credit 注册奖励
              -> audit/metrics
```

边界规则：

- 不直接暴露 Better Auth 原始 email OTP routes，对外只开放 NestJS 包装接口。
- Controller 不注入具体 MailAdapter，不允许任意收件人、主题或正文的通用发信接口。
- Agent、Skill、Web 和 Worker 不得直接导入腾讯 SES SDK。
- ESLint/import 边界和架构测试必须证明只有 Mail 模块能导入具体 adapter/SES SDK，且仓库不存在“任意收件人 + 任意正文”的公共邮件路由。
- MailService 不注册为 Agent tool、Skill action 或内部通用 RPC；Agent 即使被 prompt injection 诱导，也没有发邮件能力。
- 邮件网络调用不得位于数据库事务内。
- 邮件失败不得静默切换为 console/fake；环境和适配器不匹配时启动即失败。

## 5. 邮箱与邀请码预处理

### 5.1 邮箱规范化

服务端在数据库查询、唯一性判断、限流和 hash 前执行同一规范化函数：

- 去除首尾空白，执行 Unicode 规范化，统一域名大小写并执行 IDNA 转换。
- 总长度不超过 320，按经过评审的邮箱 schema 校验。
- 登录身份只做保守规范化，不在通用规则里贸然删除点号或 `+tag`；供应商别名另进入奖励风控指纹。
- 原始邮箱只进入用户表和邮件适配器；Redis key、指标 label 和普通日志只使用 HMAC 摘要。

“假邮箱”不能只靠正则彻底识别，按分层方式处理：

1. 语法和长度不合法，直接拒绝，不查邀请码、不发邮件。
2. 邀请码绑定了精确邮箱或域名时，必须匹配。
3. 可维护一次性邮箱域名拒绝表；它是风险信号，不是邮箱所有权证明。
4. 可在事务外做有超时和缓存的 MX 检查；DNS 暂时故障不得造成长时间阻塞。
5. 最终所有权只以成功提交 OTP 为准；未验证用户不得生成、不得领取奖励。
6. 定时清理长期未验证且没有业务数据的注册残留，保留必要的脱敏审计。

### 5.2 邮箱别名、中转地址与注册奖励

OTP 成功只证明当前用户能接收该地址的邮件，不能证明它代表一个新的自然人。必须单独处理以下情况：

- Gmail 消费者邮箱的 `name+tag@gmail.com`、点号变体以及 `googlemail.com` 可能投递到同一个邮箱。
- Firefox Relay、Apple“隐藏邮件地址”、SimpleLogin、DuckDuckGo Email Protection 等可以为同一用户生成多个真实可收信的中转地址。
- 企业邮箱 catch-all、自有域名和邮箱别名也可能无限生成，服务端无法仅凭 SMTP/MX 判定背后是否同一人。

因此分成两个概念，禁止混用：

1. `account_email`：用于登录和投递，执行保守、可逆的规范化，避免错误合并真实账号。
2. `reward_mailbox_fingerprint`：只用于赠送积分反刷，不返回客户端，不作为登录凭据。

奖励指纹规则必须版本化并可审计：

- 仅对已确认语义的公共 Gmail 域执行 `googlemail.com -> gmail.com`、移除 local-part 点号、移除 `+tag`，再做 HMAC。
- 不对 Google Workspace、自有域名或未知邮箱供应商套用 Gmail 规则。
- 已知 disposable/relay 域进入版本化风险名单。封闭 Beta 默认在发信前返回统一的 `REGISTRATION_NOT_ELIGIBLE`，不消耗邮件；如产品决定允许注册，则至少不得自动发注册奖励。
- 风险名单只能保存域名和规则版本，不记录用户完整邮箱；误判必须有运营解除方式。
- 未识别的 alias/catch-all 不能靠邮箱规则彻底解决，必须继续结合邀请码、设备、IP 网段、行为、活动总量和人工复核。

建议新增 `registration_reward_claims`，以 `campaign_key + reward_mailbox_fingerprint` 建立唯一约束；同一邮箱族换点号、`+tag` 或 `googlemail.com` 只能领取一次。设备/IP 只做阈值和风险信号，不直接设全局唯一约束，避免家庭、公司和校园共享网络误伤。

### 5.3 邀请码存储和查验

- 邀请码使用密码学随机值，至少 128 bit 熵，不使用可枚举的短数字码。
- API、应用日志、审计 metadata 和错误信息不得记录完整邀请码。
- 建议把 `invite_codes.code` 拆为邀请码 HMAC digest + 非敏感 `key_id`，管理端只在创建时展示一次明文；如保留可读前缀，应单独存储非敏感 prefix。
- 回写 `05` 时必须同时定义旧字段的前向迁移、seed 和管理端查询策略；禁止一边存 HMAC、一边保留按明文 `code` 查询的旧路径。
- 普通 Beta 注册默认 `invite_required`。服务器明确配置的邮箱白名单属于受控旁路，默认关闭，不能由客户端声明。
- 无效、过期、用尽、停用和邮箱不匹配统一返回 `REGISTRATION_NOT_ELIGIBLE`；服务端记录原因枚举，客户端不显示细分原因。

## 6. 注册与邮箱验证流程

### 6.1 首次注册并发送 OTP

`POST /api/v1/auth/register`

请求包含：

```json
{
  "email": "user@example.com",
  "password": "server-validated-password",
  "display_name": "用户昵称",
  "invite_code": "one-time-visible-code",
  "agreement_version": "current-version"
}
```

流程：

1. 校验 Origin、JSON content type、DTO 和 `Idempotency-Key`。
2. 规范化邮箱，先执行低成本 IP/设备速率限制。
3. 对邀请码做 HMAC 后查库；在同一事务内锁定邀请码行，检查状态、邮箱约束和容量。
4. 创建或恢复 `registration_claim`。active claim 必须计入可用容量，避免并发超发；claim 过期后自动释放。
5. 调用 Better Auth 创建未验证用户或恢复同邮箱的未完成注册；重复请求不得创建第二个用户。
6. Better Auth 生成 6 位 OTP，写入 `auth_verifications`，使该邮箱之前的注册 OTP 失效。
7. MailService 投递结构化验证邮件。只有适配器明确接受后，接口才返回“验证码已发送”。
8. 返回不含邮箱明文的 `verification_ticket`。后续重发和校验使用 ticket，不提供任意收件人的开放发信接口。

关键时序：

- 邀请码 claim 只是短期占位，不等于正式核销，不能增加 `used_count`，也不能发奖励。
- claim 建议最长 30 分钟，单个 OTP 10 分钟；重发只能在 claim 上限内延长。
- Better Auth 创建用户失败时释放 claim；进程崩溃留下的 claim 依赖 TTL/清理任务释放。
- 邮件投递失败时用户保持未验证，可在冷却结束后重发；不得假装发送成功。
- ticket 是基于服务端 secret、claim ID、ticket version 和随机 nonce 生成的 256-bit 伪随机不透明值，只能出现在 HTTPS 响应体和前端内存或 `sessionStorage`；禁止放入 URL、查询参数、浏览器历史、埋点、日志和 `localStorage`。
- ticket 的明文只在客户端短期存在，服务端只存 HMAC；claim 过期、验证完成、尝试次数耗尽或风控封禁时必须立即作废。

### 6.2 重发注册 OTP

`POST /api/v1/auth/email-verification/request`

- 只接受 `verification_ticket`，不接受客户端任意提交新的 `email` 和 `invite_code`。
- 重新检查 claim、用户状态、邀请码状态和多维限流。
- 生成新 OTP 并立即使旧 OTP 失效，明确使用 rotate 策略。
- 每次成功重发同时生成新 ticket 并原子替换 `ticket_hash/ticket_version`，旧 ticket 立即失效；响应返回新 ticket。
- 重发使用 claim 级串行锁和请求幂等记录。客户端因断网重放同一 `Idempotency-Key` 时必须得到同一个新 ticket 和同一次发送结果，不能再次发信；幂等重放通过 claim/version/nonce 重算 ticket，禁止在幂等缓存保存 ticket 明文。
- MailAdapter 未明确 accepted 时不得提交 ticket 轮换；若服务商结果未知，保持旧 ticket 可用但进入冷却，并返回邮件状态未知，不自动重发。
- 已验证用户返回幂等成功，不再发送邮件。
- 适配器结果未知时不自动重发；用户在冷却后可以明确申请新 OTP。

### 6.3 校验注册 OTP

`POST /api/v1/auth/verify-email`

```json
{
  "verification_ticket": "opaque-ticket",
  "code": "483920"
}
```

流程：

1. 校验 ticket、purpose、TTL、限流和 claim 绑定关系。
2. 对同一 verification identity 获取短时 Redis 串行锁，避免并发请求同时进入 Better Auth。
3. Better Auth 校验 OTP。错误次数由插件维护；同一 OTP 最多 5 次，过期或用尽后必须重发。
4. 校验成功后 Better Auth 一次性消费 verification，并把逻辑 `emailVerified=true` 映射为 `users.email_verified_at` 服务端时间。
5. 立即把 claim 原子转为 `verified`，清空 `ticket_hash/ticket_nonce` 使 ticket 失效；该动作不等待奖励 finalizer。
6. 执行 `EmailVerificationFinalizer`：正式核销邀请码、写审计、评估并发放注册奖励。
7. finalizer 成功后把 claim 转为 `redeemed`；失败时保留 `verified` 供登录/`GET /me` 补偿，不得重新开放 ticket。
8. 返回当前用户摘要。响应不得包含 OTP、邀请码或内部风控原因。

错误验证码未达到 5 次时保留当前 ticket；第 5 次错误、claim 过期或风控封禁时作废 ticket，用户必须在冷却结束后从注册入口重新建立 claim。该策略优先阻断 ticket 泄露后的持续骚扰，不能为了方便重发而长期保留已爆破 ticket。

并发硬门禁：10 个并发请求提交同一个正确 OTP 时，必须恰好 1 个完成首次验证；其余返回幂等已完成或验证码已消费，注册奖励和邀请码核销都只能发生一次。

### 6.4 Verification ticket 业务生命周期

`verification_ticket` 是注册 claim 的短期一次性操作上下文，不是登录凭证，也不是可转发的注册链接：

- 创建 claim 时生成当前版本 ticket；服务端只保存 `ticket_hash`、`ticket_version` 和必要的 nonce 元数据。
- 每次重发只有在邮件投递结果明确为 `accepted` 后才原子轮换 ticket；新 ticket 替换旧 hash/version，旧 ticket 立即返回 `AUTH_VERIFICATION_TICKET_INVALID`。
- `outcome_unknown` 或明确发送失败时不提交轮换，保留旧 ticket 的当前生命周期并进入冷却；不得通过重试接口制造多个有效 ticket。
- 验证成功、第五次错误、claim 过期、风控封禁、用户重新建立注册 claim 时，当前 ticket 立即作废；验证成功后不得重新开放原 ticket。
- ticket 明文只允许出现在 HTTPS 响应体和客户端内存/必要时的 `sessionStorage`；禁止进入 URL、query、浏览器历史、埋点、普通日志、队列 payload、数据库和 `localStorage`。服务端错误只返回 `AUTH_VERIFICATION_TICKET_INVALID`，不说明是泄露、过期还是版本不匹配。
- 同一 `Idempotency-Key` 的安全重放可返回同一轮换结果；幂等记录只保存 hash/版本和脱敏结果，不保存 ticket 明文。

## 7. 登录与找回密码

### 7.1 登录

`POST /api/v1/auth/login`

- 邮箱和密码错误使用统一错误，不暴露账号是否存在。
- 未验证邮箱可以按产品裁决进入受限会话，只允许查看验证提示、重发 OTP、退出和必要的账号恢复；不得生成。
- `GET /api/v1/me` 必须返回服务端验证/风险摘要，前端不得凭本地状态认为邮箱已验证。
- Better Auth session 使用 `HttpOnly`、`Secure`、明确 `SameSite` 的 Cookie；所有认证写接口统一经过 Origin/Host 校验和 CSRF 中间件，不能只在注册 Controller 局部检查。

### 7.2 申请密码重置 OTP

`POST /api/v1/auth/password-reset/request`

```json
{ "email": "user@example.com" }
```

- 找回密码不要求邀请码，否则合法老用户可能失去恢复路径。
- 无论邮箱不存在、未验证、被限流还是已发送，外部都返回相同的 `202` 泛化响应和近似响应时间。
- 只有真实、`email_verified_at` 已置位、可恢复且通过内部限流的账号才调用 Better Auth 和 MailAdapter；未验证注册不能借密码重置绕过 registration ticket。
- reset OTP 与 register OTP 的 purpose、存储标识和限流必须隔离，互不覆盖；找回确认使用规范化 email + reset OTP + new password 一次提交，不复用注册 verification ticket。
- 找回确认再次校验账号已验证，且重置密码不得改变 `email_verified_at`；不满足条件统一按无效 OTP 处理。

### 7.3 确认重置

`POST /api/v1/auth/password-reset/confirm`

```json
{
  "email": "user@example.com",
  "code": "483920",
  "new_password": "server-validated-password"
}
```

- OTP 和新密码必须在同一个受保护请求中提交，不提供“前端记住已验证，再调用无验证码重置”的第二步接口。
- 成功后 OTP 立即失效，并撤销该用户其他会话：`revokeSessionsOnPasswordReset=true`。
- 密码重置成功、失败和风控拦截写脱敏审计，不记录新旧密码或 OTP。

## 8. Better Auth 配置约束

S03 使用经锁文件固定的 Better Auth 版本；提案评审时的候选版本为 `1.6.26`，编码前执行一次 adapter spike，不以文档假设代替实测。

推荐配置：

| 配置              | 值                                   |
| ----------------- | ------------------------------------ |
| plugin            | `emailOTP`                           |
| `otpLength`       | `6`                                  |
| `expiresIn`       | `600` 秒                             |
| `allowedAttempts` | `5`                                  |
| `resendStrategy`  | rotate，不复用旧码                   |
| `storeOTP`        | 自定义 HMAC-SHA-256                  |
| password reset    | `revokeSessionsOnPasswordReset=true` |

OTP 存储规则：

- `auth_verifications.value` 只存 `HMAC-SHA-256(AUTH_OTP_HASH_SECRET, otp)` 或插件支持的等价 keyed hash。
- 禁止明文、可逆加密和无密钥 SHA-256。6 位数字空间太小，普通 hash 可被离线穷举。
- `AUTH_OTP_HASH_SECRET` 与 `AUTH_SECRET`、邮件密钥分离，只在服务端存在。
- 轮换该 secret 会使未过期 OTP 全部失效，必须按密钥轮换操作记录执行。

### 8.1 `email_verified_at` 映射阻断项

当前数据库字段是 `users.email_verified_at timestamptz?`，Better Auth 逻辑字段通常是 `emailVerified:boolean`。编码前必须通过 adapter spike 证明：

```text
null timestamp          -> logical false
non-null timestamp      -> logical true
write logical true      -> set/preserve server timestamp
write logical false     -> set null
```

禁止新增第二个 `email_verified boolean` 形成双真相。若 Better Auth Drizzle adapter 无法可靠完成映射，立即停止实现，先修改 `05` 并重新评审。

### 8.2 并发与失败语义 spike

必须实测插件在 PostgreSQL 上的以下行为：

- 同一个 OTP 并发校验是否只有一次成功。
- 第 5 次错误与正确请求并发时如何裁决。
- 发信 callback 抛错后 verification 记录是否残留、是否可安全重发。
- rotate 后旧 OTP 是否立即失效。
- 密码重置成功后其他会话是否全部撤销。
- OTP 比较是否使用恒定时间或等价安全实现，错误类型和分支耗时是否形成可利用侧信道。
- 腾讯 SES 是否提供可用的退信/投诉 webhook、签名材料和消息去重 ID；若没有，则验证可用的查询 API、轮询频率和配额。

若插件自身不能提供并发一次性保证，Nest 包装层必须保留按 verification identity 的 Redis 串行锁，并以集成测试作为合入门禁；不得改回自研 OTP 状态机来掩盖问题。

## 9. Redis 控制面

Redis key 不出现原始邮箱或邀请码。使用独立 secret 生成稳定摘要：

```text
identity = HMAC_SHA256(AUTH_RATE_LIMIT_SECRET, purpose + "\0" + canonical_email)
invite   = HMAC_SHA256(AUTH_RATE_LIMIT_SECRET, canonical_invite_code)

auth:otp:cooldown:{purpose}:{identity}
auth:otp:window:{purpose}:{identity}:{window}
auth:otp:ip:{purpose}:{ip_hash}:{window}
auth:otp:device:{purpose}:{device_hash}:{window}
auth:invite:window:{invite}:{window}
auth:verify:lock:{purpose}:{identity}
auth:idempotency:{route}:{actor_hash}:{idempotency_key_hash}
```

上面的 `invite` 只用于 Redis 限流 key；数据库邀请码查找使用 `AUTH_INVITE_CODE_KEYRING` 的 active key，奖励邮箱族使用 `AUTH_REWARD_FINGERPRINT_KEYRING`，邮件投递收件人摘要使用 `MAIL_RECIPIENT_HASH_KEYRING`。记录同时保存非敏感 key ID，active key 只负责新写入，仍在有效期/保留期内的旧 key 用于兼容查验。各域 keyring 独立，禁止使用无密钥 SHA-256，也禁止复用 OTP、ticket 或 Better Auth secret，避免一个表泄露后关联其他数据域。

原子性要求：

- 冷却使用 `SET key value NX EX`。
- 多计数器准入、幂等 reservation 和锁释放使用 Lua/Redis Function，禁止 `GET` 后再 `SET`。
- 锁 value 使用随机 owner token，释放时必须比较 owner，不能删除他人的锁。
- Redis 故障时，注册、重发、验证码校验、密码重置和新的密码登录全部 fail closed，统一返回可重试的 `AUTH_TEMPORARILY_UNAVAILABLE` 并触发告警；已有合法 session 的只读访问可以继续。禁止退化为无限密码尝试或仅靠单进程内存限流。

### 9.1 客户端 IP 信任链

限流 IP 不能直接读取客户端可控的 `X-Forwarded-For`、`X-Real-IP` 或 `Forwarded`：

1. Nginx/CDN 必须覆盖而不是透传客户端伪造的真实 IP header，并只把流量转发到内网监听的 API。
2. API 显式配置受信代理 hop/CIDR。只有 TCP peer 位于受信代理集合时才解析代理写入的 header，并按已配置 hop 取原始客户端地址。
3. TCP peer 不受信时，忽略所有转发 header，只使用 socket remote address；不得把客户端自报 header 作为降级来源。
4. staging/beta/production 的实际代理拓扑、`TRUSTED_PROXY_CIDRS` 与预期不一致时启动或健康门禁失败，不能静默放宽。
5. IPv4 按单地址形成限流摘要；IPv6 默认按 `/64` 前缀聚合后 HMAC，避免攻击者在同一前缀内轮换地址绕过。
6. 原始 IP 不进入 Redis key、指标 label 或普通日志；只保存独立 HMAC 摘要。需要安全审计原始 IP 时遵循 `08` 的最小化和保留期裁决。

本地直连 API 时使用 socket remote address，因此仍可测试 IP 限流，不需要信任任何代理 header。

建议初始阈值，评审通过后由 `09` 冻结并支持服务端配置：

| 维度                      | 建议值                            |
| ------------------------- | --------------------------------- |
| 同邮箱 + purpose 发送冷却 | 60 秒 1 次                        |
| 同邮箱 + purpose          | 1 小时 5 次，24 小时 10 次        |
| 同 IP 发信                | 1 小时 30 次                      |
| 同设备发信                | 1 小时 20 次                      |
| 同邀请码注册发信          | 10 分钟 20 次，并受邀请码容量约束 |
| 单 OTP 错误次数           | 5 次后作废                        |
| 同 identity 校验请求      | 10 分钟 10 次                     |
| 同 IP 校验请求            | 10 分钟 60 次                     |

限流响应不得返回还剩多少个邮箱、邀请码容量或账号存在性。对找回密码入口，即使内部被限流，仍返回相同泛化响应。

## 10. 邀请码 claim 与正式核销

现有 `invite_code_redemptions` 要求已有用户且表示正式核销，不能安全表示“发 OTP 前占位”。建议新增 `registration_claims`：

| 字段                    | 说明                                         |
| ----------------------- | -------------------------------------------- |
| `id`                    | uuid 主键，也是 ticket 的服务端引用          |
| `invite_code_id`        | 邀请码                                       |
| `user_id`               | 创建用户后绑定，可暂空                       |
| `email_hash`            | canonical email 的 HMAC，不存第二份明文邮箱  |
| `ticket_hash`           | 可空；256-bit 伪随机 ticket 的 HMAC          |
| `ticket_nonce`          | 非敏感随机 nonce，用于幂等重算 ticket        |
| `ticket_version`        | 每次成功重发递增                             |
| `status`                | `pending/verified/redeemed/released/expired` |
| `idempotency_key`       | 注册请求幂等键                               |
| `expires_at`            | claim 上限                                   |
| `created_at/updated_at` | 服务端 UTC 时间                              |

约束与事务：

- `unique(idempotency_key)`。
- `unique(ticket_hash)` where not null；ticket 只向客户端展示，数据库泄露不能直接伪造验证请求。
- 同一邮箱只允许一个 active registration claim。
- 邀请码行锁内检查 `used_count + active_claim_count < max_uses` 后创建 claim。
- Better Auth 验证成功后先标记 claim verified 并作废 ticket；finalizer 再在同一事务锁邀请码和 claim，增加 `used_count`、创建唯一 redemption、标记 claim redeemed。
- 过期 claim 不占容量；清理任务只改变 claim 状态，不删除安全审计。
- 邀请码用尽、claim 过期或风控拒绝都不得发送奖励。
- verified claim 不得按普通过期任务释放，必须持续重试 finalizer 或进入人工告警；否则会出现邮箱已验证但邀请码未核销。

新建 active claim 前必须先把同邮箱已过期的 pending claim 原子标记为 expired，再依靠 active 唯一约束防并发重复；不能把 `now()` 写进 PostgreSQL partial unique index 谓词。

## 11. 注册奖励 finalizer

邮箱验证成功不直接等于无条件发奖励。`EmailVerificationFinalizer` 执行：

1. 读取服务端 `email_verified_at`，未验证立即拒绝。
2. 幂等正式核销邀请码。
3. S14 前读取受控 legacy 配置，S14 后解析 active reward campaign，并检查活动窗口/预算、风险状态、设备/IP 限制和活动总量；缺少唯一可用活动时 fail closed 不赠送。
4. 以规则版本生成 `reward_mailbox_fingerprint`，原子创建活动维度的 reward claim；重复邮箱族或高风险 relay 不发奖励。
5. 只通过 `packages/credit` 写入注册赠送流水和余额投影。
6. 固定幂等键：`registration_reward:v1:{user_id}`。
7. 写入前后遵循金额工具和 ledger replay 不变量。

建议的 `registration_reward_claims` 最小字段：

| 字段                         | 说明                       |
| ---------------------------- | -------------------------- |
| `id`                         | uuid 主键                  |
| `campaign_key`               | 注册奖励活动版本           |
| `user_id`                    | 领取用户                   |
| `mailbox_fingerprint`        | 奖励邮箱族 HMAC            |
| `fingerprint_key_id`         | 非敏感 HMAC key 版本       |
| `fingerprint_rules_version`  | 生成规则版本               |
| `device_hash/ip_prefix_hash` | 风险信号，不保存原始值     |
| `decision`                   | `pending/granted/rejected` |
| `reason_code`                | 可空脱敏裁决原因           |
| `ledger_id`                  | granted 时关联唯一流水     |
| `created_at/updated_at`      | UTC 时间                   |

数据库至少约束 `unique(campaign_key, user_id)` 和 `unique(campaign_key, mailbox_fingerprint)`。reward claim 从 pending 变为 granted、注册赠送 ledger 和余额投影必须在同一数据库事务内完成；事务中不得调用邮件、DNS 或其他网络服务。

恢复策略：

- OTP 已验证但 finalizer 临时失败时，不回滚邮箱验证。
- 登录和 `GET /api/v1/me` 可以安全重跑 finalizer，依靠固定幂等键补偿。
- 风控拒绝奖励时记录原因，但不撤销邮箱验证。
- 重复验证、重复点击、进程重启和并发请求都不能重复核销或重复发奖励。

## 12. MailAdapter

### 12.1 结构化接口

业务层只能提交受限命令，不提供任意邮件发送能力：

```ts
type AuthMailCommand = {
  deliveryId: string;
  purpose: 'email_verification' | 'password_reset';
  recipient: string;
  otp: string;
  expiresInMinutes: 10;
  locale: 'zh-CN';
};

type MailDispatchResult =
  | { dispatchState: 'accepted'; providerMessageId?: string }
  | { dispatchState: 'not_dispatched'; errorCode: string }
  | { dispatchState: 'outcome_unknown'; errorCode: string };
```

- `recipient`、`otp` 只在调用栈内短暂存在，不写普通日志、队列 payload 或数据库。
- 模板由服务端固定，用户输入经过 HTML 转义；客户端不能控制 `from`、subject、HTML 或 template ID。
- 对明确 `not_dispatched` 可做最多 2 次短退避重试，并复用同一个内存 OTP。
- 对 `accepted` 不重试；对超时且无法确认是否受理的 `outcome_unknown` 不自动重发。

### 12.2 环境矩阵

| 环境                    | `MAIL_PROVIDER` | 行为                                                        |
| ----------------------- | --------------- | ----------------------------------------------------------- |
| automated test          | `fake`          | 捕获结构化命令，测试从 adapter 读取 OTP；禁止 HTTP 调试接口 |
| local development       | `console`       | 在 API 控制台打印脱敏邮箱和 OTP，仅 local 可注册            |
| local optional          | `smtp`          | 投递本地 Mailpit，浏览器查看完整邮件                        |
| staging/beta/production | `tencent_ses`   | 腾讯 SES 真实投递；无密钥或配置错误启动失败                 |

硬门禁：

- `NODE_ENV` 只控制 Node 运行模式；adapter 准入使用 `APP_ENV=local|test|staging|beta|production`。
- `fake` 只能在 `APP_ENV=test`。
- `console` 和本地 SMTP 只能在 `APP_ENV=local`。
- staging/beta/production 禁止 console/fake，禁止发送失败后降级打印 OTP。
- SMTP 主机和 SES endpoint 只来自服务端配置，客户端不得传入，防止 SSRF。
- 本地开发不购买腾讯 SES，不要求真实云账号即可完成全部认证业务和失败路径测试。
- 腾讯 SES adapter 可以通过 mocked SDK 做契约测试，但在拿到真实账号前不得宣称真实投递、SPF/DKIM、退信 webhook 已验收。
- 上线凭证使用独立腾讯云子账号和最小发信权限，不授予模板管理、账号管理或其他云资源权限；配置服务商日配额和异常发送告警。

Mailpit 只作为可选开发依赖。Docker 镜像必须固定版本或 digest，不使用 `latest`；默认 SMTP `127.0.0.1:1025`、Web UI `127.0.0.1:8025`，最终以 compose 配置为准。

## 13. 邮件投递可观测性

S03 要求发送失败和退信可观测。建议通过前向 migration 新增最小 `mail_deliveries`，不保存邮件内容：

| 字段                    | 说明                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `id`                    | delivery ID                                                       |
| `user_id`               | 可空用户 ID                                                       |
| `recipient_hash`        | 收件人 HMAC                                                       |
| `recipient_hash_key_id` | 非敏感 HMAC key 版本                                              |
| `purpose`               | 验证/重置                                                         |
| `provider`              | fake/console/smtp/tencent_ses                                     |
| `provider_message_id`   | 可空服务商消息 ID                                                 |
| `status`                | `queued/sent/delivered/bounced/complained/failed/outcome_unknown` |
| `attempt_count`         | 投递尝试次数                                                      |
| `last_error_code`       | 脱敏错误码                                                        |
| `idempotency_key`       | 唯一投递幂等键                                                    |
| `created_at/updated_at` | UTC 时间                                                          |

禁止保存 OTP、完整邮箱、subject、HTML、文本正文、SDK 原始错误或响应。

投递时序必须先于网络调用落可恢复意图：

1. 以唯一 idempotency key 插入 `queued` delivery，提交事务。
2. 在事务外调用 MailAdapter。
3. 根据明确结果更新为 `sent`、`failed` 或 `outcome_unknown`。
4. 定时恢复扫描超过短阈值仍为 `queued` 的记录。除非适配器能证明请求未离开本机，否则一律转为 `outcome_unknown`，不得自动重发。
5. `not_dispatched` 的短退避重试更新同一 delivery 的 `attempt_count`，不能新建另一条投递记录。

进程在服务商已受理后、写本地状态前崩溃时，恢复扫描会把悬挂 queued 记录收敛为 `outcome_unknown`；不盲目重发。用户可以在冷却后明确申请新 OTP，新请求轮换旧码。

腾讯 SES 的退信/投诉通知能力属于上线前 spike，提案不预设一定存在 webhook：

- 若官方能力提供带可验证来源/签名和稳定消息 ID 的 webhook，则必须验签、限制来源、按 provider event ID 去重并关联 `provider_message_id`。
- 若只提供查询 API，则实现有配额控制和游标/时间窗的定时查询，保证重复结果幂等。
- 若两者都不能满足可观测性，腾讯 SES adapter 不得通过 production 门禁，应评估同区域备选服务。
- bounce/complaint 最终都只能形成收件人风险、指标和告警信号，不能把服务商原始 payload 长期写入业务库。

## 14. API 与错误语义

建议对外路由：

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/email-verification/request
POST /api/v1/auth/verify-email
POST /api/v1/auth/password-reset/request
POST /api/v1/auth/password-reset/confirm
GET  /api/v1/me
```

`POST /api/v1/invites/redeem` 不应由前端在验证前单独调用；邀请码正式核销收敛进 verification finalizer。若保留该路由，只能作为已验证用户的幂等内部语义，不能绕过验证门禁。

所有写接口遵循 `06` 的 `Idempotency-Key` 规则。建议新增稳定错误码：

| 错误码                             | 外部语义                                                 |
| ---------------------------------- | -------------------------------------------------------- |
| `REGISTRATION_NOT_ELIGIBLE`        | 当前无法完成注册；提示检查邀请码和邮箱，但不细分内部原因 |
| `AUTH_VERIFICATION_REQUIRED`       | 邮箱尚未验证                                             |
| `AUTH_OTP_INVALID_OR_EXPIRED`      | 验证码错误、已过期或已消费                               |
| `AUTH_OTP_ATTEMPTS_EXCEEDED`       | 尝试过多，需重新申请                                     |
| `AUTH_OTP_RATE_LIMITED`            | 操作过于频繁                                             |
| `AUTH_VERIFICATION_TICKET_INVALID` | 验证上下文失效                                           |
| `AUTH_MAIL_UNAVAILABLE`            | 邮件暂不可用，未宣称已发送                               |
| `AUTH_TEMPORARILY_UNAVAILABLE`     | 认证保护依赖不可用，请稍后重试                           |

找回密码申请接口不返回账号不存在、未验证或限流的差异错误；内部指标保留原因分类。

## 15. 环境变量

评审通过后，用明确的 Provider 变量替换 `10` 中过于宽泛的 Mail 示例：

```text
MAIL_PROVIDER=fake|console|smtp|tencent_ses
APP_ENV=local|test|staging|beta|production
MAIL_FROM=
MAIL_FROM_NAME=

MAIL_SMTP_HOST=
MAIL_SMTP_PORT=
MAIL_SMTP_SECURE=

MAIL_TENCENT_SECRET_ID=
MAIL_TENCENT_SECRET_KEY=
MAIL_TENCENT_REGION=
MAIL_TENCENT_ENDPOINT=
MAIL_TENCENT_TEMPLATE_ID_VERIFY=
MAIL_TENCENT_TEMPLATE_ID_RESET=
MAIL_WEBHOOK_SECRET=

AUTH_OTP_HASH_SECRET=
AUTH_RATE_LIMIT_SECRET=
AUTH_VERIFICATION_TICKET_SECRET=
AUTH_INVITE_CODE_ACTIVE_KEY_ID=
AUTH_INVITE_CODE_KEYRING=
AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID=
AUTH_REWARD_FINGERPRINT_KEYRING=
MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID=
MAIL_RECIPIENT_HASH_KEYRING=

TRUSTED_PROXY_CIDRS=
```

- `.env.example` 只放空占位或非敏感本地默认值，不提交真实密钥。
- 腾讯密钥、OTP、ticket、限流、邀请码、奖励邮箱族、收件人摘要和 Better Auth secret 相互独立，不允许跨数据域复用。
- `MAIL_TENCENT_ENDPOINT` 必须经过配置白名单校验，不能成为任意 URL。
- `TRUSTED_PROXY_CIDRS` 只接受部署配置中的明确 CIDR，不允许生产使用“信任任意代理”。

## 16. 测试与验收

### 16.1 单元测试

- 邮箱规范化、HMAC key、邀请码统一错误和模板转义。
- Unicode/IDNA 顺序覆盖全角域名、零宽字符、组合字符和非法 punycode；同一输入在注册、登录、限流和指纹路径结果一致。
- 每个 MailAdapter 至少覆盖 accepted/not_dispatched/outcome_unknown。
- 环境门禁：production + console/fake 必须启动失败。
- 注册奖励 finalizer 覆盖成功、重复、风险拒绝、活动封顶和补偿重跑。
- Gmail 点号/`+tag`/`googlemail.com` 奖励指纹归一；未知域名不得误用 Gmail 规则。
- 已知 relay/disposable 域在 Beta 门禁下不调用 MailAdapter，或按已裁决策略只注册不奖励。

### 16.2 API 集成测试

- 无邀请码、无效、过期、用尽、停用、邮箱不匹配：均不创建 OTP、不调用 MailAdapter。
- 10 个并发注册请求不能超发 invite claim，不能创建重复用户。
- OTP 正确、错误、5 次作废、10 分钟过期、rotate、purpose 隔离、一次性消费。
- 10 个并发正确 OTP 恰好一次首次成功；邀请码和奖励恰好一次。
- Gmail 别名变体即使形成多个账号，同一活动也只能获得一次注册奖励。
- 邀请码 keyring 切换 active key 后，旧 key 创建且未过期的邀请码仍可验证；奖励 fingerprint 换 active key 后仍会跨旧 key 阻止重复领取。
- 重复 `Idempotency-Key` 不重复发送；不同 payload 复用同一 key 返回冲突。
- 反复申请新 OTP 不能绕过邮箱/IP/设备/邀请码窗口。
- 重发成功后旧 ticket 立即失效；重复幂等请求返回同一新 ticket；验证成功、5 次错误和 claim 过期均使 ticket 失效。
- 伪造 `X-Forwarded-For`、`X-Real-IP` 和 `Forwarded` 不能改变非受信直连请求的限流身份；受信代理 hop 取值和 IPv6 `/64` 聚合有测试。
- 找回不存在和存在邮箱的外部状态/响应结构一致，只有存在账号时 Fake adapter 收到邮件。
- 重置成功后所有旧会话失效。
- Redis 故障时发信、校验、重置和新密码登录 fail closed；已有合法 session 的只读请求可继续。
- queued delivery 在 adapter 调用前已存在；模拟 accepted 后进程崩溃，恢复扫描只转 outcome_unknown，不重复发送。
- 认证写接口统一验证 Origin/Host、Cookie 属性和 CSRF；伪造跨站请求不能触发发信或登录。

### 16.3 E2E

- 访客输入草稿 -> 注册 -> 邀请码有效 -> Fake OTP -> 验证 -> 回到工作台，草稿仍在且不自动发送。
- 无效邀请码停留在注册弹层，不出现验证码步骤，Fake adapter 调用次数为 0。
- 未验证用户登录后只能进入验证流程，不能发起生成。
- 找回密码完成后旧密码失败、新密码成功、旧会话失效。

### 16.4 本地人工验收

开发阶段无需腾讯 SES：

1. `MAIL_PROVIDER=console` 跑通注册和找回全流程。
2. 可选 `MAIL_PROVIDER=smtp`，在 Mailpit UI 检查中文主题、正文、有效期和移动端排版。
3. 模拟 adapter 拒绝、超时和结果未知，确认 UI 不会错误显示“已发送”。
4. 检查日志无完整邮箱、邀请码、OTP（console adapter 的 local 专用输出除外）。

### 16.5 真实服务验收边界

没有购买腾讯 SES 时，以下项目明确未验收：

- 真实域名和发件地址验证。
- SPF/DKIM/DMARC。
- 腾讯 SES 模板审核和真实投递率。
- bounce/complaint webhook 的真实签名与回调。
- 中国大陆/HK 网络和到达时延。

这些项目在拿到 staging 账号后完成，不阻塞本地 S03 业务逻辑开发，但阻塞 production 上线。切换时只允许增加配置和完成真实 adapter smoke，不修改 OTP、邀请、限流和奖励语义。

## 17. 评审通过后的文档回写

编码前按裁决顺序更新：

1. `05`：`email_verified_at` 映射、`auth_verifications` 所有权、`registration_claims`、`registration_reward_claims`、`mail_deliveries`、`assets/artifacts.content_hash`、`invite_codes.key_id`、审计枚举和相关索引。
2. `06`：统一 `/api/v1` 路径、OTP payload、幂等、错误码；把“邮箱验证令牌”改为“邮箱 OTP”；明确删除公开 redeem 路径或将其限定为 finalizer 内部语义，禁止两条核销路径并存。
3. `08`：ticket/session/CSRF、邮箱/IP/设备摘要、代理信任链、secret 分域、日志脱敏和数据保留期。
4. `09`：冻结限流阈值、Redis 故障门禁、queued delivery 恢复扫描、邮件指标、失败/退信告警和真实服务 smoke 门禁。
5. `10`：环境矩阵、受信代理配置、精确 Mail/Auth secret 变量、本地 Mailpit 可选服务和 production 启动门禁。
6. S03：已把验证链接口径改为验证码/重复提交，并明确本地不购买 SES、production 前补真实投递验收。
7. `07` 与设计文档：验证码步骤、重发冷却、邀请码失败和邮件不可用状态，不新增独立营销页。

现有 `user_activity_type` 只有 login/logout 等值，建议通过前向 migration 增加：

```text
register | email_verify | password_reset | registration_reward | risk_block
```

## 18. 正反审查清单

正向必须成立：

- 有效邀请码 -> 创建 claim -> 创建未验证用户 -> 发送 OTP -> 验证 -> 正式核销 -> 幂等奖励。
- 本地 console/smtp 与未来腾讯 SES 使用同一 OTP、邀请、限流和奖励逻辑。
- 邮件发送失败可见且可恢复，不影响邀请码最终一致性。
- 用户验证成功但奖励暂时失败时，可以安全补偿。

反向必须证明：

- 无效邀请码、脚本绕过 UI、伪造 ticket 均不能发邮件。
- 任意业务模块不能把 MailAdapter 当开放邮件工具调用。
- 假邮箱、重复邮箱、一次性邮箱不能在未验证时获得奖励或生成权限。
- Gmail 点号/`+tag` 与已知 relay 地址不能绕过活动维度的奖励唯一性和风险门禁。
- 重放 OTP、并发 OTP、重放幂等键、反复重发不能重复验证、核销或奖励。
- 数据库、Redis、日志、事件、队列和 mail delivery 表均无 OTP 明文。
- production 不可能配置 console/fake，也不可能在 SES 失败时静默降级。

## 19. 外部依据

- Better Auth Email OTP：<https://www.better-auth.com/docs/plugins/email-otp>
- Better Auth Email & Password：<https://www.better-auth.com/docs/authentication/email-password>
- 腾讯云 SES Node.js SDK：<https://www.npmjs.com/package/tencentcloud-sdk-nodejs-ses>

依赖版本必须进入 `pnpm-lock.yaml`，不使用文档中的“最新版本”作为可重复构建依据。
