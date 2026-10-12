# S14A 生图内测最小控制面

| 项     | 内容                                                              |
| ------ | ----------------------------------------------------------------- |
| 状态   | v0.7 本地实现完成待复审                                           |
| 阶段   | 1A / D4                                                           |
| 优先级 | P0                                                                |
| 依赖   | S03-S10 已验收；不依赖 S11-S13B                                   |
| 目标   | 只交付打通 Agent 生图内测所需的安全控制面、邀请码、模型与价格目录 |

## 开工前必读

- `docs/03-provider-poc-and-cost-model.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/proposals/admin-control-plane-architecture-and-security.md`
- `docs/design/01-full-site-screen-flow-spec.md`
- `docs/design/03-v0-full-site-ui-interaction-prompt.md`

> 当前入口状态（2026-08-30）：用户侧账户页改为读取真实用户、积分账户和积分账本；商品导航与“商品白底精修”入口暂时隐藏。该隐藏是产品展示开关，不删除对应 API、Skill 或历史数据能力。

> 会员权益查询尚未实现，`/account/membership` 暂不提供用户入口；恢复前必须完成真实会员查询、空状态和权限测试，不得恢复静态占位数据。

## 1. 边界与顺序

原 S14 拆为两个可独立评审、验收和提交的子任务：

- `S14A` 是 S11-S13B 的前置，只解决“管理员能安全配置，内测用户能获得邀请码，创作端能读取已发布的推理/图片模型和积分规格”。
- `S14B` 在 S13B 后、S15 前补齐完整运营管理台，见 `docs/spec/S14B-complete-operations-admin-console.md`。S14B 不得反向阻塞 S11-S13B 编码和本地真实生图闭环。

固定顺序为 `S14A -> S11 -> S12 -> S13A -> S13B -> S14B -> S15`。S12/S13A/S13B 仍负责真正的图片调用、安全审核、产物发布与结算；S14A 不以配置页冒充生成闭环。

S14A 包含：

- `apps/admin` 独立管理应用、Admin Auth、TOTP MFA、step-up、permission、审计和管理入口门禁。
- 内测邀请码的查询、单个/受限批量生成、首次返回明文、后续受控查看与复制、使用状态和终局停用。
- 单页模型配置：Brain/生图/视频用途、OpenAI/Anthropic/Google 协议、接口地址、write-only Key、真实模型下拉、编辑与移除。Google 仅用于多模态 Brain，列表仍用 OpenAI 格式，推理按 `03` 使用 Google 原生接口；图片和视频用途保持 OpenAI。
- 生图模型 1K/2K/4K 每张积分和视频模型 720p/1080p/4K 每秒积分，均从模型列表行进入配置；Brain 不配置公开积分。
- 私有对象存储的 write-only 凭据、固定验证和本地运行入口。
- 用户侧 `GET /api/v1/model-catalog`；视频在 S16 前只保存模型与积分配置，不进入可执行目录。
- 上述操作所需的最小 permission、step-up、幂等和审计。

S14A 不包含：运营总览、用户风险、任务运行、资金/申诉/奖励、Skill 发布 UI、管理员团队生命周期、完整审计健康 UI、完整用户中心、支付、CRM、团队协作、会员售卖、S12 内容审核队列、S16 视频执行、任意 SQL/HTTP/Provider 调试器。已经提前实现的 S14B 后端代码和前向迁移保留，不回滚，但不计入 S14A 验收，也不得要求继续铺对应页面。

## 2. 应用与前端技术

### 2.1 独立应用

- 新建 `apps/admin`，使用 Next.js 16 App Router、React 19、TypeScript、Tailwind CSS 4。
- Admin 与当前 `apps/web` 锁定同一前端基线：Next.js `16.3.0`、React `19.2.8`、Tailwind CSS `4.3.3`、仓库 TypeScript `5.9.3`；不得为管理台引入第二套框架或漂移的核心版本。
- 管理台组件栈锁定 `antd@5.29.3` + `@ant-design/pro-components@2.8.10`，图标锁定 `@ant-design/icons@6.3.2`；React 19 兼容层使用 `@ant-design/v5-patch-for-react-19@1.0.3`，App Router registry 使用 `@ant-design/nextjs-registry@1.3.0`，CSS layer 使用 `@ant-design/cssinjs@1.23.0`。只把组件库接入现有 Next.js App Router，不引入 Umi、Max、react-router、ProLayout 脚手架或第二套构建/路由/权限框架。
- App Router 的服务端样式收集统一使用 `@ant-design/nextjs-registry`。Tailwind 只负责页面布局、响应式和少量应用级 token，不重复实现 antd/ProComponents 已拥有的表单、表格、弹窗、反馈和数据展示组件；必须通过 CSS layer/reset 配置消除 Tailwind 4 preflight 与 antd CSS-in-JS 的优先级冲突，禁止靠页面级 `!important` 修补。
- 管理表单状态唯一归 `Form`/`ProForm`；Zod 保留为共享 DTO、边界解析和提交前契约校验来源，不与 React Hook Form 建立双状态桥接。服务端 DTO/Guard/领域 Service 仍是校验、权限和业务裁决真相。
- 管理列表优先使用 `ProTable`，但所有已冻结的 keyset API 继续只接受 `cursor + limit`、返回 `items + next_cursor`，不得退化为 offset/page number。`apps/admin` 必须提供一个共享 cursor data-source adapter，维护已访问页的 cursor 链、绑定筛选 canonical state，并在筛选/排序变化后清空链；不伪造 `total`，未知页跳转不可用时使用上一页/下一页交互。模块不得各自复制分页适配逻辑。
- 权限菜单和按钮可按当前 Session permission snapshot 做展示收敛，但 `AdminPermissionGuard`、scope、step-up、expected revision、幂等和审计仍由服务端逐请求裁决；不得使用 Pro/Umi 的前端 access、mock 或 initial state 作为权限真相。
- 批量迁移前先做最小兼容性 spike，只覆盖 Next.js `16.3.0`、React `19.2.8`、Tailwind CSS `4.3.3` 下的 SSR/hydration、registry 样式、ProTable cursor 请求、ProForm 校验、Modal/Message 上下文和 production build。当前精确版本 spike 与 production build 已通过并锁入 `pnpm-lock.yaml`；后续若 ProComponents 升级在该基线上出现阻塞兼容问题，则降级为纯 antd Table/Form/Descriptions + 仓库内薄封装，不能降级核心 Next/React/Tailwind 版本。
- 本地固定 `http://127.0.0.1:3002`；生产为 `ops.<domain>` 独立部署。`apps/admin` 不导入 `apps/web` 组件、用户 Session store 或 route。
- 管理台是高密度工作界面：固定侧栏、页级工具栏、表格/详情分栏、明确筛选和批量操作；不做营销 Hero、装饰动画或卡片套卡片。
- S14 删除 `apps/web/app/admin` 及其只为该路由存在的组件/导航入口。普通 web host 请求管理路径返回 404。

### 2.2 管理页面

S14A 只交付 3 个领域入口，侧栏按“内测准入 / 生成配置”形成清晰层级；不得显示 S14B 的空菜单，也不得把服务端内部数据结构拆成运营菜单：

