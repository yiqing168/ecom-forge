# 管理台控制面架构与安全边界提案

| 项       | 内容                                                               |
| -------- | ------------------------------------------------------------------ |
| 状态     | v0.2 复审通过，进入 S14 正式契约与编码                             |
| 适用范围 | S14 完整独立管理台、S21 运营增强及后续管理能力                     |
| 当前任务 | S14 按本提案创建 `apps/admin`、独立身份域和完整 Beta 控制面        |
| 目标     | 管理能力仅对授权管理员开放，且用户量增长或部署拆分时不重写权限语义 |
| 最后更新 | 2026-08-09                                                         |

> 本提案不改变 S03 注册、邀请码核销和邮件契约。评审通过后，先回写 `05`、`06`、`07`、`08`、`09`、`10`、S14/S21 和相关设计文档，再进入管理台编码。

> **不可变原则：管理台与创作平台是两个独立前端应用。** 同仓库共享基础包不改变应用、部署、路由、会话和权限边界；不得把管理页面塞进 `apps/web`，也不得把普通用户页面塞进 `apps/admin`。

## 1. 结论

管理台是独立控制面，不是创作平台中隐藏的普通页面：

```text
apps/web                         apps/admin
用户创作平台                    管理控制面
www.example.com                 ops.example.com
        |                               |
        | /api/v1/*                     | /api/v1/admin/*
        v                               v
public ingress                  admin ingress / identity gateway
        |                               |
        +------------ apps/api --------+
                     服务端最终鉴权
```

- `apps/web` 承载 Agent、商品、资产、作品、任务和专业画布；不得包含管理页面、管理路由或管理 bundle。
- `apps/admin` 是独立 Next.js 应用、独立域名和独立部署单元；第一版可与 API 同机部署，但不能与 `apps/web` 合并。
- 管理 API 统一为 `/api/v1/admin/*`。普通 API 域名对该前缀在反向代理层直接返回 `404`，不转发到应用。
- 管理域名通过同源反向代理访问管理 API，并在网络入口、Admin Session、MFA、RBAC/permission 和资源级校验五层同时设防。
- 管理员身份、凭据、Session 和 MFA 与普通用户认证域隔离；不得只依赖 `users.role` 或前端隐藏菜单。
- 日常邀请码生成归 S14 管理台；S14 完成前，S03 只提供受控 CLI/seed 过渡入口，不开放管理 HTTP API。
- S03 按既有 SPEC 继续编码，本提案不成为其阻塞依赖。

## 2. 范围与非目标

### 2.1 本提案冻结

- 应用、域名、部署和网络信任边界。
- 管理员身份、Session、MFA、权限和敏感操作升级认证。
- 管理 API 的统一防护链和错误行为。
- 邀请码、模型/Provider Key、用户风险、账本与审计的控制面边界。
- S03 到 S14 的邀请码生成过渡方式。
- 单机 Beta 到多实例部署的无重构路径。

### 2.2 本提案不冻结

- 管理台导航、页面布局、图表、表格密度和视觉系统。
- 最终身份网关、MFA 库、云密钥管理服务的供应商。
- S14/S21 之外的 CRM、工单、团队协作和商业智能能力。
- 正式 API DTO、数据库字段和枚举；这些必须在提案复审通过后回写正式契约。

## 3. 应用与部署边界

### 3.1 Monorepo 目录

评审通过后的目标目录：

```text
apps/
  web/                 # 用户创作平台
  admin/               # 管理控制面，仅管理人员使用
  api/                 # public/admin API 的最终权限裁决
  worker/
packages/
  admin-auth/          # 可选：无 UI 的管理员认证/权限领域包
  db/
  types/
  shared/
```

`apps/admin` 可以通过 `packages/ui` 等稳定 workspace 包复用无业务语义基础件和设计 token，但不得跨应用导入 `apps/web` 的组件目录、页面、用户会话 store 或业务 route。应用之间只通过 `@ecom-forge/*` 的稳定包和 HTTP 契约共享能力。

当前仓库若仍存在 `apps/web/app/admin` 或同类 mock 页面，只能视为未上线原型，不得接入真实管理 API、不得进入生产部署。S14 交付时必须将其移除，并将管理入口迁移到 `apps/admin`。

