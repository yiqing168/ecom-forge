# S03 鉴权、邀请内测与用户基础

| 项     | 内容                                                     |
| ------ | -------------------------------------------------------- |
| 状态   | v0.3 实现完成，待验收                                    |
| 阶段   | 1A / D1-D2                                               |
| 优先级 | P0                                                       |
| 目标   | 实现邮箱账号、邀请内测、OTP 验证、注册奖励和基础用户状态 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` §2.1
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/proposals/S03-email-otp-and-mail-delivery.md`
- `docs/proposals/backend-environment-and-scaling-conventions.md`

依赖未完成前不得用临时业务语义实现；本 SPEC 与上述正式契约冲突时，先改文档并复审。

## 当前模块范围

包含邮箱注册、密码登录、邮箱 OTP 验证、找回/重置密码、邀请码/白名单门禁、注册赠送积分、风险账户限制、当前用户接口和登录注册弹层。

不包含第三方登录、手机号、微信、支付、任意邮件发送工具和真实 Provider 生成逻辑。

本地开发不购买或调用腾讯云 SES。业务校验逻辑与生产一致，邮件 IO 通过适配器切换：local console/可选 Mailpit、test fake、staging/beta/production 腾讯 SES 或经评审批准的同区域替代适配器。

S14 管理台交付前，本 SPEC 同时提供受控 `scripts/ops/create-invite`/seed 作为邀请码创建过渡入口。它只调用邀请码领域 Service，不开放管理 HTTP API，不提供管理页面；邀请码必须由服务端 CSPRNG 生成，明文不得作为命令行参数或配置输入，只允许一次性写入受控交互终端。数据库、日志、审计、队列和生成文件均不得保存明文。

## 交付面

| 交付面   | 要求                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 前端/UI  | A01 弹层内登录/注册/找回/OTP/重置状态；固定高度错误区；草稿保留且登录后不自动发送           |
| 后端/API | `/api/v1` auth routes、邀请码资格门禁、claim、OTP/ticket、session、当前用户、邮件适配器     |
| 数据库   | users 映射、Better Auth 表、registration claims/reward claims、HMAC 邀请码、mail deliveries |
| 安全     | Origin/Host/CSRF、可信代理 IP、多维限流、Redis fail-closed、日志脱敏、secret 分域           |
| 测试     | Vitest、Supertest、Playwright 覆盖成功路径、并发、重放、故障、无效邀请码和假邮箱风险        |
| 审计     | 注册、登录、OTP 验证、密码重置、邀请码正式核销、奖励裁决、风险拦截写安全摘要日志            |