| #   | 页面         | S14A 动作闭环                                                                                                 |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | 邀请码       | 条件查询、cursor 分页、单个/受限批量生成、受控明文查看与复制、使用摘要、终局停用                              |
| 2   | 模型配置     | 选择用途和协议，填写接口地址与 write-only Key，获取模型列表并下拉选择；添加后形成列表，可修改、配置积分或删除 |
| 3   | 私有对象存储 | 私有 bucket、write-only Key、put/head/range/delete 固定验证、激活/撤销                                        |

管理产品中只有“模型配置”一个模型管理概念。“服务通道”“适配器注册表”“模型快照”“用户模型目录”“规格与积分”不得成为主导航、页面、Tab、前置步骤或要求管理员理解的文案。运行历史必须固定的数据可作为数据库内部记录存在，但不能形成第二套配置对象。添加、修改、积分配置和删除都从同一模型列表完成。

登录、MFA、step-up 和本人凭据轮换属于壳层安全流程，不额外占一个运营菜单。每个查询页必须有领域查询条件、真实 cursor 分页、详情/证据、加载/空/错误/409 冲突状态；下拉框显示中文 `label`，提交稳定英文 `value`。新增、修改、停用按领域状态机提供，禁止万能 JSON 编辑器、假按钮、mock 管理数据或机械 CRUD。

## 3. Admin Auth 与入口信任链

### 3.1 独立身份域

实现独立 Admin Auth module，不复用普通 Better Auth user/session/account 表，不接受 `users.role`。Beta 使用密码 + TOTP MFA；WebAuthn 保留后续扩展位。

S14A 的验收范围只包括首个 `super_admin` bootstrap、密码 + TOTP/恢复码登录、本人安全操作、step-up、退出和 Session 失效。下述多人 enrollment、角色调整、人员离职和最后 `super_admin` 管理契约保留不变，但其管理页面与完整 E2E 归 S14B；已经实现的后端无需删除。

```text
identifier + password
  -> 短期 MFA challenge（不能访问管理资源）
  -> TOTP / 单次恢复码
  -> Admin Session + 内存态 CSRF token
```

- 密码使用经评审库实现 Argon2id，参数版本写入 credential metadata；禁止自研密码哈希。
- TOTP secret 使用 envelope encryption；恢复码仅保存独立 HMAC hash，一次消费。
- Admin Session token 使用 256-bit CSPRNG，只在独立管理 Cookie 返回，数据库保存 keyed hash；staging/production 使用 `__Host-ecom_admin_session`，local/test 在关闭 Secure 时使用不带 `__Host-` 前缀的开发 Cookie 名。
- 生产 Cookie 必须为 `HttpOnly; Secure; SameSite=Strict; Path=/`，不设置 Domain；local/test 即使关闭 Secure 也必须保留 `SameSite=Strict; Path=/`，并由 typed config 明确限制为开发环境。
- CSRF 使用 synchronizer token：服务端以独立 key 从原始 Session token + session ID 确定性派生，只通过已认证同源 session 响应返回并保存在页面内存；数据库只存 hash/key ID，刷新后可重新派生获取，不写 localStorage/sessionStorage。
- 登录、MFA、恢复码、step-up、写操作在 Redis 不可用时 fail closed。Session 和 permission 真相仍在 PostgreSQL。
- 首个 `super_admin` 只能通过交互式部署 CLI 创建，立即绑定 TOTP；不提供默认账号、seed 密码、公开注册或普通找回密码。
- 后续管理员只能由具备 `admin_accounts.manage` 的管理员创建为 `pending_enrollment`。创建事务同时生成短期一次 enrollment token；不生成临时密码，不通过普通用户邮件找回流程激活。
- 登录 identifier 只保存独立 HMAC 与不可登录的掩码 hint；查询同时尝试 active/历史 keyring，完整密码 + MFA 成功后才可 revision CAS 重键，轮换 HMAC key 不能锁死既有管理员或合并两个 principal。
- enrollment token 明文只在创建或重新签发的首次成功响应显示一次。幂等重放、列表、详情、审计和日志均不得恢复；丢失后只能撤销旧 token 并重新签发。
- 受邀管理员在 Admin Origin 内以 POST body 提交 token 和新密码，服务端原子 claim token、保存 Argon2id hash、创建待确认 TOTP credential/challenge，并一次返回 provisioning secret/URI。TOTP 验证成功后才激活 principal、消费 token/challenge，并一次返回恢复码。
- enrollment 中断或过期不产生 active principal/Session。另一名 `super_admin` 可执行重新开通，原 token、待确认 credential、challenge、Session 和恢复码全部撤销；不能对自己或最后一个 active `super_admin` 执行。

### 3.2 会话与 step-up API

| 方法   | 路径                                           | 行为                                                  |
| ------ | ---------------------------------------------- | ----------------------------------------------------- |
| `POST` | `/api/v1/admin/auth/local-session`             | 仅 local + loopback 创建/复用本地管理员并签发 Session |
| `POST` | `/api/v1/admin/auth/login`                     | 校验密码，返回短期 MFA challenge                      |
| `POST` | `/api/v1/admin/auth/mfa/totp/verify`           | 验证 challenge + TOTP，签发 Session                   |
| `POST` | `/api/v1/admin/auth/mfa/recovery/verify`       | 单次消费恢复码并签发受限 Session                      |
| `GET`  | `/api/v1/admin/auth/session`                   | 返回 principal、permission、MFA/step-up 与 CSRF token |
| `POST` | `/api/v1/admin/auth/step-up`                   | 密码 + TOTP 再认证，刷新短 TTL                        |
| `POST` | `/api/v1/admin/auth/logout`                    | 撤销当前 Session 并清 Cookie                          |
| `POST` | `/api/v1/admin/auth/sessions/revoke-all`       | 撤销本人其他 Session                                  |
| `POST` | `/api/v1/admin/enrollment/start`               | token + 新密码换取一次 TOTP provisioning challenge    |
| `POST` | `/api/v1/admin/enrollment/activate`            | 验证 TOTP，激活账号并一次返回恢复码                   |
| `POST` | `/api/v1/admin/auth/password/change`           | step-up 后修改本人密码并撤销其他 Session              |
| `POST` | `/api/v1/admin/auth/mfa/totp/rotate/start`     | step-up 或受限恢复 Session 开始重新绑定 TOTP          |
| `POST` | `/api/v1/admin/auth/mfa/totp/rotate/confirm`   | 验证新 TOTP，切换凭据并撤销旧恢复码/其他 Session      |
| `POST` | `/api/v1/admin/auth/mfa/recovery-codes/rotate` | step-up 后轮换并一次返回新恢复码                      |

auth 响应全部 `Cache-Control: no-store`。challenge、Session、CSRF、TOTP、恢复码不得进入日志、审计 before/after、URL 或客户端持久化存储。

`local-session` 是本地开发便利入口，不是可部署的认证模式：只允许 `APP_ENV=local`、请求 socket 为 loopback、Host 属于本地 Admin allowlist，且必须通过 Admin Origin 校验；其他环境统一返回 404。它不接受账号、密码、角色或权限参数，服务端按固定 identifier `local-admin@ecom-forge.test` 创建或复用唯一 active `super_admin`，签发与密码 + TOTP 流程相同的短期 Cookie/CSRF Session，并写 `admin.auth.local_session` 审计。前端仅在服务端明确返回 `local_login_available=true` 时显示“一键进入本地管理台”，不得通过前端环境变量单独开启；step-up 在 local session 内视为本次本机动作已验证。刷新页面继续使用 Cookie 恢复 Session，不重复创建 principal。staging/beta/production 的路由、响应与页面均不得暴露该入口。