### 3.2 域名与入口

| 入口              | 用途                 | 规则                                    |
| ----------------- | -------------------- | --------------------------------------- |
| `www.example.com` | 用户创作平台         | 不提供管理路由和管理 bundle             |
| `api.example.com` | 普通 API             | `/api/v1/admin/*` 在 ingress 直接 `404` |
| `ops.example.com` | 管理台和同源管理 API | 只允许管理入口访问，强制 HTTPS          |
| API 内部地址      | NestJS               | 仅 loopback/私网可达，不直接暴露公网    |

一个已持有的一级主域名可以承载 `www`、`api`、`ops` 等子域名，不要求为管理台另购第二个一级域名；DNS、证书、WAF 和流量成本仍以实际供应商套餐和上线验收为准，不作“永久免费”承诺。

最早期封闭内测可以不为管理台配置公网 DNS：`apps/admin` 和管理 ingress 仅监听 loopback/私网，管理员通过 SSH 隧道进入。SSH 隧道只是网络入口隔离，不能替代独立 Admin Session、MFA、permission 和审计。开始多人运营或开放远程值守前，切换到 `ops.example.com`，并启用身份网关、VPN 或受控来源 allowlist；切换只改变入口配置，不改变管理 API 和授权语义。

本地开发可使用 `http://localhost:3002` 运行 `apps/admin`，但这只是开发便利，不代表生产网络隔离已验收。

### 3.3 请求信任链

管理请求必须按以下顺序验证：

1. 管理入口只接受配置的 Host，拒绝未知 Host。
2. ingress 覆盖客户端传入的 `Forwarded`、`X-Forwarded-*` 和内部管理标记。
3. staging/beta/production 必须至少启用身份网关、VPN 或受控来源 allowlist 之一，先做人员/设备/来源策略校验；不得把管理登录页直接暴露为无外围限制的普通公网入口。
4. API 只信任 `TRUSTED_ADMIN_PROXY_CIDRS` 内的直接上游；生产拓扑不匹配时健康门禁失败。
5. API 校验独立 Admin Session、CSRF/Origin/Host、MFA 强度、permission 和资源范围。

Host、来源 IP、前端路由、中间件、allowlist 或身份网关中的任意一项都不能单独构成最终授权。即使绕过 `apps/admin` 直接请求 API，服务端仍必须拒绝。外围入口不可用时管理面关闭，不能降级成只有账号密码的公网登录。

## 4. 管理员身份与 Session 隔离

### 4.1 独立身份域

推荐使用独立管理身份表，至少包含：

- `admin_principals`：管理员主体、状态和身份版本。
- `admin_credentials`：密码/WebAuthn/TOTP 等凭据引用。
- `admin_sessions`：独立 Session、认证强度、最近 step-up 时间和撤销状态。
- `admin_role_bindings`：角色绑定和作用域。
- `admin_mfa_recovery_codes`：只保存 keyed hash 的恢复码。

普通 `users` 账号不能凭 `users.role=admin|operator` 直接换取 Admin Session。现有 `users.role` 在正式回写时应降为用户域兼容字段或迁移来源，不能继续作为管理控制面的唯一授权真相。

管理账号不开放自助注册、公开找回或社交登录。创建、停用、恢复和角色变更必须走受控管理流程并写审计。

### 4.2 Cookie 与浏览器隔离

- staging/production 管理 Session 使用独立 `__Host-ecom_admin_session` Cookie；local/test 若明确关闭 Secure，只能使用不带 `__Host-` 前缀的开发 Cookie 名。
- staging/production Cookie 必须 `HttpOnly; Secure; SameSite=Strict; Path=/`，不得设置 `Domain`；local/test 仍必须 `HttpOnly; SameSite=Strict; Path=/`，并由 typed config 限制环境。
- 普通用户 Cookie 不在 `ops.example.com` 生效，Admin Cookie 不在 `www.example.com`/`api.example.com` 生效。
- Session token 禁止进入 URL、`localStorage`、前端日志、埋点或错误报告。
- 管理页面禁止第三方脚本和不必要的跨域资源，使用严格 CSP、`frame-ancestors 'none'`、`no-store` 和防 MIME sniffing 响应头。
- Next.js middleware/route guard 只用于尽早跳转；敏感数据加载和每个 API 调用仍由 NestJS 最终鉴权。