## 接口契约

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/email-verification/request`
- `POST /api/v1/auth/verify-email`
- `POST /api/v1/auth/password-reset/request`
- `POST /api/v1/auth/password-reset/confirm`
- `GET /api/v1/me`

不实现公开的 `POST /api/v1/invites/redeem`。正式核销只允许注册验证码通过后的服务端完成事务执行，避免前端绕过验证码占用邀请码或触发奖励。

### 注册请求

请求字段：`email`、`password`、`display_name`、`invite_code`、`agreement_version`，写请求必须带 `Idempotency-Key`。

服务端顺序：

1. 校验 Origin/Host、content type、DTO 和低成本来源限流。
2. 规范化邮箱；用当前及有效历史 keyring HMAC 查验邀请码。
3. 在邀请码行锁事务内检查白名单、状态、过期时间和 `used_count + active_claim_count < max_uses`。
4. 创建或幂等恢复 `registration_claims`，其中只保存完成注册所需的待验证邮箱、昵称、密码哈希和协议版本；此时不得创建 `users`、credential account 或 Session。
5. 调用 Better Auth 的密码哈希与 OTP 生成能力，持久化 OTP HMAC；待注册 claim 和 OTP 都有明确有效期，终局后清除密码哈希等待注册凭据。
6. 写入 `mail_deliveries.queued` 并提交；随后在事务外调用固定认证 MailAdapter。
7. 只有邮件明确 `accepted` 才返回“验证码已发送”和有效 ticket；`not_dispatched` 返回 `AUTH_MAIL_UNAVAILABLE`，`outcome_unknown` 不自动重投且显示暂不可用。

无效、过期、用尽、停用、邮箱不匹配的邀请码统一返回 `REGISTRATION_NOT_ELIGIBLE`，不创建用户、claim、OTP 或 mail delivery，不调用邮件适配器。不能因为客户端输入任意字符串、脚本直接调用接口或猜测邮箱域名而绕过门禁。

### OTP 与 ticket

- OTP 为 6 位数字，有效期 10 分钟，单码最多错误 5 次，成功后一次性消费。
- 重发只接受当前 ticket，60 秒冷却；邮件 `accepted` 后旧 OTP 和旧 ticket 立即失效，并返回新 ticket。
- 相同 `Idempotency-Key` 重放返回同一结果和同一新 ticket，不重复发信；不同 payload 返回 `IDEMPOTENCY_CONFLICT`。
- ticket 为 256-bit 不透明值，服务端只保存 HMAC、版本和 nonce；只进 HTTPS 响应体与前端内存/必要 `sessionStorage`，禁止 URL、日志、队列和 `localStorage`。
- 验证成功、第五次错误、claim 过期或风险封禁都立即作废 ticket；失效统一返回 `AUTH_VERIFICATION_TICKET_INVALID`。
- 注册 OTP 校验、正式用户与 credential account 创建、邀请码核销、claim 转 `redeemed`、注册赠送 ledger 和余额投影必须在同一数据库事务完成；任一步失败则全部回滚，验证码与 ticket 保持可按剩余次数重试。
- 正式用户创建时 `email_verified_at` 直接置为服务端验证完成时间。系统不创建“未验证账号”，也不存在后置邮箱验证解锁或 finalizer 补偿路径；事务提交后再签发 Session。

### 找回密码

- 找回申请不要求邀请码；无论邮箱存在、未验证、限流或不存在，外部均返回相同结构 `202`，防止账号枚举。
- 只有存在账号、`email_verified_at` 已置位且通过服务端限流时才创建绑定 `password_reset` purpose 的 OTP 和邮件投递；未验证注册必须继续走 registration ticket，不能借密码重置完成邮箱验证。
- reset confirm 使用 `email`、OTP 和新密码一次提交；服务端再次确认账号已验证，成功后撤销该用户全部旧 session，旧密码和 OTP 均失效，不复用注册 verification ticket，也不得改变 `email_verified_at`。

## 业务规则

- 验证码通过前没有正式账号，不能登录、生成、上传或进入收费任务链路。
- 注册奖励只在注册完成事务中通过 `packages/credit` 发放，固定幂等键和账本 replay 校验保证不重复。
- Gmail 点号、`+tag`、`googlemail.com` 仅在明确公共 Gmail 域规则下归一；Google Workspace、自有域、catch-all 和未知 relay 不套用 Gmail 规则。
- 已知 disposable/relay 域在封闭 Beta 默认在发信前返回 `REGISTRATION_NOT_ELIGIBLE`，不消耗邮件；若未来允许注册，也不得自动发奖励。
- `reward_mailbox_fingerprint` 与邀请码 HMAC 使用独立 keyring；同活动同邮箱族只能领取一次。IP/设备只做风险信号和阈值，不单独作为全局唯一条件。
- 注册/重发/验证/找回/重置/新密码登录的 Redis 控制面不可用时 fail closed，返回 `AUTH_TEMPORARILY_UNAVAILABLE`；已有合法 session 的只读访问可继续。
- 风险账户仅允许查看历史和申诉；所有状态由服务端权限映射，不暴露内部枚举。
- 数据库事务内禁止邮件、DNS、Provider 或其他网络调用；邮件结果通过 `mail_deliveries` 和恢复扫描收敛。

## 测试标准

### 单元与集成

使用 Vitest + Supertest，至少覆盖：

- 邮箱 Unicode/IDNA 规范化顺序、Gmail 别名和未知 relay 规则；HMAC keyring 轮换与旧 key 查验。
- 无邀请码、无效/过期/用尽/停用/邮箱不匹配：均不创建 OTP、不调用 MailAdapter。
- 10 个并发注册不能超发 invite claim，不能创建重复用户。
- OTP 正确、错误、第五次作废、过期、重发轮换、purpose 隔离、一次性消费。
- 10 个并发正确 OTP 恰好一次成功，邀请码核销和奖励恰好一次。
- ticket 重发轮换、旧 ticket 失效、成功/第五次错误/claim 过期作废、幂等重放不重复发信。
- 伪造 `X-Forwarded-For`、`X-Real-IP`、`Forwarded` 不能改变非受信请求的限流身份；受信代理 hop 和 IPv6 `/64` 聚合正确。
- 找回密码账号枚举抵抗、重置后旧密码失败和旧 session 撤销。
- Redis 故障下认证写操作 fail closed，合法 session 只读仍可用。
- `mail_deliveries.queued` 在 adapter 调用前存在；accepted 后模拟崩溃只转 `outcome_unknown`，不重复发送。
- Origin/Host、Cookie 属性和 CSRF 反例；错误配置不能把 console/fake 带入 production。
- 过渡邀请码 CLI 只写 HMAC/key ID/prefix，禁止明文参数、明文数据库列、管理 HTTP 路由和非交互默认输出。

### E2E

Playwright 覆盖：访客草稿 -> 登录弹层 -> 注册 -> 有效邀请码 -> Fake OTP -> 验证 -> 回工作台，草稿保留且不自动发送；无效邀请码停留在注册态且无验证码/邮件；未验证用户不能生成；找回密码完成后新密码可用、旧 session 失效。

## 本地与上线验收

- local 使用 `MAIL_PROVIDER=console` 跑通注册和找回；可选固定版本 Mailpit 查看中文邮件 HTML。
- `pnpm test:e2e:s03-live` 启动隔离的真实 Web/API，通过 ConsoleMailAdapter 跑通注册、OTP 验证、清理 session 后重新登录；测试不得拦截 `/api/v1/**`，也不得增加返回 OTP 的应用接口。
- test 使用 FakeMailAdapter，禁止任何返回 OTP 的调试 HTTP 接口。
- staging 取得真实邮件服务后，向受控邮箱完成注册 OTP 验证和密码重置 smoke，核对 `email_verified_at`、注册 ticket、session、投递状态和退信/投诉观测。
- 没有腾讯 SES 账号时，真实域名/SPF/DKIM/DMARC、模板审核、真实到达率、webhook/query 能力均标记为未验收；它们阻塞 beta/production，不阻塞 local 业务逻辑开发。

## 验收清单

- [ ] 新用户可完成注册、OTP 验证和登录。
- [ ] 无邀请码/非白名单按配置拦截，且不创建 OTP、不发邮件。
- [ ] 重发冷却、OTP 过期、第五次错误、一次性消费和 purpose 隔离正确。
- [ ] 注册奖励不会重复发，Gmail 别名和 relay 风险不能绕过活动去重。
- [ ] 风险账户不能发起生成；验证码通过前数据库中不存在正式用户或 credential account。
- [ ] Redis 故障和邮件 accepted/outcome_unknown 恢复路径符合 fail-closed 契约。
- [ ] production 邮件适配器只通过配置切换，真实 smoke、退信和发送失败可观测。
- [ ] S14 前可通过受控 CLI/seed 创建邀请码，且普通 Web/API 无邀请码管理入口。