`enrollment/start` 的 strict body 为 `{ enrollment_token, new_password }`；成功 claim 后旧 token 不可再次开始流程。响应中的 TOTP secret/provisioning URI 不得被浏览器缓存、持久化或进入埋点；响应丢失时由另一管理员重新签发，服务端不得提供读取接口。`enrollment/activate` 成功前不能签发 Admin Session；成功响应签发正常 Session，并只在该响应显示新恢复码。密码、TOTP 或恢复码轮换均递增 credential/principal revision 与 `authz_version`，撤销其他 Session；恢复码登录得到的 restricted Session 只能访问本人安全接口、TOTP rotate 和 logout。

### 3.3 五层校验

所有管理请求按固定顺序验证：Admin Host → 受信管理代理/本地 loopback → Origin/CSRF → active Admin Session + authz version + MFA → permission/scope。普通 host 的 `/api/v1/admin/*` 返回 404；管理 host 无 Session 返回 401；已认证但权限不足返回 403。

### 3.4 管理账号与安全 API

| 方法   | 路径                                                   | 权限                    | 行为                                                |
| ------ | ------------------------------------------------------ | ----------------------- | --------------------------------------------------- |
| `GET`  | `/api/v1/admin/admin-principals`                       | `admin_accounts.read`   | 脱敏 principal、角色、MFA 和 Session 摘要           |
| `POST` | `/api/v1/admin/admin-principals`                       | `admin_accounts.manage` | 创建 pending principal，并首次返回 enrollment token |
| `GET`  | `/api/v1/admin/admin-principals/{id}`                  | `admin_accounts.read`   | 账号、binding、MFA、Session 与审计摘要              |
| `PUT`  | `/api/v1/admin/admin-principals/{id}/role-bindings`    | `admin_accounts.manage` | 以完整目标集合替换 binding，revision CAS            |
| `POST` | `/api/v1/admin/admin-principals/{id}/enrollment-token` | `admin_accounts.manage` | 撤销旧 token 后重新签发，一次明文                   |
| `POST` | `/api/v1/admin/admin-principals/{id}/reset-enrollment` | `admin_accounts.manage` | 锁死恢复：撤销凭据/Session 后回到 pending           |
| `POST` | `/api/v1/admin/admin-principals/{id}/disable`          | `admin_accounts.manage` | 终局停用并撤销凭据、Session 与恢复码                |
| `GET`  | `/api/v1/admin/admin-principals/{id}/sessions`         | `admin_accounts.read`   | 仅返回设备/时间/IP hash 等脱敏摘要                  |
| `POST` | `/api/v1/admin/admin-sessions/{id}/revoke`             | `admin_accounts.manage` | 撤销指定 Session                                    |

所有写接口要求 step-up、reason、`Idempotency-Key` 和 expected principal/binding revision。创建响应丢失后不得重放 enrollment token，只能走重新签发。角色替换必须由服务端展开固定 role registry 并保存 permission snapshot；请求不能直接提交任意 permission。管理员不得修改自己的 binding、对自己 reset enrollment/disable，不能撤销自己当前操作所依赖的唯一 MFA，也不能使 active `super_admin` 数量降到零。所有可能改变 super_admin 集合/有效 MFA 的事务先获取同一固定 transaction advisory lock，再重读目标和全局可用成员；并发更新只有一个 CAS 成功，失败返回 409 并要求刷新。

## 4. Permission 与高风险操作

permission 至少包含：

```text
dashboard.read
invites.read / invites.write
users.read / risk.manage / sessions.revoke
tasks.read / tasks.control
providers.read / provider_keys.rotate
storage.read / storage_keys.rotate
models.read / models.write / models.publish / models.control
moderation.read / moderation.decide
pricing.read / pricing.write / pricing.publish
credits.read / credits.reconcile / credits.correct
appeals.read / appeals.decide / rewards.manage
skills.read / skills.install / skills.review / skills.publish
admin_accounts.read / admin_accounts.manage
audit.read / health.read
```

批量邀请码、Key 更新/激活/撤销、模型/价格发布、模型全局熔断、内容安全人工裁决、风险账户变更、账本冲正、申诉裁决、Skill approve/disable/publish/rollback、管理员/MFA/角色变更必须 step-up、reason、`Idempotency-Key`、expected revision 和成功审计同事务。

管理员不得给自己提权、删除自己的最后一个 MFA、解除自己的风险限制或停用最后一个可用 `super_admin`。前端隐藏按钮不构成权限；领域 Service 必须再次裁决对象状态和 scope。

## 5. Provider、模型与用户选择目录

### 5.1 模型配置真相

管理员只创建和管理“模型配置”。服务端内部必须同时固定该配置的密钥版本、运行参数、测试证据、公开信息和积分价格，以保证 Key 不泄漏、历史任务不漂移、用户选择不被静默换模、资金报价可重放；这些内部记录不得变成新的管理对象或页面。

用户模型类别固定为 `brain | image | video`。同一类别可发布多个模型，用户在 S11 页面自行选择：

- `brain`：Agent 推理模型；可配置多个，默认一个，用户选择固定到 turn snapshot。
- `image`：生图、指令编辑、放大能力；只展示精确支持的操作和规格。
- `video`：可建档多个；S16 门禁通过前只能 hidden/draft，不能进入可执行 catalog。

Skill 是知识/工作流，模型是执行引擎，两者独立。primary Skill 仍必选；模型目录按 Skill required capabilities、用户权限、环境和 rollout 过滤，但 Skill 不能携带 Key、价格或强制绕过用户模型选择。

管理台模型配置采用单一“模型配置”入口，按用途区分 Brain/生图/视频；填写协议/接口地址/Key 后从真实接口获取模型列表，通过下拉选择精确模型，Key 只写不回显。普通用户自带 Key、模型配置与用户账号绑定、Key 回显，以及绕过服务端可用目录提交 raw model ID 均不进入当前平台。

### 5.2 模型配置

- 新增模型固定为一个短流程：选择用途 `brain | image | video` → 选择协议 `openai | anthropic | google`（生图/视频固定 `openai`）→ 填写 HTTPS 接口地址和 Key → 点击“获取模型” → 从接口本次返回的模型名下拉选择一个 → 点击“添加模型”。添加请求重新校验该模型并一次生效；失败不创建半成品。视频可配置但在 S16 前不进入可执行目录。
- “获取模型”必须真实调用中转站模型列表接口。OpenAI 和 Google 类型都使用配置 API 根下的 `models` 资源及 OpenAI Bearer 格式；Anthropic 使用中转站兼容资源及其原生认证 header。列表格式不决定 Brain 推理协议。请求失败、超时、无模型或响应不合法时明确报错且不落库；不得使用硬编码列表、历史缓存或自由文本冒充接口返回。
- 管理员通常只填写接口地址，例如 `https://relay.example.com`，不要求手工填写 `/v1`。服务端在地址没有路径时自动使用 `/v1`；若中转站明确提供带路径的 API 根地址也可直接粘贴。服务端规范化尾部斜杠并追加相对资源，禁止重复拼接 `/v1/v1`。生产仍执行 HTTPS、relay allowlist、DNS/IP 和重定向防护，但这些是服务端安全校验，不是管理员需要选择的端点/region/adapter 概念。
- 列表只显示用途、协议、脱敏接口主机、模型名、Key hint、运行状态和积分摘要。主操作只有“添加模型”“修改”“积分配置”“删除”；Brain 行不显示“积分配置”。
- 一条配置只对应一个 Key、一个接口路径、一个协议和一个模型。要接入另一个模型就新增另一条配置；运行时始终调用用户选定且管理台已启用的精确模型，不随机切换、不跨模型 fallback。
- 积分与连接信息分开编辑，但都从同一模型列表行进入。生图固定配置 1K/2K/4K 每张积分；视频固定配置 720p/1080p/4K 每秒积分；首次保存和后续修改复用同一入口。积分没有独立删除动作，删除模型时一并撤下当前积分；Brain 首版费用包含，不显示 token 定价。