### 4.3 MFA 与 step-up

- 所有管理账号强制 MFA；WebAuthn 优先，TOTP 可作为 Beta 最低实现，禁止短信作为唯一二次认证。
- 恢复码只展示一次并保存 keyed hash；使用后立即作废。
- 登录成功后的 Session 记录认证强度和 `mfa_verified_at`。
- 密码阶段与 MFA 最终登录的成功/失败均写独立审计，使用服务端 UTC 时间、可信来源 IP HMAC 和 User-Agent 摘要关联异常来源；不得保存登录标识、密码、OTP、原始 IP 或原始 User-Agent。
- 邀请码批量生成、角色变更、Provider Key 更新、账本冲正、风险封禁、模型全局熔断等操作要求近期 step-up，并设置短 TTL。
- MFA 删除、账号解锁和恢复码重置不能仅凭当前低强度 Session 完成。

## 5. 授权模型

### 5.1 默认拒绝

管理授权使用 permission，不把 `role === 'admin'` 散落在 Controller：

```text
AdminGuard
  -> active principal
  -> active, unrevoked admin session
  -> MFA assurance / step-up freshness
  -> required permission
  -> target scope / resource policy
  -> audit context
```

Controller 只声明权限，领域 Service 再校验目标状态、并发版本和不可变业务约束。前端按钮可见性仅用于体验，不构成授权。

### 5.2 最小角色建议

| 角色             | 典型权限                                | 明确禁止                                          |
| ---------------- | --------------------------------------- | ------------------------------------------------- |
| `support`        | 用户摘要、任务摘要、申诉只读            | 密钥、账本写、角色管理、完整 prompt/资产 URL      |
| `operations`     | 任务处置、邀请码、内容复核、模型熔断    | Provider Key 明文、角色管理、直接改账本           |
| `finance`        | 对账、申诉和经审批的账本冲正            | 用户密钥、模型密钥、管理员管理                    |
| `security_admin` | 风险账户、管理员 Session 撤销、安全审计 | 账本冲正、业务配置任意修改                        |
| `super_admin`    | 角色绑定、系统级恢复                    | 仍需 MFA、step-up、原因和审计，不得绕过业务不变量 |

权限示例：`invites.read`、`invites.write`、`tasks.read`、`models.control`、`provider_keys.rotate`、`credits.reconcile`、`credits.correct`、`appeals.decide`、`risk.manage`、`admin_accounts.manage`、`audit.read`。

权限与角色映射采用版本化配置或数据库记录；默认无权限。新增权限必须回写 API 权限矩阵并补拒绝测试。

### 5.3 自我操作与越权限制

- 管理员不得给自己提权、解除自己的高风险限制或删除自己的最后一个 MFA。
- 最后一个可用 `super_admin` 不得被直接停用。
- 对同一对象的写操作必须带 `expected_revision` 或等价条件更新，冲突返回 `409`，禁止 last-write-wins。
- 禁止提供任意 SQL、任意 HTTP、任意邮件或任意 Provider 请求的“万能工具”。
- 管理员可以审计查看用户数据，但不得代替用户编辑画布、修改 prompt 或接管产物所有权。

## 6. 管理 API 防护契约

所有 `/api/v1/admin/*` 请求必须满足：

- 仅从管理 ingress 到达；普通 ingress 直接 `404`。
- 独立 Admin Session，不接受普通用户 Bearer/Cookie。
- 写请求校验 Origin、Host、CSRF token 和 `Idempotency-Key`。
- 权限、资源范围、风险状态和 step-up 在服务端逐请求校验。
- 写操作提交原因；高风险操作先展示影响摘要并二次确认。
- 统一速率限制和异常告警；登录、MFA、密钥更新和批量邀请码使用更严格阈值。
- 响应不包含密钥、Cookie、OTP、邀请码 digest、完整邮箱、签名 URL、完整 prompt 或 Provider 原始错误。
- 所有写操作和敏感读取写 `admin_audit_logs`；审计写入失败时高风险操作 fail closed。

权限不足对已认证管理员返回稳定的 `403`；未建立有效 Admin Session 时返回 `401`。普通公共入口始终在网络层返回 `404`，避免暴露控制面路由。

## 7. 邀请码管理

### 7.1 阶段归属

- S03：校验邀请码、创建 claim、邮箱验证后 finalizer 正式核销；不实现公开 redeem，也不实现管理页面。
- S03 到 S14 过渡期：提供受控 `scripts/ops/create-invite` 或等价 CLI，仅服务器/本地管理员可执行。
- S14：`apps/admin` 提供邀请码活动、批次创建、受控明文查看与复制、查询、只增调整、停用和使用/奖励转化统计，调用受保护的管理 API。
- S21：按运营需求增加更细 CRM、自动化触达和双人审批，不改变 HMAC、容量锁、批次发行上限和核销语义。

CLI 必须调用与管理 API 相同的领域 Service，不能直接拼 SQL。生产执行要求服务器环境和管理员/部署身份。CLI 不接受邀请码明文作为命令行参数，也不接受把邀请码写入配置文件；邀请码只能由服务端 CSPRNG 生成，并在一次性交互确认后写到受控终端/标准输出。CLI 不得自动写文件、shell history、补全缓存、通用日志、队列或数据库明文列；审计只写批次和摘要，并写 `actor_type=bootstrap_cli`。非交互环境默认拒绝明文输出，除非调用方显式提供受控输出 FD，并由调用方负责不落盘。

### 7.2 管理能力

第一版至少支持：

- 创建单个或受限批量邀请码。
- 配置 `max_uses`、`expires_at`、邮箱/域名约束、活动标识和内部备注。
- 查询前缀、状态、已用数、有效 claim 数、剩余容量、创建人和时间；不返回明文或 digest。
- 停用邀请码。已存在的 verified/redemption 记录不删除；停用后不再接受新 claim。
- 查看使用统计和关联审计，不向管理端泄露 OTP、ticket 或用户完整敏感字段。

创建响应中的明文邀请码设置 `Cache-Control: no-store`，幂等重放不得返回明文。数据库以 `code_digest/key_id` 作为注册校验真相，并为 S14A 后新记录使用独立版本化 AES-GCM keyring 保存单码密文；普通列表、详情、审计和日志不得返回明文、digest、密文或可复原列表。列表一键复制使用的 reveal 必须经过 `invites.write`、近期 step-up 和成功审计，不要求管理员填写 reason 或经过额外弹窗；历史 HMAC-only 记录不可恢复时只能停用并创建替代码。停用后不允许重新启用，避免历史状态歧义。

建议的权限拆分为 `invites.read` 和 `invites.write`。批量生成、提高容量或延长有效期要求 step-up、原因、批量上限和独立限流。

## 8. 模型与 Provider Key 管理

- 模型配置、模型熔断和 Provider Key 分成不同 permission，不能因为能熔断模型就能更新密钥。
- Provider Key 使用密钥管理服务，或使用服务端主密钥做 envelope encryption 后入库；主密钥不入数据库。
- 管理端只提供创建、替换、验证和撤销，不提供读取原始密钥的 API。
- 响应只返回 `key_hint`、`key_version`、状态、创建/验证时间和脱敏错误码。
- Key 明文只存在于 HTTPS 请求体和服务端受控内存，禁止进入审计 before/after、异常堆栈、队列 payload 或 Provider 请求日志。
- 验证密钥通过固定 Provider capability 命令异步执行；不得允许管理员提交任意 URL、header 或请求体。
- 轮换采用“新增版本 -> 验证 -> 切 active -> 观察 -> 撤销旧版本”，支持回滚，不原地覆盖。

## 9. 用户、资金与高风险操作

- 用户查询默认返回脱敏摘要；查看敏感资产、完整邮箱或安全记录需要额外 permission 并记录敏感读取审计。
- 风险账户冻结、解冻必须提交原因、影响范围和 `expected_revision`；不得直接修改业务表绕过领域规则。
- 积分冲正必须通过 `packages/credit` 写新的 correction ledger，禁止 UPDATE/DELETE 历史流水。
- 申诉裁决、账本冲正、奖励活动激活/停用、全局模型熔断和管理员权限变更均属于高风险操作，要求 step-up 和幂等键。
- 单人 Beta 可以先采用“step-up + 原因 + 完整审计”，但数据结构和 API 必须允许后续增加双人审批，不重写实际业务动作。