以下 Provider/credential/model/catalog/pricing 表只承担密钥隔离、历史固定、资金报价与用户可见投影，不构成额外产品概念：

- 协议映射和 relay policy 来自编译期代码；管理端只提交协议与 allowlist 内的 HTTPS API 路径，不能提交任意 header 或 request JSON。接口路径不出现在用户目录或用户请求中。
- 每条模型配置有独立 Key 版本、revision、配额和 circuit scope；一个 Key 不在多条模型配置间隐式共享。
- Provider/Storage 的通道控制事务统一按“控制域 transaction advisory lock → channel → credential → validation run/runtime”加锁；同一通道的激活、轮换、撤销、停用并发只能有一个 revision CAS 赢家，禁止 credential→channel 与 channel→credential 反向取锁。
- Key 只写不读，使用 envelope encryption；列表只返回由独立版本化 HMAC keyring 生成的 hint、version、status 和 verified_at，hint 不得使用裸 SHA-256，也不得复用 envelope encryption key。
- 轮换固定为新版本 → 固定 capability 验证 → 激活 → 观察 → 撤销旧版本；active credential 显式重验通过时保持 active 并原子更新 evidence/verified_at/revision，失败或 unknown 只终结本次 validation run，不降级 active、不覆盖上一份有效 evidence。
- Key 明文不进入数据库普通列、队列 payload、异常、审计、日志或响应重放。
- 新模型由同一个聚合 Service 在服务端推进 Key 固定验证、运行快照、连接测试、公开投影和价格记录；浏览器不得连续调用内部对象 API 拼接流程。所选模型 ID 必须属于本次“获取模型”返回的短 TTL 探测证据，不能由客户端自行伪造。
- 生图模型创建或修改时，服务端必须在数据库事务外对 1K 基线的生图与本会话改图各执行一次固定真实探针；只有两个代表能力均通过才写入 `poc_passed` 证据。1K/2K/4K 是公开计价档，不得为了保存配置重复生成六张探针图；更高档位在真实调用时仍按 adapter 能力契约校验并 fail closed。failed/unknown 均不落库、不进入收费目录，也不得用“模型列表中存在”冒充生图成功。该探针是保存动作的内部校验，不增加 PoC 页面、按钮或管理员参数。
- 图片/视频规格不允许只有“高清”布尔值。图片价格档位固定为 1K|2K|4K 每张；视频价格档位固定为 720p|1080p|4K 每秒。更细的 operation/mode/比例/参考图/输出数由服务端能力契约和报价链路裁决，不要求管理员在模型配置页逐项拼装。

### 5.3 模型管理 API

管理台只暴露统一模型配置 API。Provider channel、credential、model snapshot、PoC、catalog entry、SKU 和 release 是领域 Service 的内部持久化细节，不提供独立页面，也不注册低层 Admin HTTP 路由：

| 方法     | 路径                                              | 权限                                  | 行为                                 |
| -------- | ------------------------------------------------- | ------------------------------------- | ------------------------------------ |
| `GET`    | `/api/v1/admin/model-configurations`              | `models.read`                         | 查询模型配置                         |
| `POST`   | `/api/v1/admin/model-configurations/probe-models` | `models.write + provider_keys.rotate` | 按路径/协议/Key 获取模型下拉列表     |
| `POST`   | `/api/v1/admin/model-configurations`              | `models.write + provider_keys.rotate` | 重新校验并添加为可用模型             |
| `GET`    | `/api/v1/admin/model-configurations/{id}`         | `models.read`                         | 查看配置、测试和启用状态             |
| `PATCH`  | `/api/v1/admin/model-configurations/{id}`         | `models.write + provider_keys.rotate` | 修改协议、地址、Key 或模型           |
| `PUT`    | `/api/v1/admin/model-configurations/{id}/credits` | `pricing.write`                       | 首次保存或修改该模型积分             |
| `DELETE` | `/api/v1/admin/model-configurations/{id}`         | `models.publish`                      | 删除模型并撤下当前积分，历史仍可审计 |

`probe-models` strict body 在创建时为 `{ purpose, protocol_family, base_url, api_key }`；修改既可提交新 `api_key`，也可提交 `configuration_id` 沿用该配置已加密保存的 Key，二者都不得缺失。Key 不回传浏览器，不进入 URL/队列/日志/审计；响应为 `{ probe_token, expires_at, models:[{ id, label }] }`。`probe_token` 绑定管理员、用途、协议、规范化地址、Key 密文和模型列表，短 TTL 且只允许创建列表中的一个模型。创建/修改 body 引用 `probe_token + selected_model_id`，修改额外提交列表当前 `expected_revision`；服务端用同一凭据重新获取模型列表并确认所选模型仍存在，成功才写入可用配置，失败不落库。Brain 保存只建立 Agent 模型配置，不隐式创建审核副模型、不切换 moderation runtime，也不因 `moderation.image` PoC 失败而拒绝模型 CRUD；S12 内容安全 closure 在图片发布与生成链路独立 fail closed。积分 body 对生图固定为 `{ prices:{ '1k','2k','4k' }, expected_revision, reason }`，对视频固定为 `{ prices:{ '720p','1080p','4k' }, expected_revision, reason }`；删除固定为 `{ expected_revision, reason }`。管理页面只输入和展示整数积分，提交时统一规范化为以 `.00` 结尾的 decimal string。所有写操作仍要求 step-up、reason、`Idempotency-Key` 和成功审计。旧的 `/api/v1/admin/providers`、`provider-channels`、`models`、`model-poc-runs`、`moderation-runtime`、`model-catalog`、`billing-skus` 与 `pricing-releases` 管理路径必须返回 404。

OpenAI Brain 创建或修改时，服务端在数据库事务外追加固定内容审核探针，验证 strict 结构化判别、违规文本和图片输入能力；探针 passed 后才在保存事务内派生不可见审核快照并切换文本/图片审核 runtime。探针 failed/unknown 不落库且不得标记可用。管理员不配置审核模型、PoC 或 runtime；Anthropic Brain 只承担 Brain，不自动替代审核能力。修改/删除当前 OpenAI Brain 必须同步切换或清除其审核绑定，不自动选择其他模型。

生图模型创建或修改同样在事务外执行固定真实 Images 探针，覆盖 1K 基线的 `image.generate` 与 `image.edit` 两个代表能力并消费后清零探针图片字节；两个能力全部通过后才在保存事务内写入对应 immutable evidence。探针 Provider 请求使用由本次保存幂等键派生的稳定键，未知结果不由服务端自动重投。

普通用户模型目录继续由 `GET /api/v1/model-catalog?category=brain|image|video` 提供。