## 10. 审计、日志与告警

### 10.1 审计字段

管理审计至少记录：

- `actor_admin_id`、角色/权限快照、Admin Session ID。
- `action`、`target_type`、`target_id`。
- 脱敏的 `before_json`、`after_json` 和操作原因。
- `request_id`、`trace_id`、幂等键摘要。
- 可信来源 IP 的 HMAC、User-Agent 摘要、入口身份结果。
- `mfa_level`、`step_up_at`、执行结果和错误码。
- `created_at`，统一 UTC。

审计日志为追加写，业务代码不得更新或删除。邀请码明文、Provider Key、OTP、ticket、Cookie、完整 prompt、签名 URL 和图片二进制禁止进入审计。

### 10.2 必须告警

- 管理登录/MFA 连续失败、异常来源或休眠账号登录。
- 管理员角色、MFA、Session 或恢复方式发生变化。
- 批量邀请码生成、Provider Key 轮换、账本冲正、风险账户批量处理。
- 普通 ingress 命中 `/api/v1/admin/*` 或 API 收到非受信管理来源。
- 审计写入失败、管理请求拒绝率突增或高风险幂等冲突。

## 11. Bootstrap、恢复与人员离职

- 第一个 `super_admin` 只能通过部署期 CLI 创建；CLI 要求交互式确认、强密码和立即绑定 MFA。
- 禁止 seed 默认管理员、固定密码、公开注册或通过环境变量长期保存管理员密码。
- emergency/break-glass 账号默认禁用，凭据离线保管；每次启用都告警并在使用后轮换。
- 管理员离职或设备丢失时，停用 principal、撤销全部 Admin Session、撤销恢复码并轮换其可接触的共享密钥。
- 管理员锁死恢复不能通过普通用户找回流程完成；由受控 CLI 或另一名 `super_admin` 执行并审计。

## 12. 扩容与部署演进

初期可以由同一个 NestJS 进程承载 public/admin module，但必须保持独立入口、guard、session store 和模块边界。扩容时可把 admin module 拆为独立进程，API DTO、permission、审计和领域 Service 不变。

```text
香港单机 Beta
  ops nginx -> apps/admin + apps/api(admin module)

多实例
  identity gateway -> admin ingress -> apps/admin
                                 -> admin API instances
                                      -> PostgreSQL/Redis/secret manager
```

- Admin Session、权限和审计真相存 PostgreSQL；Redis 可做短期 session cache、限流和 step-up nonce，但 Redis 丢失不能产生越权。
- 权限变更或 principal 停用后，通过 `authz_version`/session version 使旧 Session 立即失效，不依赖缓存自然过期。
- 高风险写操作使用数据库事务、条件更新和幂等键；不能依赖单进程内存锁。
- 身份网关、Nginx、云 WAF 或 VPN 可以替换，但 API 的最终授权与审计语义不变。

## 13. 故障与降级

| 故障                         | 行为                                                   |
| ---------------------------- | ------------------------------------------------------ |
| Admin Session/权限存储不可用 | 管理请求 fail closed                                   |
| MFA/step-up 服务不可用       | 高风险操作 fail closed，只读是否开放由权限策略显式配置 |
| 审计写入失败                 | 高风险写操作 fail closed；只读敏感操作同样拒绝         |
| Redis 不可用                 | 不得绕过限流或 step-up；管理登录和写操作 fail closed   |
| 身份网关不可用               | 管理入口关闭，不回退为公网直连                         |
| Provider Key 验证超时        | 状态为 unknown，不自动覆盖 active key                  |
| 权限缓存过期/断连            | 回源数据库或拒绝，不能沿用无法验证的旧授权             |

## 14. 测试与验收门禁

### 14.1 自动化测试

- 普通用户 Cookie/Bearer 请求所有 admin API 均失败。
- admin Cookie 不能用于普通用户身份冒充，普通 Cookie 不能换取 Admin Session。
- 无 MFA、MFA 过期、step-up 过期、权限不足、作用域不符均被拒绝。
- 客户端伪造 Host、XFF、内部入口标记不能绕过管理 ingress。
- 普通 API host 的 admin 路径返回 `404`，管理 host 未认证返回 `401`。
- CSRF、Origin、Host、幂等键、并发 revision 和限流失败路径完整覆盖。
- 停用管理员或调整权限后，已有 Session 立即失效。
- 创建响应只返回一次明文；列表、审计、日志和数据库均无明文，后续仅允许单码受控 reveal 返回。
- Provider Key 写后不可读取；异常、审计和队列无明文。
- 高风险操作审计失败时业务写入不生效。
- 账本冲正只能追加 ledger，无法改写历史流水。

### 14.2 上线人工验收

- 从公网普通域名无法发现或访问管理 API。
- 未经过管理入口/VPN/身份网关无法建立 Admin Session。
- 有头浏览器验证 Cookie domain、CSP、无第三方脚本和退出后 Session 撤销。
- 使用最小权限账号逐项验证可见范围和服务端拒绝行为。
- 执行一次邀请码创建、模型熔断、Key 轮换演练、风险处理和账本模拟冲正，逐条核对审计 ID。
- 完成管理员锁死恢复、设备丢失、人员离职和 break-glass 演练。

## 15. 分阶段交付

### 当前：S03

- 不创建 `apps/admin`。
- 实现邀请码验证/claim/finalizer 和安全邮件认证链路。
- 为测试和受控部署准备 CLI/seed 邀请码；不开放管理 HTTP API。

### S14：完整 Beta 管理控制面

- 创建 `apps/admin`、独立 Admin Auth、MFA、permission guard 和管理 ingress 配置。
- 实现邀请码活动/批次管理、任务查询、模型熔断、申诉裁决、风险账户、版本化奖励活动、账本对账和审计查询。
- 用户中心仍在 `apps/web`；管理台只在 `apps/admin`。

### S21：运营增强

- 增加会员授予/撤销、批量队列、细化风险策略和双人审批能力。
- 不改变独立控制面、Admin Session、permission 和审计边界。

## 16. 提案通过后的正式回写清单

1. `05`：增加独立管理员身份/Session/MFA/角色绑定字段；扩展 `admin_audit_logs`，处理现有 `users.role` 兼容语义。
2. `06`：运营 API 从旧 `/api/admin/*` 统一为 `/api/v1/admin/*`；增加管理鉴权、权限、邀请码和 Key 写入契约。
3. `07`：删除普通创作站账号菜单中的运营台入口；管理台不计入普通产品壳页面族。
4. `08`：增加 Admin Session、MFA、step-up、permission、CSP、审计 fail-closed 和 bootstrap 安全。
5. `09`：增加管理登录、越权、审计、Key 轮换和 break-glass 告警及演练。
6. `10`：加入 `apps/admin`、独立域名/入口、普通 host 的 admin 404、管理代理信任链和扩容拓扑。
7. S14/S21：按本提案重写交付面、依赖、接口、测试和验收清单。
8. `docs/design` 与 research：移除同站 `/admin` 和普通账号菜单入口，后续单独建立 Admin 页面与 overlay 清单。
9. S03：明确过渡期只允许受控 `scripts/ops/create-invite`/seed 调用邀请码领域 Service，不开放管理 HTTP API；S03 不负责管理台页面。

## 17. 编码前 spike

S14 开工前必须完成并记录：

- Better Auth 或候选认证库是否支持完全独立的 admin base path、Cookie、表名和 MFA；不满足时采用独立 Admin Auth module。
- WebAuthn/TOTP、恢复码和 step-up 的库能力及并发/撤销行为。
- 香港 Beta 可用的身份网关/VPN方案，以及无网关时 Nginx + 私网的最低安全部署。
- Provider Key 使用云 secret manager 还是 envelope encryption 的成本、轮换和恢复路径。
- 审计追加写、脱敏和外部归档方案；确认审计失败与业务事务的原子边界。

spike 未通过不得用普通用户 Session、前端路由隐藏或明文配置作为临时替代。