公开 catalog 只返回产品化字段、支持操作/规格、公开积分价、`availability: available | unavailable` 和 catalog revision。active pricing release 保持产品快照真相；读取时按当前 entry/model/channel/active credential 状态叠加 availability，异常只返回 unavailable，不暴露具体故障原因。新 turn/quote/submit 必须服务端重验 unavailable 并拒绝，不能信任前端缓存；历史任务继续使用原快照且不得自动换模。禁止返回 provider、内部 model_id、Key/通道、真实 CNY 成本、配额、endpoint 或熔断内部证据。未验证邮箱的受限 Session 与匿名请求均不得读取该目录，返回统一 `AUTH_VERIFICATION_REQUIRED`；验证成功后再加载目录，不把受限 Session 当作可选模型上下文。

S14A 本轮只验收 `brain/image/video` 的建档与用户目录。S12 的 `moderation.text`/`moderation.image` 由独立安全控制面管理；审核模型不得作为 Brain 配置的隐式副对象，不得进入 `model_catalog_entries`、积分 SKU 或用户选择器，具体 strict schema、固定 PoC 和 runtime fail-closed 由 `05`、`06` 与 S12 裁决。该后续扩展不反向扩大 S14A 的模型 CRUD 验收范围。

### 5.4 私有对象存储配置

S14A 本轮先完成 local/test 的私有存储控制面和本地生图开发闭环；管理端只能选择 `packages/storage` 编译期 registry 中已实现的 adapter、endpoint profile、region 和 bucket schema，不能提交任意 endpoint、path-style 开关、header 或对象 key 模板。staging/beta/production 在 S15 交付并验收生产 adapter 前必须 fail closed，不得退化使用 local adapter，也不得把仅完成通道配置冒充为生产存储可用。

- 首个生产 adapter 固定为腾讯 COS 私有桶，移交 S15 上线门禁交付；后续 S3/OSS adapter 必须先进入编译期 registry 和固定契约测试，再出现在管理台。S15 必须复用本节已冻结的 channel/credential/validation/runtime 契约，不得另建环境变量或第二套存储真相。
- channel 固定 `purpose=private_assets`、region、bucket、规范化 root prefix、服务端加密/签名能力和生命周期策略摘要；不允许公共读 bucket。
- storage credential 使用独立 envelope keyring，只写不读。列表仅返回由 Storage 专属版本化 HMAC keyring 生成的 hint、version、status 和 verified time；该 HMAC keyring 不与 Provider、envelope encryption 或其他摘要域复用。
- 固定验证通过 evaluation v3 在专用 probe prefix 执行 put/head/read/range-read/delete，并把 `s10-private-assets@1` smoke contract version 写入 validation evidence；payload 不含 Key/bucket endpoint/对象内容。active credential 显式重验通过时保持 active 并更新证据，失败或 unknown 保持 active 与旧有效证据。崩溃后按 validation run lease 接管，接管前按精确 run ID 删除该 run 的旧 probe；终态残留 probe 另由按 run ID、固定批量上限的 sweeper 清理，禁止 bucket 全量删除或 prefix 模糊删除。
- 激活 channel 前必须有 passed validation、active credential、私有访问策略，并校验该 run 的 `s10-private-assets@1` smoke evidence；registry capability 声明本身不能替代 smoke 证据。切换 active storage channel 只影响新 upload intent；已有 asset/artifact 继续按其 `storage_channel_id` 读取，禁止因切换而猜测迁移对象。

| 方法   | 路径                                              | 权限                  |
| ------ | ------------------------------------------------- | --------------------- |
| `GET`  | `/api/v1/admin/storage-channels`                  | `storage.read`        |
| `POST` | `/api/v1/admin/storage-channels`                  | `storage_keys.rotate` |
| `GET`  | `/api/v1/admin/storage-channels/{id}`             | `storage.read`        |
| `POST` | `/api/v1/admin/storage-channels/{id}/credentials` | `storage_keys.rotate` |
| `POST` | `/api/v1/admin/storage-credentials/{id}/validate` | `storage_keys.rotate` |
| `GET`  | `/api/v1/admin/storage-validation-runs/{id}`      | `storage.read`        |
| `POST` | `/api/v1/admin/storage-credentials/{id}/activate` | `storage_keys.rotate` |
| `POST` | `/api/v1/admin/storage-credentials/{id}/revoke`   | `storage_keys.rotate` |
| `POST` | `/api/v1/admin/storage-channels/{id}/activate`    | `storage_keys.rotate` |
| `POST` | `/api/v1/admin/storage-channels/{id}/disable`     | `storage_keys.rotate` |

## 6. 积分配置与运行期价格快照

### 6.1 两层价格

- `models.pricing_json`：Provider 计费单位与可选真实成本快照。没有 Provider 账单或真实 rate card 时，成本必须显式保持 `unknown/null`，不得写入估算常量或用 `0` 冒充真实成本。
- billable SKU：用户积分售价，是 run quote 的唯一公开价格来源；不能由前端或 Skill 推导。

用户侧名称固定为“积分”，API currency 固定为 `credits`。赠送积分、会员权益和活动补贴不改基础 SKU，只通过 ledger grant/权益规则表达。

管理台只填写公开积分单价，不显示 Provider 成本、SKU 或 release。公开积分是用户报价、冻结和结算的唯一金额真相；服务端按模型、操作、分辨率和数量固定对应 SKU 版本。Provider 成本仅在存在真实账单或真实 rate card 时记录为独立内部观测值，不能由浏览器提交或覆盖，不能替代公开积分结算。当前未接入真实成本时允许保存积分，但成本必须保持 `unknown/null`。

公开积分由管理员按产品策略配置并承担运营责任。真实 Provider 成本接入后可以提供内部毛利告警，但不得自动改写已发布积分，也不得把未知成本伪造成固定估算值。

### 6.2 规格矩阵

| 类别 | 结构化维度                                                            | 单位                               |
| ---- | --------------------------------------------------------------------- | ---------------------------------- |
| 推理 | context tier、included/metered、request/token 档位                    | included/request/token             |
| 图片 | operation、mode、1K/2K/4K、比例、张数、参考图档位、透明背景、输出格式 | credits/image                      |
| 视频 | operation、mode、720p/1080p/4K、比例、duration、fps、audio、输出数    | credits/second 或 credits/segment  |
| 放大 | input/output resolution、scale factor 或 megapixel band               | credits/image 或 credits/megapixel |

每个 SKU 只允许 strict 结构化 matcher，不允许任意表达式/脚本。参考图档位按 capability 的最大参考图数固定派生为 `none=0`、`standard=1..4`、`extended=5..16`。图片张数固定从 1 开始、步长 1、上限等于 spec `max_outputs`；视频每秒价的最短秒数、最大秒数和步长必须与 capability duration 和 Provider rate card 完全一致。Provider 只有固定 4 秒/5 秒档时使用与 capability/rate card 一致的离散 segment SKU，不伪装成连续每秒价；megapixel band/step 同样必须与 rate card 一致。创建、批准和 release publish 复用同一服务端纯校验规则。

1K/2K/4K 是图片产品规格，不直接拼成 Provider 请求。每个规格先解析到 model snapshot 中由 adapter registry 认可的 `spec_key` 和精确 Provider 参数，再解析到唯一 Provider rate card 与 billable SKU。切换分辨率、模式、张数、秒数、fps 或音频时，前端必须使用服务端 catalog/quote，不能在浏览器写价目公式。

标准扣点公式使用 `packages/shared` Decimal 与两位 `ROUND_HALF_UP`：

```text
图片积分 = credits_per_image * output_quantity
视频积分（每秒） = credits_per_second * duration_seconds * output_quantity
视频积分（固定段） = credits_per_segment * segment_count * output_quantity
任务预估积分 = 所有收费 task line items 求和
```

duration/quantity 必须落在 SKU 的 min/max/step 内。图片任务成功按可交付输出和已确认 quote 的 settlement 契约结算；Provider 失败、unknown、部分成功和退款如何处理由 S04 资金状态机裁决，运营不能在 SKU 上配置“失败也扣款”绕过账本规则。Brain 在 S14/S11 内测首版只发布 `included`，不向用户单列 token 扣费；`included` 由 Brain catalog entry 本身表达，不创建 `billable_skus` 行。pricing release 可同时包含无 SKU 的 Brain entry 与具有完整 SKU 覆盖的图片 entry，公开 Brain `pricing_summary=[]` 表示已包含，不能解释为成本为零。

### 6.3 价格发布

- 积分配置只校验档位完整性、整数范围和版本并发；真实 Provider 成本可用时另做内部毛利告警，成本未知不阻止积分配置。
- 发布生成完整 pricing catalog closure 和 digest，原子切换 active revision；一个可选模型的每个公开规格必须有且只有一个有效 SKU。
- 同类别最多一个默认用户模型；默认切换与 catalog revision 同事务。
- 价格变更创建新 version；旧 quote/reservation/task/ledger 继续使用旧 snapshot，不追溯修改。
- 停用模型立即阻止新 turn/quote，历史任务继续按原快照审计。若 Provider 已 accepted/outcome_unknown，停用不得导致自动重投其他模型。
- 删除或停用模型使目录回到历史上出现过的相同内容时，仍生成新的 release_no/release ID，并保留相同的内容 digest；历史发布记录和当前发布指针不可合并或覆盖。
- 积分保存前服务端必须检查档位完整性、重复 matcher、单位、整数金额和版本并发；不能信任前端预览。Provider 成本字段不属于该请求。
- quote/task 必须固定 `catalog_revision/model_catalog_entry_id+version/model_snapshot_id/provider_rate_card_key/billing_sku_id+version/matcher/unit_rule/credits_per_unit/quantity_or_duration/estimated_total_credits`。后台调价或换模不能追改历史快照。

唯一管理入口是 5.3 的 `PUT /api/v1/admin/model-configurations/{id}/credits`。服务端在该操作内生成新的 SKU/release 快照并原子切换当前目录；这些内部记录没有独立 CRUD 路由。

## 7. 邀请码与内测运营

S14A 的管理员只需要在一个“邀请码”入口输入生成数量和有效时间，点击生成后立即在当前列表看到本批明文并复制。有效时间留空表示长期有效。列表展示邀请码的脱敏标识、状态（未使用/已使用/禁用/已过期）、使用次数和有效期；新生成且仍可使用的邀请码允许管理员从列表直接复制，不要求生成后立即发出。

发行规则、活动选择、邮件限制、奖励绑定、内部备注、单独的明文查看页面和批次运营不进入产品。历史活动/批次表只为已提交 migration 与旧数据兼容保留，不参与新邀请码运行时，也不保留对应 Controller、Service 或页面代码；按行复制所需的受控 reveal API 除外。

- 首版生成请求只接受 `count` 和可选 `expires_at`；新码固定单码一次使用，服务端直接写邀请码摘要并审计。
- 明文由服务端 CSPRNG 生成；注册校验只使用独立 HMAC digest。邀请码明文还必须使用邀请码专用 envelope keyring 加密保存，密文、nonce、auth tag 和 key ID 四列同时写入；不得复用 Provider、Storage、Admin TOTP 或 HMAC 密钥域。
- 首次生成响应设置 `no-store`；幂等重放不得再次返回明文。列表接口只返回脱敏前缀、状态和 `can_copy`，不得批量返回明文或密文。
- 页面支持逐个复制和本次生成全部复制。当前响应中的明文只保存在页面内存并与列表行合并；刷新或离开后，管理员点击列表行“复制”时才调用受控 reveal 接口获取该行明文并立即写入剪贴板，不增加确认弹窗。
- reveal 只允许 `invites.write` 且完成 step-up 的管理员读取未使用、未禁用、未过期、没有 active registration claim 且密文完整的邀请码；响应 `Cache-Control: no-store`，每次读取写审计但审计、日志和埋点不得记录明文。历史无密文邀请码显示为不可复制，只能停用后重新生成。
- 明文不得写 localStorage/sessionStorage、URL、埋点、错误日志或自动下载文件；前端不得缓存 reveal 响应。
- 列表返回 prefix、状态、使用次数、有效期和创建时间，不返回明文/digest，也不提供详情接口。
- 停用是终态，不能重新启用；verified/redemption/ledger 不删除。容量/有效期调整和完整转化统计归 S14B。
- 生成、单个停用和批量停用要求权限、幂等、独立限流和成功审计；停用只接受未使用且未过期的邀请码。批量发行上限由 typed config 与数据库行锁共同校验，不能并发超发或由请求绕过。

API：

| 方法       | 路径                                  | 行为                     |
| ---------- | ------------------------------------- | ------------------------ |
| `GET/POST` | `/api/v1/admin/invites`               | code 列表 / 按数量生成   |
| `POST`     | `/api/v1/admin/invites/{id}/reveal`   | 受控读取并复制单个可用码 |
| `POST`     | `/api/v1/admin/invites/{id}/disable`  | 终局停用                 |
| `POST`     | `/api/v1/admin/invites/disable-batch` | 批量终局停用未使用邀请码 |
| `GET/PUT`  | `/api/v1/admin/registration-reward`   | 查询 / 修改注册送积分    |

“注册送积分”与邀请码位于同一页，只展示启用开关和赠送积分。金额必须是大于零的两位 decimal string。底层可使用版本化 `reward_campaigns` 保存历史裁决，但活动 key、预算、版本、窗口和激活过程不是产品概念，不提供 `/reward-campaigns` CRUD。验证码通过后，正式用户创建、邀请码核销和赠送 ledger 在同一事务内完成；未配置或关闭时不赠送。

## 8. 运营与用户中心 API

本节中 `GET /api/v1/model-catalog` 及 S14A 五个页面直接使用的管理 API 属于 S14A；用户中心、用户风险、任务运行、资金/申诉/奖励、Skill、管理员团队和完整审计健康 API 的产品化页面与验收归 S14B。这里保留的 S14B 路由表是跨阶段的唯一 API 契约索引，不表示 S14A 交付了这些页面或运营功能；S14B 必须复用本节已经冻结的路径、payload、错误码、权限和状态语义，任何新增或变更都要同步回写 `06` 并重新复审。已经实现的 API 继续接受权限与回归测试，不构成 S14A 必须补齐对应 UI 的理由。

### 8.1 用户 API

- `GET /api/v1/credits/account`
- `GET /api/v1/credits/ledger`
- `GET /api/v1/model-catalog?category=brain|image|video`
- `GET /api/v1/tasks`
- `GET /api/v1/tasks/{id}`
- `POST /api/v1/appeals`
- `GET /api/v1/appeals`
- `POST /api/v1/auth/logout`

申诉只允许本人消费 ledger，创建时间 72 小时内，每月默认最多 10 次；相同 ledger 只能有一个 active appeal。响应不暴露管理员备注。

`apps/api` 的旧 `ops:create-invite` 仅作为 S03 过渡兼容工具保留：它继续调用同一 InviteCodeService，明文只经交互式 stdin 首次输出，并使用 `bootstrap_cli` actor 审计；S14 管理台邀请码 API 验收后，生产环境不再把该 CLI 作为日常发行入口，local/test 可保留用于夹具和恢复演练。两条路径不得各自实现邀请码规则。

### 8.2 管理 API

| 方法   | 路径                                              | 权限                | 行为                                                                                 |
| ------ | ------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/api/v1/admin/dashboard`                         | `dashboard.read`    | 时间窗内任务、成本、积分、风险、积压和发布摘要                                       |
| `GET`  | `/api/v1/admin/workflow-runs`                     | `tasks.read`        | keyset 列表，支持状态/时间/用户 hash 筛选                                            |
| `GET`  | `/api/v1/admin/workflow-runs/{id}`                | `tasks.read`        | run/task/attempt/费用与脱敏证据层级详情                                              |
| `POST` | `/api/v1/admin/workflow-runs/{id}/cancel`         | `tasks.control`     | 仅取消可证明未投递的工作并原子释放剩余冻结                                           |
| `GET`  | `/api/v1/admin/tasks`                             | `tasks.read`        | task/attempt keyset 列表                                                             |
| `GET`  | `/api/v1/admin/tasks/{id}`                        | `tasks.read`        | 状态、intent、attempt、回执摘要和审计引用                                            |
| `POST` | `/api/v1/admin/tasks/{id}/recover-local-dispatch` | `tasks.control`     | 仅按原 intent/jobId 恢复本地投递，不创建 Provider 重试                               |
| `GET`  | `/api/v1/admin/users`                             | `users.read`        | 脱敏用户与风险摘要                                                                   |
| `GET`  | `/api/v1/admin/users/{id}`                        | `users.read`        | 用户任务、资金、资产、Session 与风险摘要                                             |
| `POST` | `/api/v1/admin/users/{id}/risk-status`            | `risk.manage`       | `expected_revision + target_status + reason` 的 revision CAS，必要时撤销普通 Session |
| `POST` | `/api/v1/admin/users/{id}/sessions/revoke-all`    | `sessions.revoke`   | 撤销该用户全部普通 Session                                                           |
| `GET`  | `/api/v1/admin/credits/reconcile`                 | `credits.reconcile` | ledger replay 与投影差异只读                                                         |
| `POST` | `/api/v1/admin/credits/corrections`               | `credits.correct`   | 只追加 correction ledger                                                             |
| `GET`  | `/api/v1/admin/appeals`                           | `appeals.read`      | 申诉 keyset 队列                                                                     |
| `GET`  | `/api/v1/admin/appeals/{id}`                      | `appeals.read`      | 用户提交、ledger 和脱敏证据                                                          |
| `POST` | `/api/v1/admin/appeals/{id}/decide`               | `appeals.decide`    | 裁决与可选 refund ledger、审计同事务                                                 |
| `GET`  | `/api/v1/admin/audit-logs`                        | `audit.read`        | 脱敏 keyset 审计                                                                     |
| `GET`  | `/api/v1/admin/audit-logs/{id}`                   | `audit.read`        | 单条脱敏 before/after、actor 与 request 证据                                         |
| `GET`  | `/api/v1/admin/health`                            | `health.read`       | DB/Redis/队列/存储/Worker/Provider/readiness 摘要                                    |

任务取消必须锁定 run、reservation 和目标 task，重新确认所有目标 attempt 均未 `accepted/outcome_unknown`，并通过 S04/S05 领域 Service 在同一事务推进状态、释放剩余冻结、写 outbox 和成功审计。任一 attempt 已可能送达时返回稳定冲突并转人工证据视图，不能退款或切换模型。`recover-local-dispatch` 只允许 queue intent 为 `pending` 或过期 `dispatching` lease、Provider attempt 仍可证明 `not_dispatched` 的动作；复用原 intent/job ID、原 queue/job type 和 owner CAS。它须支持 `task.execute` 与独立审核队列的 `moderation.execute`，并核对后者只指向 `moderation.image`；不得创建新 attempt，不得处理 `accepted/polling/outcome_unknown`，也不得绕过 Redis recovery sentinel/readiness。

风险用户使用 `expected_revision + target_status + reason`，冻结/限制通过领域 Service 生效并撤销相关普通 Session。账本对账只读；冲正只经 `packages/credit` 追加 `manual_correction/appeal_refund`，不能 UPDATE/DELETE ledger。申诉裁决与 refund ledger 同事务，重复回执幂等，并发只有一个赢家。

奖励不提供全局布尔开关。每次规则变化创建新的 draft version，配置单次 grant、最大次数、积分预算、窗口和 strict 资格规则；S14 资格规则只接受 `{ require_verified_email:true, require_normal_risk:true, deny_blocked_email:true, one_per_mailbox:true }`，不接受任意脚本或未知条件。激活后规则不可修改，停用为终局。每次 grant 在活动行锁内检查预算，并与 claim、ledger、账户和活动投影同事务；已发 ledger 不回滚。Skill 沿用 `06 §5.5` 的 package validation、approve、release publish/rollback 契约，不建立第二套 installer。

## 9. 审计、幂等与故障行为

- 浏览器管理写接口全部使用 PostgreSQL `admin_idempotency_records`；Redis 不能作为唯一幂等真相。
- 高风险操作的业务变化与成功审计同事务；审计失败则业务回滚。失败/拒绝审计使用独立短事务，不得把 secret 写入错误记录。
- 管理员密码校验、MFA 最终登录、恢复码登录、step-up、退出和会话撤销均写审计；记录服务端 UTC 时间、可信来源 IP 的独立 HMAC、User-Agent 摘要、request ID、结果和稳定错误码，不记录登录标识明文、密码、OTP、原始 IP 或原始 User-Agent。
- permission 或 principal 变化递增 `authz_version`，旧 Session 下一请求立即失效。
- PostgreSQL、Redis、MFA、密钥解密或审计依赖不可用时，登录和写操作 fail closed。
- Provider Key 验证超时为 unknown；模型/价格/Skill 发布冲突返回 409 并要求刷新，不 last-write-wins。
- 常规管理列表、详情、审计与日志禁止完整邮箱、prompt、签名 URL、Key、TOTP、恢复码、邀请码明文/digest、Skill 私有正文、Provider 原始错误和图片二进制。邀请码明文只允许出现在 §7 定义的首次生成响应和受控 reveal 响应中。

## 10. 数据库与迁移

只通过 Drizzle schema 生成前向 migration，不手写删除/重建 SQL，不修改历史 migration。S14 新增：

- `admin_principals/admin_credentials/admin_enrollment_tokens/admin_auth_challenges/admin_sessions/admin_role_bindings/admin_mfa_recovery_codes/admin_idempotency_records`
- `provider_channels/provider_credential_versions/provider_credential_validation_runs`
- `storage_channels/storage_credential_versions/storage_validation_runs/storage_runtime_state`，并为新 asset/artifact/upload intent 固定 `storage_channel_id`
- `models.provider_channel_id` 与 media v2 capability/rate-card strict snapshot；不修改历史 model row
- `provider_credential_validation_runs/model_poc_runs` 与 evaluation queue v3 的可靠 intent/恢复路径
- `model_catalog_entries` 的稳定 public slug 版本字段
- `billable_skus/pricing_catalog_releases/pricing_catalog_state`
- `invite_campaigns/invite_code_batches/reward_campaigns`，以及 `invite_codes/registration_reward_claims` 的向前兼容关联/revision 字段
- appeals 的 admin reviewer FK/revision/idempotency 补充
- `admin_audit_logs.actor_admin_id/admin_session_id` FK 与 Admin API actor 约束

字段、索引和不可变约束由 `05` 正文裁决；实现前必须先完成 `05/06` 对应回写并复审。

原 S14 已生成的前向迁移不拆改、不回滚。S14A 只激活管理员身份、Provider/Storage、模型、catalog、SKU/pricing 和邀请码所需表；其余表作为 S14B 的前向兼容结构存在，不得仅因表已创建就宣称对应运营功能已交付。

## 11. 测试标准

### 11.1 Admin Auth 与隔离

- 普通 user cookie、`users.role`、伪造 Host/XFF/admin header、直调 API 均不能建立 Admin Session 或访问管理资源。
- 密码成功但无 MFA、challenge 重放、TOTP 重放/漂移窗、恢复码并发消费、step-up 过期、CSRF/Origin/Host 错误全部拒绝。
- identifier HMAC key 轮换后旧管理员仍可完成登录并在 MFA 成功后重键；候选 hash 冲突、退役 key 尚有 active principal 时 fail closed。
- 管理员停用、permission/authz version 变化、Session revoke 后旧 Cookie 立即失效。
- 首个管理员 CLI 无参数明文、无默认密码、无非交互输出；数据库和日志无密码/TOTP/恢复码明文。

### 11.2 模型与积分

- Brain/生图/视频支持配置多个模型；视频在 S16 前只保存配置与积分，不进入用户可执行目录。
- media v1 历史快照仍可读；S14A 新 catalog 图片模型必须使用 media v2，capability spec/rate card/SKU 三者缺失、重复或单位不一致均不可发布。
- 固定 PoC 夹具覆盖待发布 spec；passed 才可审批，failed/unknown 不可用，accepted 后崩溃或 timeout 收敛 unknown 且不重投；S16 前 video PoC Producer fail closed。
- 1K/2K/4K 图片每张价和 720p/1080p/4K 视频每秒价覆盖首次保存、修改、格式校验、模型删除联动；Decimal 实测 image quantity、duration 和多 task 求和。
- 并发发布单赢家；回滚创建新 release；旧 quote 保留旧积分价格。成本未知不得写成 `0` 或任意正数，真实成本告警不改变历史 quote。
- Key 写后不可读；validation run 的 queued/running lease、崩溃接管、passed/failed/unknown 和原 jobId 恢复有真实集成测试，timeout/unknown 不自动重跑且不切 active；channel/credential 激活、轮换/撤销并发 CAS；日志/审计/队列无明文。
- storage Key 写后不可读；local/test 固定 put/head/range-read/delete probe、unknown、残留 probe 清理、channel 切换和历史 asset 仍按原 channel 读取有真实集成测试；任意 endpoint、local adapter 进入非 local/test 均 fail closed。腾讯 COS 私有桶策略、真实 SDK probe 与生产历史对象读取归 S15 验收。
- 用户 catalog 不泄露 provider/model_id/成本/配额/Key，并按 capability/rollout 过滤。

### 11.3 邀请码

- 状态查询、批次发行上限、首次创建响应返回明文、幂等重放不返明文、刷新后按行受控复制、历史无密文不可恢复、并发不超发、停用终态和使用摘要。
- 邀请码创建/reveal/单个停用/批量停用覆盖权限、step-up、幂等、审计失败回滚和真并发边界；旧 campaign/adjust 路径固定返回 404。
- 奖励活动、申诉/风险/账本冲正和 Skill 发布测试归 S14B，不阻塞 S14A。

### 11.4 前端与 E2E

- 组件栈 spike 必须在 development 与 production build 下无 hydration mismatch、重复样式、首屏闪烁和 Tailwind/antd reset 冲突；React Strict Mode 下请求和副作用不得重复执行高风险动作。
- cursor data-source adapter 组件测试覆盖首屏、上一页/下一页、筛选后重置、错误重试、重复 cursor、空页和 409 刷新；请求不得发送 offset/current/pageSize，页面不得展示伪造 total 或允许跳到未知页。
- Form/ProForm 测试覆盖 Zod 边界失败、服务端字段错误、409 revision 冲突、step-up 过期和幂等重放；不得同时维护 React Hook Form 与 antd Form 状态。
- Playwright 真实 Admin API：本地一键登录或正式密码 + TOTP → 单一模型配置表单用地址/协议/Key 获取模型下拉列表 → 添加、修改、配置/修改积分、删除 → 刷新恢复 Session；另验私有对象存储配置。
- S14A 权限角色覆盖三个页面的 403；普通 host admin 路径 404；退出和 revoke 后页面不再显示敏感数据。管理员受邀开通、角色变更和最后 super_admin 管理 UI 的完整 E2E 归 S14B。
- 桌面 1440/1024 与移动 390 截图检查无溢出；移动端支持查询和紧急熔断，不提供难以安全确认的批量发布。
- E2E 使用隔离 test DB/Redis/object root，按 run ID 精确清理；禁止删库、重建库、FLUSHALL/FLUSHDB。

## 12. 验收清单

- [ ] `apps/admin` 独立构建、部署、Cookie、Host 和 Session；`apps/web/admin` 已删除。
- [ ] antd/ProComponents 兼容性 spike 通过并锁定精确版本；无 Umi/Max/react-router，App Router registry、Tailwind layer 和共享 keyset cursor adapter 已落地。
- [ ] 管理员密码 + TOTP 登录、恢复码、step-up、退出和本人 Session 撤销闭环。
- [ ] 邀请码、模型配置、私有对象存储 3 个入口使用真实 API；模型配置不暴露服务通道、适配器注册表、快照、目录或独立定价菜单，无 S14B 空菜单、mock 或万能操作入口。
- [ ] Brain/生图/视频可配置多个模型；生图配置积分后进入用户 catalog，视频在 S16 前不进入可执行目录。
- [ ] 路径/协议/Key 真实获取模型下拉列表，选择模型后一次添加为可用配置；Key 不回显，校验失败不创建，视频在 S16 前 fail closed。
- [ ] local/test 私有对象存储 channel/Key/固定验证/激活闭环；新旧本地 channel 并存时历史 asset 可读，新上传只用 active channel，无 secret 泄漏；非 local/test fail closed。腾讯 COS 生产 adapter 与真实桶 smoke 归 S15。
- [ ] 模型列表行可首次保存和修改积分：生图 1K/2K/4K 每张、视频 720p/1080p/4K 每秒；Brain 不显示积分入口，删除模型同步撤下积分。
- [ ] 邀请码单入口按数量/有效时间生成、当前列表直接复制、状态与使用摘要、终局停用和审计闭环。
- [ ] 用户从公开 catalog 只能看到产品名称、能力、规格与积分，不泄露 Provider、内部 model ID、成本、Key 或配额。
- [ ] S14A 真实浏览器闭环证明配置可被 S11/S12 消费；S14B 模块不计入本次验收。
- [ ] 正向与反向集成测试、真实 Playwright、全仓门禁和人工安全检查全部通过。
