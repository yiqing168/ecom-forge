# 06 API、队列与事件契约

### Skill 目录执行元数据（2026-10-08）

Skill catalog 条目可返回 `attachment_roles: [{role,label}]`，角色使用现有附件枚举，标签为中文展示；客户端只按返回值生成选项，不按 slug 维护角色表。未声明角色时不提供 Skill 专用选项，服务端仍独立校验；不增加旧目录或历史任务兼容分支。内置 manifest 的 `catalog_enabled=false` 不返回新建入口，也不删除历史数据。`execution_policy` 是服务端 selection/编译/任务快照字段，不接受用户提交或模型工具参数覆盖，不暴露为授权开关。工具参数不再含 `xieyi_structure` 等单一 Skill 的艺术证明，创作决策由通用 `creative_prompt`、`semantic_summary` 与 `creative_note` 表达。

### 会话设计师锁定 API（2026-10-08，覆盖下方旧版跨 turn 改选规则）

auto 版本接受 `1 | 2 | 3`，新草稿使用 v3；profile 仍只接受 `1 | 2`，新手选使用 v2。原生与省略在锁定比较时等价，但不得改写请求/turn hash。GET session 的 session 对象新增 `creative_direction_snapshot`（结构见 `05`）；客户端恢复以服务端为准，不以缓存或分页末项覆盖。新 turn 请求若模式、ID 或版本与锁定选择不同返回 HTTP 409 `SESSION_CREATIVE_DIRECTION_MISMATCH`，中文提示“本会话设计师已固定，请新建会话更换”，不创建 turn、trace 或队列任务。现有幂等重放优先返回原结果。

稳定 `agent_candidate_plan` 工具增加可选 `creative_direction_profile_id` 六值枚举，不增加工具或理由字段；仅未解析自动 v3 的图片规划要求提供。已固定/原生/手选不得用该字段换方法。选中输入未看图或字段无效，走既有有界修复；一次接受规划与解析快照同事务。GET session 在既有 turn 快照刷新后重新读取，显示自动实际结果，无新 SSE 事件或付费调用。

### 创作方向 API 补充（2026-10-04）

创建 turn 的 `generation_preferences` 增加可选 `creative_direction`（strict 联合）：

- `{ "mode": "native" }`：Skill 原生；省略字段的执行语义相同，但不规范化改写旧请求，保持既有幂等 request hash。
- `{ "mode": "auto", "version": 1 }`：在现有模型调用中选择创作方向，保存自动策略版本。
- `{ "mode": "profile", "profile_id": "visual-metaphor", "version": 1 }`：手选一个版本化档案。

v1/v2 档案 ID 白名单：`human-story`、`visual-metaphor`、`spatial-drama`、`color-expression`、`graphic-order`、`material-experiment`。`auto` 和 `profile` 的 `version` 接受数字 `1 | 2`，新选择默认 `2`，旧请求和恢复保持原版本；不规范化改写客户端明确提交的 v1。未知模式、ID、版本、额外字段（包括自定义人格正文）返回既有参数校验错误。API 的 create/GET turn/GET session 在 `generation_preferences` 中返回保存的选择；同 key 改选择返回既有幂等冲突。该字段不改变队列 payload、收费授权、SKU、Provider 参数或工具 schema。

| 项       | 内容                                                               |
| -------- | ------------------------------------------------------------------ |
| 状态     | v0.10 1A 生成任务排队与无费用卡 API 收口后可复审                   |
| 基准     | PRD v1.12、参考工程 `D:\agent\image` 的 API/Queue/EventOutbox 模式 |
| 完成节点 | 编码前                                                             |
| 裁决范围 | API、SSE、队列 payload、Webhook、错误码、幂等和权限校验            |
| 不裁决   | 数据库索引、页面布局、Provider 成本模型                            |

## 1. 目标

本文定义前端、服务端、Worker、Provider Webhook 和运营后台之间的接口契约。所有写操作必须具备幂等语义，所有事件必须可恢复。

## 2. API 通用规则

- 阶段 0 API 路径统一使用 `/api/v1/` 前缀；文档中未写前缀的路径均视为 `/api/v1` 下的相对路径。
- Breaking Change 必须新开 `/api/v2/` 或通过兼容字段灰度，不得静默改变 `/api/v1/` 语义。
- 所有 API 返回统一结构：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

错误结构：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

- 所有写接口必须带 `Idempotency-Key`，或使用业务 ID 作为幂等键。
- 所有用户数据读取必须按 `user_id` 校验。
- 所有产物引用必须服务端校验访问权和修改权。
- 前端费用展示只来自服务端估算，不在前端自行计算。

### 健康与就绪

- `GET /api/v1/health` 保留阶段 0 兼容入口，返回进程存活和不含连接串/secret 的组件摘要。
- `GET /api/v1/health/live` 只表示进程事件循环可响应；不因依赖暂时不可用而失败。
- `GET /api/v1/health/ready` 供 ingress/发布切流使用；数据库不可用、Redis 不可用或 queue recovery sentinel 缺失时返回 `503`，完成 reconciliation 后恢复 `200`。
- 健康响应只返回稳定 component/status/error_code，不返回 endpoint、CIDR、凭据、队列 payload 或数据库错误原文。

## 3. 用户端 API

### 鉴权、内测与账户

| 方法   | 路径                                      | 说明                                               |
| ------ | ----------------------------------------- | -------------------------------------------------- |
| `POST` | `/api/v1/auth/register`                   | 校验邀请码/白名单，创建待注册 claim 并发送注册 OTP |
| `POST` | `/api/v1/auth/login`                      | 已完成注册用户的邮箱密码登录                       |
| `POST` | `/api/v1/auth/logout`                     | 撤销当前普通 Session 并清 Cookie；重复调用幂等     |
| `POST` | `/api/v1/auth/email-verification/request` | 使用有效 verification ticket 重发注册 OTP          |
| `POST` | `/api/v1/auth/verify-email`               | 使用 ticket + 6 位 OTP 原子完成注册并签发 Session  |
| `POST` | `/api/v1/auth/password-reset/request`     | 申请找回 OTP；无论账号是否存在都返回相同泛化 `202` |
| `POST` | `/api/v1/auth/password-reset/confirm`     | 使用邮箱 + reset OTP 设置新密码并撤销旧 session    |
| `GET`  | `/api/v1/me`                              | 当前用户、邮箱验证、风险和奖励补偿摘要             |
| `GET`  | `/api/v1/credits/account`                 | 当前可用、冻结和账户摘要                           |

`POST /api/v1/invites/redeem` 不对 Web 或公开客户端开放。邀请码正式核销只能由注册 OTP 通过后的服务端完成事务幂等执行；禁止“前端先 redeem、验证后再核销”的双路径。

#### 注册与 OTP 请求

`POST /api/v1/auth/register` 请求：

```json
{
  "email": "user@example.com",
  "password": "server-validated-password",
  "display_name": "用户昵称",
  "invite_code": "one-time-visible-code",
  "agreement_version": "current-version"
}
```

- 必须带 `Idempotency-Key`，相同 key + 相同 payload 返回同一结果；相同 key + 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。
- 该接口只创建有时限的待注册 claim、OTP 和邮件投递，不创建 `users`、credential account 或 Session。claim 保存规范化邮箱、昵称、Better Auth 密码哈希和协议版本；不得保存明文密码。
- `agreement_version` 必须等于 S15 发布并由 API 当前配置指向的 active 内测法律版本；缺失、过期或页面 digest 不匹配时新注册 fail closed。注册 claim 固定该版本，后续发布不能追改历史同意记录。
- 服务端先规范化邮箱并执行低成本来源限流，再校验邀请码/白名单、容量和邮箱约束。无效、过期、用尽、停用、邮箱不匹配统一返回 `REGISTRATION_NOT_ELIGIBLE`，且不得创建 OTP、用户或邮件投递。
- 成功时返回不透明 `verification_ticket`、脱敏邮箱、OTP 有效期和重发冷却；不得返回 OTP、邀请码内部状态或剩余容量。
- `verification_ticket` 只允许进入 HTTPS 响应体和前端内存/必要的 `sessionStorage`，禁止进入 URL、日志、队列、埋点和 `localStorage`。

`POST /api/v1/auth/email-verification/request` 请求只包含 `verification_ticket`，不接受替换后的 email/invite code。邮件明确 `accepted` 后原子轮换 ticket 并返回新 ticket；旧 ticket 立即失效。同一 `Idempotency-Key` 重放不得再次发信。

#### 邮箱验证

`POST /api/v1/auth/verify-email` 请求：

```json
{
  "verification_ticket": "opaque-ticket",
  "code": "483920"
}
```

- OTP 为 6 位数字、有效期 10 分钟、单码最多错误 5 次；成功后一次性消费。
- 错误未达到 5 次时 ticket 保持有效；第 5 次错误、验证成功、claim 过期或风险封禁时 ticket 立即作废。
- OTP 校验、正式用户与 credential account 创建、`email_verified_at` 置位、邀请码核销、claim 转 `redeemed`、注册赠送 ledger 和余额投影在同一数据库事务完成；任一步失败全部回滚，不允许留下半注册用户或后置补偿任务。
- 验证成功后事务外签发普通 Session。验证码通过前不存在正式用户，因此没有“未验证账号登录”或“邮箱验证后解锁”状态。

#### 登录与找回密码

- `POST /api/v1/auth/login` 只接受邮箱和密码；只允许已完成注册的用户登录，待注册 claim 不是账号且不能建立 Session，风险账户按服务端权限映射限制。
- `POST /api/v1/auth/password-reset/request` 接受 email，始终返回相同结构的 `202` 泛化响应，不泄露账号存在性。只有账号存在、邮箱已验证且通过限流时才创建 OTP 和邮件投递；未验证注册继续使用 registration ticket。
- `POST /api/v1/auth/password-reset/confirm` 接受 `email`、`code` 和 `new_password`；服务端再次确认账号已验证，OTP 必须绑定 `password_reset` purpose，成功后一次性消费并撤销该用户全部旧 session，且不得改变 `email_verified_at`。不得提供“先验证再无 OTP 重置”的第二步接口。
- 注册、重发、验证、找回、重置、登录和退出均执行 Origin/Host、CSRF、可信代理来源识别和多维限流；Redis 控制面不可用时新的认证写操作 fail closed。logout 只撤销当前普通 Session、清 Cookie 并返回 `Cache-Control: no-store`；Session 已失效时仍返回相同成功结果，不影响其他设备 Session。
- 登录、注册完成与 `GET /api/v1/me` 返回同一用户视角 `access` 摘要：`can_create/can_upload/can_charge` 和 `restriction_reason=null|account_restricted`。不得把内部 `risk_status` 枚举直接暴露给前端；风险受限用户的生成、上传和收费能力必须由服务端返回 `false`。

### POST `/api/agent/intent`

用途：预留的轻量意图识别接口，不产生费用。1A 不对外启用，由 `POST /api/agent/turns` 内部执行意图解析；未来启用时必须复用 `02` schema，不能引入第二套分类语义。

入参：

```json
{
  "session_id": "uuid?",
  "message": "string",
  "attachments": [],
  "references": []
}
```

出参：见 `02` 意图 schema。

### 接口实现归属

| 接口                                               | 1A 负责 SPEC     | 说明                                                                       |
| -------------------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `GET /api/v1/skills`                               | S08              | 公开 primary Skill 安全 catalog；缓存只供展示，创建 turn 时重新校验        |
| `POST /api/v1/agent/turns`                         | S08              | 创建 turn、用户消息、trace 和 continuation intent                          |
| `POST /api/v1/agent/turns/{turn_id}/confirm`       | S08              | turn 生命周期和确认卡提交；是否进入付费链路仍由 S09/S04 裁决               |
| `POST /api/v1/agent/turns/{turn_id}/interrupt`     | S08              | 中断尚未提交 workflow 的 Agent 循环                                        |
| `GET /api/v1/agent/turns/{turn_id}`                | S08              | 当前用户可恢复 turn 快照                                                   |
| `GET /api/v1/agent/sessions`                       | S11              | 当前用户会话 keyset 列表与搜索                                             |
| `GET /api/v1/agent/sessions/{session_id}`          | S11              | 会话消息、turn 安全摘要和刷新恢复快照                                      |
| `PATCH /api/v1/agent/sessions/{session_id}`        | S11              | revision CAS 重命名                                                        |
| `POST /api/v1/agent/sessions/{session_id}/archive` | S11              | 用户删除语义；软归档且不静默取消运行或删除证据                             |
| `POST /api/workflow-runs/{run_id}/cancel`          | S04 + S05 + S14B | S04/S05 提供资金与状态事务；S14B 接入用户任务中心并完成反例后开放公网      |
| `POST /api/workflow-runs/{run_id}/retry`           | S04 + S05 + S14B | S04/S05 提供目标 task/新 quote/冻结；S14B 完成明确重试交互和验收后开放公网 |
| `POST /api/agent/intent`                           | 1A 不启用        | 意图解析作为 S08 turn 内部步骤；保留契约但不提供独立公网能力               |

### Agent turn API

turn 与 session 端点都要求已验证用户会话、Origin/Host/CSRF、可信代理限流和 `Cache-Control: no-store`。turn/session/confirmation 不存在、已归档或不属于当前用户统一返回 `RESOURCE_NOT_FOUND`。`GET /api/v1/skills` 可匿名读取，仅返回公开 published primary 的安全元数据，使用 ETag 和短期 public cache，不写 session cookie。

#### Agent session API

- `GET /api/v1/agent/sessions?query=&cursor=&limit=`：只返回当前用户未归档会话，`query` 为 NFKC + trim 后最多 120 字符的标题 contains 搜索；`limit` 默认 20、范围 1-50。按 `(updated_at desc,id desc)` signed keyset 分页，cursor 绑定 user、query、limit schema 和 endpoint。item 只含 `id/title/revision/last_message_preview/last_turn_id?/last_turn_status?/updated_at`；preview 最多 120 字符且只来自 user/assistant message，不返回附件 URL、tool/system message、prompt 或内部状态。
- `GET /api/v1/agent/sessions/{session_id}?cursor=&limit=`：初次返回最新 50 条 user/assistant message 和对应 turn 安全摘要，消息按时间正序展示；`older_cursor` 只加载更早记录并绑定 user/session。响应含 `session{id,title,revision,primary_skill_slug,preset_selections,created_at,updated_at}`、`messages`、`turns`、`active_turn_id?`、`older_cursor`。`primary_skill_slug + preset_selections` 是会话固定的创作方向，只供客户端从当前 catalog 恢复同逻辑身份的最新 Skill/Preset 并显示为锁定状态；turn 摘要复用本节 turn detail 的公开字段，不包含 tool/system message、内部状态或原始 trace。初次快照与当前 active turn 的 `last_event_seq` 在同一 repeatable-read 只读事务取得，客户端先应用快照再订阅 turn SSE。
- `PATCH /api/v1/agent/sessions/{session_id}`：要求 `Idempotency-Key`，strict body `{revision,title}`；title NFKC + trim 后 1-120 字符。Service 使用 `id + user_id + revision + archived_at is null` CAS，成功 revision + 1；落后返回 `SESSION_REVISION_CONFLICT` 并要求刷新，不 last-write-wins。
- `POST /api/v1/agent/sessions/{session_id}/archive`：要求 `Idempotency-Key`，strict body `{revision}`。归档是 UI“删除会话”的唯一实现，只设置 `archived_at/updated_at` 并 revision + 1；存在非终局 turn、未终局 workflow 或待用户确认时返回 `SESSION_ACTIVE`，不得静默 interrupt/cancel、释放资金、删除 message/trace/artifact 或隐藏仍运行任务。归档后普通列表/详情统一 404，内部审计证据保留。
- 两个 session 写端点使用 `05 agent_session_mutations`：同 user + operation + key + 同 canonical route/body 重放首次响应，不同 payload 409。事务先做专属 advisory lock，锁内复查 replay，再执行 session CAS 和写不可变 response；Redis 不参与正确性。

#### GET `/api/v1/skills`

- 可选 query 仅 `domain=creative|commerce`；未知、重复或非法参数返回 400。始终按服务端当前 stage 过滤，客户端不能查询未来阶段、disabled、archived 或 internal Skill。
- 返回 `response_version`、`catalog_version`、`generation_policy={schema_version:2,policy_version}` 和按 `sort_order,id` 稳定排序的 items。`policy_version` 是 Agent 图片张数来源、Skill 默认、平台单 turn 上限和直接积分核对规则的 canonical hash；不返回或维护费用确认阈值，也不允许用户设置当次积分上限。每项只含 `primary_skill_id/slug/version/name/description/domain/category/cover_asset/required_inputs/preset_slots`；cover/preview 必须是发布时登记、权利已核验的公开只读 CDN 资产。
- `preset_slots` 只返回用户可选择的 slot、required/max selections 和安全 option 元数据；不返回 auxiliary dependency、capability、reference、正文、评测、Provider/模型/价格/Key。
- `catalog_version` 是全部返回 item 的 `id + definition_hash + sort_order` canonical hash。缓存不构成授权，turn create 必须重新校验数据库 published row、definition/resource hash、stage 和完整 selection。
- S09 起强 ETag 改用 `response_version = canonical_hash(catalog_version + generation_policy.policy_version)`；不能继续只用 catalog version，否则策略变化会被 304 隐藏。客户端 304 只可复用同一 response version 的 catalog 与 generation policy 整体。

#### POST `/api/v1/agent/turns`

请求头 `Idempotency-Key` 必填。strict body：

```json
{
  "session_id": "uuid?",
  "message": "string",
  "attachments": [
    {
      "binding_id": "uuid",
      "resource_type": "asset | artifact | upload",
      "resource_id": "uuid",
      "resource_version": "string",
      "role": "product | style_reference | composition_reference | identity_anchor | semantic_reference | edit_source | other",
      "position": 0
    }
  ],
  "mention_bindings": [{ "mention_key": "string", "binding_id": "uuid" }],
  "skill_selection": {
    "primary_skill_id": "slug@1.2.3",
    "preset_selections": [{ "slot": "style", "preset_id": "clean-studio@1.0.0" }]
  },
  "model_selection": {
    "catalog_revision": 7,
    "brain": { "catalog_entry_id": "uuid", "version_no": 2 },
    "image": { "catalog_entry_id": "uuid", "version_no": 3 },
    "video": null
  },
  "generation_preferences": {
    "schema_version": 2,
    "output_kind": "image",
    "aspect_ratio": "auto",
    "resolution_tier": "1k"
  }
}
```

- `message` trim 后 1-8000 字符；S10 后才允许空 message + 至少一项有效附件。附件最多 12、mention 最多 24，S10 前二者必须为空，否则 `AGENT_CONTEXT_UNAVAILABLE`。
- `mention_bindings` 非空时，只有被引用的附件进入 turn 绑定快照；上传但未引用的附件不参与本轮生成。没有引用时维持全量附件语义。
- `role` 是用户确认的素材职责，不是模型推断。`identity_anchor | semantic_reference | edit_source` 在 S13A 激活：前两者分别表示人像身份主图和只读语义参考，`edit_source` 只允许绑定当前会话已发布且可修改的直接父产物。客户端不得通过 role 取得额外读写权；Service/Compiler 仍按资源版本、当前用户、当前会话、publication revision 和 R1-R5 重验。切换 primary 时必须重新确认职责，不得沿用旧 Skill 的隐式角色。
- 同一 session 的后续 turn 可以提交空 `attachments`。此时客户端不得补造历史 artifact/asset binding；Worker 从当前用户和 session 的服务端真相解析并在 `context_snapshot` 冻结最新成图、原始源图、稳定序号与 lineage 候选。Brain 从候选池输出结构化 `source_decision`，自主选择 `refine_latest` 的直接父产物或 `restart_original` 的对应源图；选择依据是当前成图是否仍包含完成用户要求所需的视觉证据，不得由客户端、Runtime 关键词或固定路由代判。Compiler 只接受决定、intent、binding 子集与 lineage 自洽且重新鉴权通过的计划，未选择候选不得进入 Provider、报价或产物 lineage。
- 若该 session 尚无已发布产物，Worker 可从最近的历史用户附件恢复同一用户已授权且仍有效的原图候选，冻结在新 turn 的上下文快照；此时没有可选择的成图，不要求 `source_decision`，仍必须由 Brain 明确选择源图 binding 并经 Compiler/服务端重验。不可用的历史图片不得由客户端补造或由服务端静默替换成另一组。
- `skill_selection` 必填且 strict。`primary_skill_id` 必须是用户选择的 published/stage/public primary 精确 `slug@semver`；首个 turn 将 primary slug 与各 slot 的 Preset 逻辑 ID 固定为会话创作方向，后续 turn 任一逻辑身份不一致返回 `SESSION_SKILL_MISMATCH`，开始新的创作方向必须新建会话。同 slug 的内置 Skill/Preset 新版本可用于新 turn，已创建 turn 仍保留原快照。缺失返回 `SKILL_SELECTION_REQUIRED`，非法、停用、非 primary、版本范围/`latest`、跨 Skill Preset 或客户端正文返回 `SKILL_SELECTION_INVALID`。失败发生在创建任何 turn/message/trace/intent/outbox 和模型/网络调用之前。
- `preset_selections` 默认空数组并按 slot 规范化；必须满足 primary definition 的 required/max/option 约束。服务端不补默认、不从 message 猜测、不允许 Agent 替换。完整 selection 进入 canonical request hash，并固化不可变 selection snapshot/hash。
- `model_selection` 在 S11 激活用户模型选择后必填且 strict；S14 完成但 S11 尚未激活期间，staging/beta/production 的真实 Brain/生成 route 继续 fail closed，local/test legacy fake 可显式兼容。`brain` 必填；S11 的 1A 图片路径同时必须提供 `image`，`video` 在 S16 前必须为空。每项只允许 active catalog 的产品 entry ID + 精确 version，catalog revision 必须当前可用；不得提交默认字符串、Provider/model/channel、价格、成本、SKU 或 capability。Service 在首次 Brain 调用前解析 active release、rollout、用户权限和 Skill capability，固定 entry/model snapshot；缺失/漂移返回 `MODEL_SELECTION_REQUIRED|MODEL_SELECTION_INVALID|MODEL_CATALOG_STALE`，保留草稿并要求刷新，不静默选择或替换。
- `generation_preferences` 在 S11 激活后必填且 strict。1A 只接受 `schema_version=2/output_kind=image`；`aspect_ratio` 接受规范化正整数 `W:H` 或字面量 `auto`，分辨率只接受 `1k|2k|4k`，不得携带 `output_count`。固定比例是用户硬约束，Brain 不得覆盖；`auto` 表示 Brain 必须从所选模型当前规格支持的比例中为每个图片 candidate 节点选择一个具体比例，不同节点可以不同。Compiler 必须拒绝缺失、冲突或模型不支持的节点比例，并把解析后的具体比例冻结到 task；Provider 永远不得收到 `auto`。图片张数由 Brain 从用户原话解析并写入 strict candidate params；未明确时使用 primary Skill 的版本化默认值。Service/Compiler 必须重验 candidate 数量、模型 `max_outputs`、Skill 规则和平台单 turn 上限；不支持返回 `GENERATION_PREFERENCES_INVALID|OUTPUT_COUNT_INVALID`，且发生在图片 Provider 调用前。该偏好对象进入 create request hash、turn 不可变 snapshot 和 Brain context；它不是 Provider 参数、SKU 或最终报价。
- 公网 request 不接受 `execution_authorization`、费用模式、金额或当次积分上限。API 根据本次已鉴权、幂等的生成动作派生并持久化 strict `execution_authorization={schema_version:2,kind:'generate_action',create_request_hash,policy_version}` 及 canonical digest；该证据绑定当前 turn 的 Skill、模型和 generation preferences snapshot。客户端多传旧 v1 授权字段按 strict body 返回 400，不能由隐藏默认或历史 turn 替用户构造金额上限。
- Service 必须先按 `user + Idempotency-Key` 查询历史 create：同 payload 立即重放旧 `create_response_json`，不同 payload 立即 409；只有 key 未使用时才允许锁定/创建 session。锁内再次查询 key 后，新 turn 才 supersede 旧的未提交 active turn；已提交 workflow 不受影响。重放旧 key 不能误停该 session 后来创建的新 turn。
- `session_id` 指向已归档会话时，创建 turn 必须按用户隔离规则返回 `RESOURCE_NOT_FOUND`，不得通过旧 session 恢复、追加消息或重新激活归档会话；未传 `session_id` 才允许创建新的未归档会话。
- 首次短事务原子写 turn/user message/trace/`agent.continue` intent/`turn.created` outbox/`create_response_json`，事务内禁止任何网络调用。
- 同 user + key + 同 canonical payload 必须逐字段返回 `create_response_json`，即使 turn 后续已推进也不现场重算；同 key 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。

首次响应 `201`：

```json
{
  "ok": true,
  "data": {
    "session_id": "uuid",
    "turn_id": "uuid",
    "user_message_id": "uuid",
    "agent_trace_id": "uuid",
    "skill_selection": {
      "primary_skill_id": "slug@1.2.3",
      "primary_name": "用户可见名称",
      "preset_selections": [
        { "slot": "style", "preset_id": "clean-studio@1.0.0", "name": "干净棚拍" }
      ]
    },
    "model_selection": {
      "catalog_revision": 7,
      "brain": { "catalog_entry_id": "uuid", "version_no": 2, "display_name": "标准推理" },
      "image": { "catalog_entry_id": "uuid", "version_no": 3, "display_name": "高清创作" },
      "video": null
    },
    "generation_preferences": {
      "output_kind": "image",
      "aspect_ratio": "1:1",
      "resolution_tier": "1k"
    },
    "user_status": "thinking",
    "revision": 1,
    "continuation_no": 1,
    "event_scope": "turn:uuid",
    "last_event_seq": 1,
    "execution_authorization": {
      "kind": "generate_action"
    }
  },
  "error": null
}
```

#### POST `/api/v1/agent/turns/{turn_id}/confirm`

请求头 `Idempotency-Key` 必填。strict body：

```json
{
  "confirmation_id": "uuid",
  "confirmation_type": "clarification | product_facts | risk",
  "confirmation_version": 1,
  "answers": {}
}
```

- canonical request hash 必须包含路由 `turn_id` 与 strict body。先按 `user + Idempotency-Key` 查询历史 answered confirmation：同 hash 在任何 turn 当前状态下立即重放旧 response，不同 hash 409；因此把相同 key/body 打到另一 turn 也必须冲突，不能返回旧 turn 的成功响应。只有 key 未使用时才锁定 turn/confirmation，并在锁内复查 key。首次提交再校验当前用户、`waiting_user_confirmation`、pending、未过期、ID/type/version/payload digest；旧/superseded/cancelled 确认不能被新 key 套用。
- S08 只注册 `clarification@v1` handler；product_facts/risk 在其下游 SPEC 注册前返回 `AGENT_CONFIRMATION_NOT_AVAILABLE`。1A Agent 不注册或投影 cost confirmation；本 confirm 路由只处理必要澄清、商品事实和风险，客户端不得伪造 cost confirmation ID 或通过本路由提交资金动作。
- S12 注册 `product_facts@v1` handler。其服务端 `public_payload_json` 固定 `mode=create_product|link_product`、`product_id?`、`expected_latest_fact_set_id?`、`source_asset_id/source_version`、候选事实、必需字段和 payload digest；公网 `answers` 按 mode 判别，create 只接受 `{sku_code?,facts}`，link 只接受 `{facts}`，其中 facts 完全复用 S10 strict v1 schema，`facts.product_name` 是商品身份和新档案名称的唯一真相。资源 ID、版本、mode、product ID 和 expected latest fact ID 均从确认快照读取，不接受客户端覆盖；link 模式不能借确认接口修改 SKU。
- `product_facts@v1` 的 create 模式在一次短事务内创建最小商品、关联 ready 原图、追加首个 fact set 并回答 confirmation；link 模式锁定当前用户 active 商品并按快照中的 expected latest fact ID 追加版本。两者调用同一 S10 Product application service，不发内部 HTTP；锁序固定为 `agent_turn -> agent_turn_confirmation -> product`。任何 ownership/lifecycle/version/CAS 失败整体回滚，不得留下半个商品、事实集或已回答 confirmation。
- 首次成功短事务写 answer/用户确认 message，递增 continuation/revision，内部转 `loading_context`，写新 intent/outbox 和不可变 `response_json`；响应 `202` 只返回公开 `user_status=thinking`，不返回内部状态。
- 同 user + key + 同 payload 永远重放 confirmation `response_json` 且不重复入队；同 key 不同 payload 返回 409。
- `202` 响应字段固定为 `turn_id/user_status=thinking/revision/continuation_no/event_scope/last_event_seq`，使用 §2 的统一包装。

#### POST `/api/v1/agent/turns/{turn_id}/interrupt`

请求头 `Idempotency-Key` 必填；body 固定 `{ "reason": "user_requested" }`。

- canonical request hash 必须包含路由 `turn_id` 与 strict body。先按 `user + Idempotency-Key` 查询历史成功 interrupt：同 hash 在任何 turn 当前状态下立即重放旧 response，不同 hash 409；因此把相同 key/body 打到另一 turn 也必须冲突，不能错误回放旧停止结果。只有 key 未使用时才锁 turn并复查 key。首次处理只允许中断尚未提交 workflow 的非终局 turn，随后递增 revision、清 lease、转 cancelled；pending confirmation 同事务 cancelled，未提交 quote 按自身状态契约 cancelled。
- 已提交 workflow 返回 `TURN_ALREADY_SUBMITTED`，必须走 workflow cancel。旧 Worker 的网络调用不保证物理瞬停，但晚到写因 owner/revision CAS 失败只能 no-op。
- 首次成功同事务写 trace interrupt/trace cancelled、`turn.status_changed`、`turn.interrupted`、`turn.cancelled` 和不可变 `interrupt_response_json`，返回 `202`；公开响应只返回 `user_status=stopped`，不返回内部 `cancelled`。
- 同 key 同 payload重放首次响应；同 key 不同 payload 409。不同 key 请求已终局 turn 返回稳定状态冲突，不覆盖快照。
- `202` 响应字段固定为 `turn_id/user_status=stopped/revision/continuation_no/event_scope/last_event_seq`，使用 §2 的统一包装。

#### GET `/api/v1/agent/turns/{turn_id}`

返回当前用户可恢复快照：`user_status`、opaque revision/continuation、trace ID、创建时 `skill_selection`、产品化 `model_selection`、`generation_preferences` 与 `execution_authorization={kind:'generate_action'}` 安全摘要、Brain 已解析的 `resolved_output_count`、实际加载 auxiliary 的安全 `skill_id/name/load_mode`、quote/workflow ID、预计/实际积分安全摘要、pending clarification/product_facts/risk、持久化 user/assistant messages、`activities[]`、`last_event_seq/created_at/ended_at`。`activities[]` 按首次 event seq 排序，每项严格为 `{activity_id,activity_type,display_summary,status,public_error_code?}`，由该 turn 的 `turn.activity_started/finished` outbox 事件按 `activity_id` 重建最新状态；started/finished 的 type 或 summary 不一致时 fail closed。assistant 成图消息的 artifact attachment 可额外返回 `creative_note`：它必须来自该 artifact 对应生成 task 的 Brain candidate 参数，是不超过 600 字符的用户可见创作摘要，并按 task/artifact 一一绑定；不得由前端生成、跨图复用或包含完整 Provider prompt、内部参数与 chain-of-thought。model selection 只返回 entry ID/version/display name/catalog revision，不返回底层 model/Provider/SKU；generation preferences 只返回用户已提交的比例/分辨率，图片张数来自已通过 Compiler 的 candidate snapshot。1A 不返回 pending cost 分支；不返回 auxiliary allowlist、reference path/hash、tool/system messages、数据库 turn status、原始 trace、内部 tool name/args、完整 prompt、Skill 私有正文或 chain-of-thought；前端不得从 revision/continuation 推断内部阶段。

图片任务 `params_snapshot` 允许保留同一 `creative_note` 作为终态消息元数据，但 Provider prompt builder 和 Provider 请求必须忽略它。

极简拼贴图片任务固定为一次 `image.edit`：Compiler 将每张授权原图作为唯一 `semantic_reference` 逐图冻结，并固定 `aspect_ratio:3:4`、`output_count:1`；Brain 把 Skill 任务知识与当前原图的形体、姿态、空间、删减、专色和文字决定编译为完整 `creative_prompt`。Worker 只添加最短图片角色与平台安全封套，Provider 一次返回完整上下双联成品。task 快照不得携带拼贴 `postprocess` 闭包，应用不得裁切、替换上半图、拼接图层、覆盖 Provider 输出或自动重做；最终 Provider 输出按原 hash 和尺寸直接进入 quarantined、审核、发布与 lineage 链路。

### S10 商品、资产和产物 API

本节端点均位于 `/api/v1`。除只读列表/详情外，写接口要求已验证用户 Session、可信 Origin/CSRF、`Idempotency-Key` 和 `Cache-Control: no-store`。资源不存在、随机 ID 和跨用户访问统一 `RESOURCE_NOT_FOUND`，响应永不返回对象 `storage_key`、本地路径、签名 token、完整 hash、Provider 回执、完整 prompt 或内部审核证据。

列表统一使用 signed keyset cursor：排序 `(created_at desc,id desc)`，`limit` 默认 20、范围 1-100；cursor 绑定用户、端点、筛选 canonical hash 和 schema version。重复/未知 query、非法 cursor、cursor 与筛选不匹配返回 400。

#### 商品

- `GET /products?query=&status=active|archived&cursor=&limit=`：返回 `items/next_cursor`。item 只含 `id/name/sku_code/status/revision/primary_asset_preview?/artifact_count/updated_at`。
- `POST /products` strict body `{name,sku_code?,primary_asset_id?}`。商品名 trim 后 1-120 字；SKU trim + NFKC + 大写后最多 80 字，空串归一 null。相同用户内重复 SKU 返回 `PRODUCT_SKU_CONFLICT`。响应 201 返回商品 DTO。
- `GET /products/{id}`：返回基础字段、latest fact 安全 DTO、素材/作品摘要、workflow 数量和 ledger 消费/冻结两位 decimal 摘要；资金摘要必须来自 Credit 查询，不由前端或 controller 计算。
- `PATCH /products/{id}` strict body `{revision,name?,sku_code?,primary_asset_id?,status?}`；至少一个变更。使用 `id + user_id + revision` CAS，冲突返回 `PRODUCT_REVISION_CONFLICT`。
- `POST /products/{id}/fact-sets` strict body `{expected_latest_fact_set_id:uuid|null,source_asset_id:uuid,facts:{...strict v1}}`。Service 锁商品、校验 source asset、分配 `version_no` 并同事务更新 latest/revision；并发落后返回 `PRODUCT_FACT_VERSION_CONFLICT`。

#### 上传与资产

- `POST /assets/upload-url` strict body `{display_name,declared_mime_type,file_size_bytes,product_id?}`；S18 激活后才扩展可选 `folder_id`。1A 只允许 `image/jpeg|image/png|image/webp`，声明大小为正且不超过 20MB。响应 201：`{upload_id,asset_id,status:'pending',upload:{method,url,headers,expires_at,max_size_bytes}}`。持久化 response 不含 `url/headers`；同 key 同请求在 pending 窗口内为同一对象重新签发短 TTL capability。
- `PUT /assets/uploads/{upload_id}/content` 仅 local/test adapter 开放，认证和 capability token 必填，body 为原始 image bytes，Content-Length 受冻结上限约束。staging/beta/production 路由不存在；云 adapter 使用其受控直传 URL。
- `POST /assets/complete` strict body `{upload_id,asset_id}`。只把 pending upload/asset 原子推进到 completed/processing 并创建 `inspect_metadata` intent，返回 202 `{asset_id,status:'processing'}`；不接受客户端 hash/MIME/尺寸。
- `POST /assets/{id}/retry-processing` body 固定 `{reason:'user_requested'}`。只允许本人 `processing_failed`；revision + 1 并创建新 inspect intent，返回 202。
- `GET /assets?product_id=&folder_id=&status=&kind=&query=&cursor=&limit=`：返回安全 DTO，包含 `id/display_name/product_id/kind/origin/status/processing_error_code?/width?/height?/created_at/preview?`；`folder_id` 筛选随 S18 激活，1A 忽略或按统一参数错误拒绝。`preview` 只是 `{variant:'thumbnail'}` 标记，不含 URL；应用内预览由客户端按下方 `GET /assets/{id}/content` 的固定路径构造会话鉴权地址，**无需另行换 capability**（capability 只用于脱离会话的下载/分享）。
- `POST /assets/{id}/access-url` strict body `{variant:'original'|'thumbnail',purpose:'preview'|'download'}`。仅本人 ready asset；返回短期 `{url,expires_at}`，`Cache-Control:no-store`。download 同事务外无网络、事务内追加安全 activity；签名 URL 不进入 activity。
- `GET /assets/{id}/content` 媒体字节端点，提供两条通路：① 带 `capability`（由 `access-url` 签发）走既有 capability 校验，用于脱离会话的下载/分享，行为不变；② 不带 `capability` 但存在有效会话时复用会话身份鉴权，仍强制校验资源归属（`asset_id`+`user_id`）与 `status==='ready'`，用于应用内预览（同源 `<img>` 自动携带会话 Cookie，无需逐张签发）。两条通路均先完成鉴权与归属校验再返回字节。所有 `/content` 响应均为 `Cache-Control: private, no-cache` 并带 `Vary: Cookie`（不落入共享缓存、每次回源用 `If-None-Match` 重校验；取字节路径预算 1200/分钟，远高于逐张签发签名 URL 的 120/分钟，应用内 175 张量级不会触发 429），并携带基于既有 `content_hash` 的 `ETag`；请求头带匹配的 `If-None-Match` 时返回 `304` 且无 body。`purpose=download` 时：capability 通路在 `access-url` 签发时记 download 安全 activity；**会话通路在成功交付字节时记**（`304` 不记，避免重复计数），保证两条通路的下载审计对齐。ETag 不回退到对象 key（不向响应头泄漏内部存储路径）。
- `DELETE /assets/{id}` strict body `{reason:'user_requested',expected_revision}`。只允许本人、已验证 Session 和幂等键；若存在非终局 turn/workflow attachment 引用返回 `ASSET_IN_USE`，不得破坏运行中输入。成功时由领域 Service 在短事务内 CAS 为 `deleted`、关闭新 capability/binding 并写用户安全审计；S15 cleanup Worker 负责到期物理删除，HTTP 请求不触碰对象存储。

#### 资产文件夹（S18 激活，1A 不开放）

- `GET /asset-folders?parent_folder_id=&query=&cursor=&limit=`：只返回当前用户文件夹安全 DTO。
- `POST /asset-folders`、`PATCH /asset-folders/{id}`、`DELETE /asset-folders/{id}` 和 `POST /asset-folders/{id}/move`：写操作要求 `expected_revision`、`Idempotency-Key` 和用户边界；同一父级名称唯一，禁止跨用户、循环移动和级联删除资产。
- 文件夹删除必须由请求显式选择迁移到另一个本人文件夹或保留为未归类；非空且未选择策略时返回稳定冲突。S18 前端未激活前不得发送 `folder_id`、显示文件夹入口或把已有 schema 当作已交付能力。

#### 产物

- `GET /artifacts?product_id=&sku_code=&type=&origin_domain=&producer_mode=&cursor=&limit=`：只返回本人结果。正常 item 含 `id/product_id/type/origin_domain/producer_mode/source_action/visibility/created_at/preview?`；quarantined/deleted 只含 ID、状态、时间和安全占位，不含 preview/meta/params。`preview` 只是 `{variant:'thumbnail'}` 标记，不含 URL；应用内预览按下方 `GET /artifacts/{id}/content` 的固定路径构造会话鉴权地址，**无需另行换 capability**（capability 只用于脱离会话的下载/分享）。
- `POST /artifacts/{id}/access-url` strict body `{variant:'original'|'thumbnail',purpose:'preview'|'download'}`。仅本人且 visibility 为 `private|shared|public`；quarantined 返回 `ARTIFACT_QUARANTINED`，deleted/无权统一 404。
- `GET /artifacts/{id}/content` 媒体字节端点，提供两条通路：① 带 `capability`（由 `access-url` 签发）走既有 capability 校验，用于脱离会话的下载/分享，行为不变；② 不带 `capability` 但存在有效会话时复用会话身份鉴权，仍强制校验资源归属（`artifact_id`+`user_id`）与 visibility 可读（`private|shared|public`；quarantined 返回 `ARTIFACT_QUARANTINED`，deleted/无权统一 404），用于应用内预览。两条通路均先完成鉴权与归属校验再返回字节。所有资产/作品 `/content` 响应均为 `Cache-Control: private, no-cache`，并设置 `Vary: Cookie`；缓存复用必须重新鉴权。原图 `ETag` 基于 `published_content_hash ?? content_hash`，缩略图则基于实际对象 key 的摘要、处理/发布 revision 和源 hash，防止原图未变时缩略图更新仍误返 `304`；缺少内容 hash 时只可回退到对象 key 的摘要，不暴露原始 key。请求头带匹配的 `If-None-Match` 时返回 `304` 且无 body。`purpose=download` 时：capability 通路在 `access-url` 签发时记 download 安全 activity；**会话通路在成功交付字节时记**（`304` 不记，避免重复计数），保证两条通路的下载审计对齐。
- `POST /artifacts/{id}/save-to-assets` strict body `{product_id?}`；S18 激活后才扩展可选 `folder_id`。锁 artifact 后重校验 ownership/visibility，幂等创建或重放同一未删除 generated asset，响应 201/200 返回 asset DTO。

#### Agent attachment 激活

S10 后 `POST /agent/turns` 允许 trim 后空 message，但此时至少一个 attachment；正式 Web 只发送 `asset|artifact`。Service 在创建 turn 的同一事务内按当前 user/session 读取所有资源，校验客户端 `resource_version` 等于服务端 content hash，构造不可变 attachment snapshot 并写入 user message。`upload` 兼容值只允许归一为当前用户已 ready 的目标 asset；pending/processing 返回 `AGENT_CONTEXT_UNAVAILABLE`。跨用户、删除、隔离、版本漂移统一 `REFERENCE_NOT_AVAILABLE`，不能用差异错误枚举资源。

Compiler build 前按 snapshot 中真实 ID 再读取 ownership/lifecycle/content hash；任何 drift fail closed。asset 的 `mutable` 恒为 false；artifact 只有 `producer_mode=chat + producer_session_id=current session + mutation_owner=chat_session` 才为 true。

### POST `/api/run-quotes`

用途：创建费用报价和服务端编译快照。只参考历史工程的费用估算、TTL 和幂等模式，不迁移旧画布产品形态。

入参：

```json
{
  "source": "chat | canvas | suite",
  "source_id": "uuid?",
  "target_ids": [],
  "skill_id": "string?",
  "canvas_compile_fingerprint": "sha256?"
}
```

S04 当前只开放 `chat | canvas | suite`；`batch` 必须等待 S18 前向 migration、编译和费用契约完成后再扩展，现阶段请求 `batch` 返回统一参数错误。

`source=canvas` 时 `source_id=canvas_id`，并必须携带最近一次服务端编译返回的 `canvas_compile_fingerprint`；`target_ids` 为单节点或整链编译目标。`source=suite` 时 `source_id` 必须指向当前用户可提交的持久化草稿，服务端从数据库快照重新编译，不接受前端临时配置替代。`batch` 等待 S18 前向 migration 和契约回写。服务端报价时重新校验 fingerprint/revision/输入版本或聚合版本，不能直接信任前端 DAG/表单 JSON。无需新增 compile 主表，最终完整执行快照写入既有 `workflow_runs.plan_snapshot`。

出参：

```json
{
  "id": "uuid",
  "status": "quoted",
  "estimated_total_credits": "decimal",
  "has_unknown_price": false,
  "expires_at": "datetime",
  "items": []
}
```

### POST `/api/run-quotes/{quote_id}/submit`

用途：历史兼容接口。新生成入口不由浏览器先创建 quote 再调用本路由确认费用；用户点击来源聚合的生成/运行按钮后，服务端持久化动作证据并由内部 intent 调用同一 Credit application service。

规则：

- 报价过期返回 `RUN_QUOTE_EXPIRED`。
- 新生成 quote 固定 `auto_submit`，内部路径必须匹配来源聚合的动作 digest、plan digest 和 revision/continuation。公网 body 的 `cost_confirmation` 与 `confirmation_required` 仅兼容历史数据，任何新 Web 入口都不得发送或渲染。
- 浏览器不能取得内部 submission evidence、直接提交 Agent quote 或绕过来源聚合的幂等生成动作。
- 节点或素材正在使用返回 `RESOURCE_BUSY`。
- 用户已有 `queued/running` workflow 不阻断新生成动作；服务端完成余额与风险校验后创建任务并排队。Worker/Provider 的实际并发额度属于内部调度，不作为用户 submit 的并发位错误返回。
- `source=chat` 且 quote 关联 Agent turn 时，本 S04 事务锁序固定为 `credit_account -> agent_turn -> run_quote`，并校验 user、quote、plan digest、授权 digest 和当前状态；普通 quote 保持 `credit_account -> run_quote`。supersede/interrupt 若涉及 quote 也固定 `agent_turn -> run_quote`，禁止反向锁序。成功时同事务写 `agent_turn.workflow_run_id`、转 `waiting_provider_confirmation` 并追加 turn outbox；不得先冻结后异步关联 turn。
- 各生成入口的内部 submit intent 使用服务端派生幂等键调用同一 Credit application service；授权证据来自来源聚合不可变的生成动作 snapshot/digest，不包含用户设置的金额上限。
- `packages/credit` 共享 application function 接受内部 strict `submission_evidence`；它必须匹配 quote source、submission mode、plan/authorization digest 和当前聚合 revision/continuation，不能由调用方用字符串选择放宽校验。Worker 不得 import API application、发内部 HTTP 或复制资金事务。

### POST `/api/workflow-runs/{run_id}/cancel`

用途：取消尚未终局的运行。

交付边界：S05 只实现状态 guard 和内部 orchestration port；该公网路由必须等 S04 的 Credit 释放/人工处理语义接入后启用，禁止先发布只改 workflow 状态、不处理 reservation 的半成品接口。

规则：

- 未投递 Provider 的任务可取消并释放冻结。
- 已 `accepted` 的 attempt 只能标记 `cancelling`，不承诺 Provider 停止。
- `outcome_unknown` 不允许把原 attempt 当作未投递直接取消或自动重投；用户可明确创建新的收费生成动作，原 attempt 的未结算冻结由 30 分钟定时释放处理。

### POST `/api/workflow-runs/{run_id}/retry`

用途：用户明确重试。

入参：

```json
{
  "task_id": "uuid"
}
```

规则：

- `task_id` 必填；服务端必须验证 task 属于当前用户的 `run_id` 且处于允许明确重试的状态，禁止让客户端用 run 级请求模糊选择失败任务。当前接口是 task 级重试，只接受冻结 `output_count=1` 的 image task；`output_count>1` 的单 task 不得投影成可重试单槽位。
- 结果已确定的图片终局失败可重试。`outcome_unknown` 也可由用户在看到重复结果风险后明确重新生成，但必须新建 quote/reservation/workflow/task，不能在原 task 上追加 attempt；仍处于 `accepted/polling` 且未转 unknown 的任务不显示重试。
- 点击失败槽位的“重新生成”就是本次单图动作授权。服务端复用原 task 中冻结的图片 Prompt、公开 `creative_note`、输入绑定、模型快照、比例、清晰度和操作语义；不调用 Brain、不重新规划、不重跑成功 task，也不把完整 Provider Prompt 返回浏览器。新 task 必须从原 operation key 与被重试 task 派生新的执行 operation key，保证 Provider 收到一次新的、幂等的单图请求，而不是回放旧请求。
- 原 task/attempt/ledger 保持终态不可变。每次允许的明确重试都建立新的单图 `run_quote -> reservation + workflow_run -> task`，只预留该一张图的积分；新 task 以 `parent_task_id` 指向被重试 task，支持连续失败后逐级重试。
- 创建前重新校验用户归属、源 asset/artifact 的不可变版本、当前模型/存储/熔断状态；重复点击按幂等键只返回同一个新 workflow，不得重复冻结或投递。
- 返回新的 `workflow_run_id` 和 `task_id`；新 workflow 由 Worker 直接执行冻结 task 并照常经过输出审核与发布。
- S05 只实现校验与内部 orchestration port；该公网路由必须等 S04 接入上述 reservation/quote 事务后启用。

### GET `/api/workflow-runs/{run_id}`

S05 基础响应返回当前用户的 workflow、task、latest attempt 摘要和 `last_event_seq`；S04 以向后兼容字段增加 `credit_summary`，S10 增加 `artifacts`，不得让 S05 用 mock 金额或产物填充未交付能力。

```json
{
  "workflow_run": {
    "id": "uuid",
    "status": "reserved | queued | running | succeeded | failed | cancelling | cancelled | refunding | refunded | disputed",
    "trigger_mode": "chat | canvas | suite",
    "created_at": "datetime",
    "finished_at": "datetime?"
  },
  "tasks": [
    {
      "id": "uuid",
      "type": "string",
      "status": "pending | queued | running | succeeded | failed | cancelled | blocked | waiting_manual_review",
      "error_code": "string?",
      "retryable": true,
      "latest_retry": {
        "workflow_run_id": "uuid",
        "task_id": "uuid",
        "status": "queued | running | succeeded | failed"
      },
      "output_count": 3,
      "created_at": "datetime",
      "started_at": "datetime?",
      "ended_at": "datetime?",
      "latest_attempt": {
        "id": "uuid",
        "attempt_no": 1,
        "status": "created | dispatching | accepted | polling | succeeded | failed | timeout | outcome_unknown"
      }
    }
  ],
  "last_event_seq": 0,
  "credit_summary": null,
  "artifacts": [
    {
      "id": "uuid",
      "task_id": "uuid",
      "type": "image | video | text | other",
      "visibility": "private | shared | public",
      "publication_revision": 1,
      "output_index": 0,
      "created_at": "datetime"
    }
  ]
}
```

规则：

- `latest_attempt` 在尚未创建 attempt 时为 `null`；不得向用户响应暴露 `dispatch_state`、Provider 原始回执、内部错误摘要或完整计划/参数快照。
- `output_count` 仅对 `image.generate/image.edit` 投影已编译的 1-16 输出数，其他或历史不可解析 task 为 `null`；`output_index` 投影该 artifact 在父生成 task 内的 0-based 稳定槽位，历史不可解析产物为 `null`。两者只用于逐张占位与增量展示，不携带 prompt 或 Provider 参数。
- `last_event_seq=0` 表示尚无 outbox 事件；首个持久化事件的 seq 为 `1`。
- run 不存在或不属于当前用户时统一返回 404，不泄露资源存在性。
- `credit_summary` 在 S04 前固定为 `null`，`artifacts` 在 S10 前固定为空数组；字段语义由所属 SPEC 激活，不得返回 mock 数据。
- S10 后 `artifacts` 只投影当前 workflow 中已经完成发布处理且退出 `quarantined` 的产物；不得返回 storage key、签名 URL、内容 hash、Provider 回执或隔离产物。多输出任务必须随着每个 `artifact.created` 事件刷新快照，使仍在运行或等待人工复核的 workflow 也能展示已成功部分。

### GET `/api/tasks`

用途：用户自己的任务日志页。

查询参数：

```json
{
  "status": "queued | running | succeeded | failed | cancelled | blocked | waiting_manual_review | optional",
  "from": "datetime?",
  "to": "datetime?",
  "source": "chat | canvas | suite | batch | optional",
  "cursor": "opaque?",
  "limit": 20
}
```

规则：

- 自动按当前 `user_id` 过滤。
- 使用 `(workflow_runs.created_at desc, workflow_runs.id desc, tasks.id desc)` 的稳定 cursor 分页；`limit` 默认 20、最大 100，cursor 必须与当前 filter 组合绑定，非法或跨 filter cursor 返回统一参数错误。
- 返回 `{ items, next_cursor }`；S05 的 item 包含 task、workflow_run、latest attempt 和耗时摘要，S04 再增加真实费用摘要。
- 响应不得包含其他用户数据、`dispatch_state`、Provider 原始回执、完整 DAG/参数/prompt 或内部错误摘要。

S05 item 字段固定为：

```json
{
  "task": {
    "id": "uuid",
    "type": "string",
    "status": "task_status",
    "error_code": "string?",
    "created_at": "datetime",
    "started_at": "datetime?",
    "ended_at": "datetime?"
  },
  "workflow_run": {
    "id": "uuid",
    "status": "workflow_run_status",
    "trigger_mode": "chat | canvas | suite",
    "created_at": "datetime",
    "finished_at": "datetime?"
  },
  "latest_attempt": {
    "id": "uuid",
    "attempt_no": 1,
    "status": "task_attempt_status"
  },
  "duration_ms": 1200
}
```

`latest_attempt` 和 `duration_ms` 均可为 `null`；运行中任务的 `duration_ms` 按服务端当前时间计算，未开始任务为 `null`。`source=batch` 在 batch workflow schema 激活前返回空结果，不得映射或伪造为其他 `trigger_mode`。

### GET `/api/tasks/{task_id}`

只返回当前用户拥有的 task；不存在或非本人统一 404。响应复用 workflow detail 的用户视角 task/latest attempt、费用摘要、公开事件和已授权 artifact 摘要，不返回 queue intent、dispatch state、Provider request ID/回执原文、内部错误、成本、DAG 参数或其他用户存在性。内部证据只在独立 Admin API 且通过 permission/scope 后提供脱敏摘要。

### GET `/api/credits/ledger`

积分流水，支持月份、类型、任务过滤。

### POST `/api/appeals`

从消费流水发起申诉。

入参：

```json
{
  "ledger_id": "uuid",
  "reason": "string",
  "screenshot_asset_ids": ["uuid"]
}
```

规则：

- 仅可申诉消费流水或与消费相关的扣费流水。
- 任务完成后 72 小时内可发起。
- 单用户每月上限由运营配置，默认 10 次。
- 服务端校验 ledger 属于当前用户。
- 服务端必须检查是否超过月度上限。
- screenshot asset 必须已 ready、属于当前用户且用途允许作为申诉证据；服务端固定 binding，禁止提交 URL、对象 key 或签名 URL。

### GET `/api/appeals`

返回当前用户自己的 keyset 列表和状态、金额、提交/更新时间及受控证据摘要；不返回管理员内部备注、reviewer 身份、审计记录或其他用户数据。

## 4. 资产和产物 API

| 方法     | 路径                                          | 说明                                           |
| -------- | --------------------------------------------- | ---------------------------------------------- |
| `GET`    | `/api/products`                               | 商品档案列表，支持 SKU/名称筛选                |
| `POST`   | `/api/products`                               | 创建最小商品档案                               |
| `PATCH`  | `/api/products/{product_id}`                  | 更新商品名、SKU、主图                          |
| `GET`    | `/api/products/{product_id}`                  | 商品下素材、产物、任务和成本摘要               |
| `POST`   | `/api/products/{product_id}/fact-sets`        | 创建不可覆盖的商品事实集版本                   |
| `POST`   | `/api/assets/upload-url`                      | 创建上传签名 URL                               |
| `POST`   | `/api/assets/complete`                        | 完成上传并入库                                 |
| `GET`    | `/api/assets`                                 | 当前用户资产列表，支持商品和文件夹筛选         |
| `GET`    | `/api/assets/{asset_id}/file`                 | 服务端鉴权后返回短期访问                       |
| `DELETE` | `/api/assets/{asset_id}`                      | 标记删除                                       |
| `GET`    | `/api/artifacts`                              | 当前用户产物列表，支持商品/SKU 筛选            |
| `GET`    | `/api/artifacts/{artifact_id}`                | 产物详情                                       |
| `POST`   | `/api/artifacts/{artifact_id}/save-to-assets` | 存入资产库                                     |
| `POST`   | `/api/artifacts/{artifact_id}/share`          | 创建分享页                                     |
| `DELETE` | `/api/shares/{share_id}`                      | 撤回分享                                       |
| `POST`   | `/api/shares/{share_id}/reports`              | 举报公开分享；支持匿名受限提交，必须限流和幂等 |
| `GET`    | `/api/membership`                             | 查看当前真实会员权益，不返回未上线购买承诺     |

### 4.1 画布 API（阶段 3a/3b）

| 阶段 | 方法     | 路径                                                       | 说明                                                |
| ---- | -------- | ---------------------------------------------------------- | --------------------------------------------------- |
| 3a   | `GET`    | `/api/canvases`                                            | 当前用户画布列表、搜索和最近编辑                    |
| 3a   | `POST`   | `/api/canvases`                                            | 新建空白/挂载产物画布，必须幂等；模板副本由 3b 开放 |
| 3a   | `GET`    | `/api/canvases/{canvas_id}`                                | 返回图快照、revision 和运行摘要                     |
| 3a   | `PATCH`  | `/api/canvases/{canvas_id}`                                | 重命名等元数据更新                                  |
| 3a   | `POST`   | `/api/canvases/{canvas_id}/copy`                           | 复制并重映射 node/edge ID                           |
| 3a   | `DELETE` | `/api/canvases/{canvas_id}`                                | 软删除；不删除原对话/套图产物                       |
| 3a   | `PUT`    | `/api/canvases/{canvas_id}/graph`                          | 使用 `expected_revision` compare-and-set            |
| 3a   | `POST`   | `/api/canvases/{canvas_id}/mount-artifacts`                | 将授权产物创建为可见素材节点                        |
| 3a   | `GET`    | `/api/canvases/{canvas_id}/nodes/{node_id}/versions`       | 节点版本列表                                        |
| 3a   | `POST`   | `/api/canvases/{canvas_id}/nodes/{node_id}/select-version` | 选择历史版本并递增 revision                         |
| 3a   | `POST`   | `/api/canvases/{canvas_id}/compile`                        | 编译单节点或整链，返回问题和 fingerprint            |
| 3b   | `POST`   | `/api/canvases/{canvas_id}/exports`                        | 创建异步导出                                        |
| 3b   | `POST`   | `/api/canvases/{canvas_id}/template-versions`              | 发布不可变画布模板版本                              |
| 3b   | `POST`   | `/api/templates/{template_id}/instantiate-canvas`          | 从指定模板版本创建当前用户的新画布                  |

保存入参：

```json
{
  "expected_revision": "bigint-string",
  "graph_json": {}
}
```

保存成功返回新 `revision`；不匹配返回 `CANVAS_REVISION_CONFLICT` 和当前 revision，不自动覆盖或在服务端猜测合并。

编译入参/出参：

```json
{
  "scope": "node | workflow",
  "target_node_ids": ["00000000-0000-4000-8000-000000000001"],
  "expected_revision": "bigint-string"
}
```

```json
{
  "canvas_id": "uuid",
  "revision": "bigint-string",
  "fingerprint": "sha256",
  "status": "valid | invalid",
  "issues": [
    {
      "code": "string",
      "node_id": "uuid?",
      "edge_id": "uuid?",
      "message": "用户可理解摘要"
    }
  ]
}
```

规则：

- 所有接口按 `user_id` 隔离；画布、node、edge、artifact 和版本的归属需服务端关联校验。
- 保存和 compile 必须校验 node/edge ID 为规范小写 UUIDv4、图内唯一且所有 source/target/mention 引用可解析；React Flow 的任意字符串 ID 能力不得放宽服务端契约。
- `mount-artifacts` 只接受已授权且非 quarantined/deleted 的 artifact；服务端创建可见节点和稳定边界元数据，不接受前端伪造 producer/mutation owner。
- compile 是只读且幂等的确定性操作，校验 schema、环/悬空边、输入类型/顺序、失效 mention、R1-R5、权限、readiness、模型准入和预算。
- 单节点/整链收费统一复用 `POST /api/run-quotes` 和 submit；不新增第二套画布交易接口。
- 画布导出创建成功返回 `export_id`；状态、失败项重试和下载统一使用 §4.2 的 `/api/exports/{export_id}`、`/retry-failed` 和 `/file`，不维护 canvas 前缀的第二套状态接口。
- 3b export/template 使用持久化 ID 入队，不把完整私有图、签名 URL 或密钥放入 job payload。

### 4.2 1B-2B 扩展 API

后续页面仍遵循 `/api/v1`、用户隔离和统一幂等规则；收费提交复用 `run-quotes -> submit`，不为批量或套图另造交易协议。

| 阶段  | 方法     | 路径                                       | 说明                                                         |
| ----- | -------- | ------------------------------------------ | ------------------------------------------------------------ |
| 1B    | `GET`    | `/api/batches`                             | 当前用户批量列表，按状态/商品/时间筛选                       |
| 1B    | `POST`   | `/api/batches`                             | 创建持久化批量草稿，最多 50 个 SKU，必须幂等                 |
| 1B    | `GET`    | `/api/batches/{batch_id}`                  | 草稿、条目、父 run、行级状态和费用摘要                       |
| 1B    | `PATCH`  | `/api/batches/{batch_id}`                  | 仅 draft/quoted 可改；修改使旧报价失效                       |
| 1B    | `POST`   | `/api/batches/{batch_id}/retry-failed`     | 明确重试失败条目；先按 Provider 三态和费用规则重新编译       |
| 1B    | `POST`   | `/api/batches/{batch_id}/exports`          | 创建打包/CSV `export_job`                                    |
| 1B    | `POST`   | `/api/records/exports`                     | 按服务端筛选快照创建生成记录 CSV 导出                        |
| 1B/3b | `GET`    | `/api/exports/{export_id}`                 | 导出状态、成功/失败清单和过期时间                            |
| 1B/3b | `POST`   | `/api/exports/{export_id}/retry-failed`    | 只重试失败导出项，不重新生成产物                             |
| 1B/3b | `GET`    | `/api/exports/{export_id}/file`            | 完成后重新鉴权并签发短期下载 URL                             |
| 2A    | `GET`    | `/api/public/shares/{share_slug}`          | 匿名受限读取公开成品和有限配方；撤回/隔离立即不可见          |
| 2A    | `GET`    | `/api/templates`                           | 按类型、分类、解锁方式、关键词和收藏筛选不可变模板版本       |
| 2A    | `GET`    | `/api/templates/{template_id}`             | 模板精确版本详情、来源、授权和当前用户权益                   |
| 2A    | `POST`   | `/api/templates/{template_id}/unlock`      | 免费/会员/积分幂等解锁；积分写入只经 Credit                  |
| 2A    | `POST`   | `/api/templates/{template_id}/instantiate` | 配方模板进入新 Agent 会话或 suite 草稿；不适用于 canvas 类型 |
| 2A    | `GET`    | `/api/references`                          | 官方参考图库列表，按分类/媒体/关键词筛选                     |
| 2A    | `GET`    | `/api/references/{reference_id}`           | 参考详情、来源和授权；不返回永久对象 URL                     |
| 2A    | `POST`   | `/api/favorites`                           | 收藏 template/reference，body 使用 `target_type + target_id` |
| 2A    | `DELETE` | `/api/favorites/{target_type}/{target_id}` | 取消收藏；幂等                                               |
| 2B    | `GET`    | `/api/suites`                              | 按商品/SKU、模式、状态和时间查询套图历史                     |
| 2B    | `POST`   | `/api/suites`                              | 创建商品绑定的持久化套图草稿，必须幂等                       |
| 2B    | `GET`    | `/api/suites/{suite_id}`                   | 配置、分组条目、父 run、规范/保真风险和结果                  |
| 2B    | `PATCH`  | `/api/suites/{suite_id}`                   | 仅 draft/quoted 可改；修改使旧报价和编译摘要失效             |
| 2B    | `POST`   | `/api/suites/{suite_id}/retry-failed`      | 明确重试失败条目，禁止 accepted/outcome_unknown 自动重投     |
| 2B    | `POST`   | `/api/suites/{suite_id}/exports`           | 创建套图分组打包/CSV `export_job`                            |

批量和套图提交规则：

- batch/suite 的“开始生成”请求同时固化聚合 revision 与生成动作证据；服务端创建 quote 并通过内部 submit intent 原子创建一个父 `workflow_run` 和一个 reservation，不要求浏览器二次确认。
- batch/suite 的 `PATCH` 必须携带 `expected_revision`；保存成功返回新 revision，冲突返回 `AGGREGATE_REVISION_CONFLICT`，不得 last-write-wins。quote 快照固定该 revision，提交前再次校验。
- `batch_items`/`suite_items` 的用户状态由关联 tasks 聚合，前端不能直接写终态；部分失败不把成功项回滚。
- public share 响应只含已发布白名单字段。每次读取都检查 `revoked_at`、artifact visibility 和内容处置状态；匿名访问按 IP hash 限流。
- 模板实例化固定 `template_id` 精确版本；下架版本禁止新实例化，但已有 run/画布快照仍可审计。
- 导出创建时重新校验所有 artifact 权限并冻结 selection snapshot；下载时再次鉴权。`storage_key`、签名 URL 和失败内部堆栈不进入公共响应。

## 5. 运营 API

S14 只注册本节明确冻结的管理路由。S12 内容安全和 S21 会员路由在所属 SPEC 回写本节前不得注册、返回空数据或用万能操作接口代替；普通 host 对任何 `/api/v1/admin/*` 始终返回 404。所有管理写操作和敏感读取必须记录 `admin_audit_logs`。

模型 `circuit-break/restore` 只操作 S07 的运行时 `provider_circuit_states`，通过 expected revision、step-up 和审计推进 open/half-open/closed；不得把 `models.status=disabled/poc_failed` 直接恢复为可用。model status 的 PoC 准入按 `05/S07` 的受控审批转换执行。

### 5.1 Admin Auth 与 Session API

这些接口只接受 Admin Host/受信管理入口；普通 host 一律 404。所有响应 `Cache-Control: no-store`，Cookie、challenge、CSRF、TOTP、恢复码和 Session token 均禁止进入响应 body 的可持久化字段、URL、日志或审计。

| 方法   | 路径                                           | 未认证要求                    | 说明                                              |
| ------ | ---------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `POST` | `/api/v1/admin/auth/local-session`             | 仅 `APP_ENV=local` + loopback | 创建/复用固定本地管理员并签发正常 Admin Session   |
| `POST` | `/api/v1/admin/auth/login`                     | Admin Host + Origin + 限流    | 密码成功只返回一次短期 MFA challenge              |
| `POST` | `/api/v1/admin/auth/mfa/totp/verify`           | challenge + Origin + 限流     | 一次消费 challenge，签发 Admin Cookie             |
| `POST` | `/api/v1/admin/auth/mfa/recovery/verify`       | challenge + Origin + 限流     | 一次消费恢复码，签发 recovery-restricted Session  |
| `GET`  | `/api/v1/admin/auth/session`                   | Admin Cookie                  | 返回 principal/permission/MFA/step-up/CSRF token  |
| `POST` | `/api/v1/admin/auth/step-up`                   | Session + CSRF + 密码 + TOTP  | 刷新短 TTL，不创建第二身份                        |
| `POST` | `/api/v1/admin/auth/logout`                    | Session + CSRF                | 撤销当前 Session 并清 Cookie                      |
| `POST` | `/api/v1/admin/auth/sessions/revoke-all`       | Session + CSRF + step-up      | 撤销本人其他 Session                              |
| `POST` | `/api/v1/admin/enrollment/start`               | token + Origin + 限流         | claim token、自设密码并返回一次 TOTP provisioning |
| `POST` | `/api/v1/admin/enrollment/activate`            | enrollment challenge + TOTP   | 激活 principal、签发 Session 和一次恢复码         |
| `POST` | `/api/v1/admin/auth/password/change`           | Session + CSRF + step-up      | 改密码并撤销其他 Session                          |
| `POST` | `/api/v1/admin/auth/mfa/totp/rotate/start`     | step-up 或 recovery Session   | 开始 TOTP 重新绑定，一次返回 provisioning         |
| `POST` | `/api/v1/admin/auth/mfa/totp/rotate/confirm`   | rotate challenge + TOTP       | 原子切换 TOTP 并撤销旧恢复码/其他 Session         |
| `POST` | `/api/v1/admin/auth/mfa/recovery-codes/rotate` | Session + CSRF + step-up      | 轮换并一次返回新恢复码                            |

login strict body 为 `{ "identifier": "...", "password": "..." }`。identifier 查询对 active/历史 HMAC keyring 计算候选，响应与日志不回显完整值。失败统一 `ADMIN_AUTH_INVALID` 且使用响应时间地板，不得区分账号不存在/密码错误/账号停用；成功返回 `{ challenge_id, challenge_token, expires_in_seconds, methods:['totp','recovery'] }`，challenge token 只允许通过同一 Admin Origin 提交。TOTP body 为 `{ challenge_id, challenge_token, code }`，同一 time-step/principal 的成功 TOTP 不可重放。只有密码与 MFA 均成功后才允许把 identifier hash revision CAS 重键到 active key；冲突 fail closed，不合并 principal。

`local-session` strict body 为 `{}`，且 Controller 在任何数据库写入前同时证明 `APP_ENV=local`、socket remote address 是 `127.0.0.1|::1|::ffff:127.0.0.1`、Host/Origin 通过既有 Admin guard；否则路由表现为 404。服务端不接受客户端 identifier/role/permission，固定创建或复用 `local-admin@ecom-forge.test` 的 active `super_admin`，签发普通 Admin Cookie 与 CSRF token，Session TTL/idle TTL、Host/Origin/CSRF、权限和审计规则保持不变。响应额外允许 `{ local_login_available:true }` 供本地登录页决定是否显示快捷入口；非 local 环境不得返回该字段。该 Session 的 `step_up_at` 在签发时设为当前服务端时间，避免本地模型配置再次要求 TOTP；线上 step-up 语义不变。

Session body 不返回 Cookie 值，只返回 `{ principal, permissions, scopes, mfa_level, step_up_expires_at, csrf_token, session_expires_at }`。服务端以独立 CSRF derivation key 从本次 Cookie 的原始 Session token + session ID 确定性派生 token，数据库只存 hash/key ID；CSRF token 仅由前端内存保存，页面刷新后通过该接口重新取得。所有管理写接口要求 `X-Admin-CSRF`、严格 Origin/Host 和 `Idempotency-Key`。recovery-restricted Session 只能进入重新绑定 MFA/退出/查看本人安全状态，不能执行其他管理操作。

enrollment start strict body 为 `{ enrollment_token, new_password }`。服务端在 principal/token 行锁内确认 `pending_enrollment + issued token`，将 token 原子转为 claimed，创建 password hash、待确认 TOTP credential 和 `enrollment_mfa` challenge；响应只在本次返回 `{ challenge_id, challenge_token, provisioning_uri, totp_secret, expires_at }`。activate body 为 `{ challenge_id, challenge_token, code }`；成功后同事务激活 password/TOTP/principal、消费 token/challenge、生成 keyed-hash recovery codes、递增 `authz_version` 并写审计，响应一次返回恢复码且签发 Admin Cookie。start 响应丢失或 challenge 过期时不得读取 TOTP secret或恢复 token；只能由另一名有权限管理员执行重新签发/重新开通。

密码或 MFA 轮换都必须使用新 credential row/version，不原地覆盖 secret；切换 active credential、递增 `authz_version`、撤销旧 credential/recovery codes/其他 Session 和成功审计在同一事务。TOTP rotate start 可由近期 step-up 或 recovery-restricted Session 发起；confirm 成功前 restricted Session 不升级权限。

### 5.2 邀请码、用户、资金与审计 API

| 方法   | 路径                                              | 权限                | 说明                                                                                 |
| ------ | ------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/api/v1/admin/invites`                           | `invites.read`      | keyset 查询 prefix、状态、使用次数与有效期                                           |
| `POST` | `/api/v1/admin/invites`                           | `invites.write`     | 按数量生成；完整明文仅首次响应                                                       |
| `POST` | `/api/v1/admin/invites/{id}/disable`              | `invites.write`     | 终局停用单个未使用邀请码                                                             |
| `POST` | `/api/v1/admin/invites/disable-batch`             | `invites.write`     | 原子批量停用未使用邀请码                                                             |
| `GET`  | `/api/v1/admin/registration-reward`               | `invites.read`      | 读取“注册送积分”开关和积分数                                                         |
| `PUT`  | `/api/v1/admin/registration-reward`               | `invites.write`     | 修改“注册送积分”开关和积分数                                                         |
| `GET`  | `/api/v1/admin/users`                             | `users.read`        | 脱敏用户/风险摘要                                                                    |
| `GET`  | `/api/v1/admin/users/{id}`                        | `users.read`        | 用户任务/资金/风险摘要                                                               |
| `POST` | `/api/v1/admin/users/{id}/risk-status`            | `risk.manage`       | `expected_revision + target_status + reason` 的 revision CAS，必要时撤销普通 Session |
| `POST` | `/api/v1/admin/users/{id}/sessions/revoke-all`    | `sessions.revoke`   | 撤销该用户全部普通 Session                                                           |
| `GET`  | `/api/v1/admin/dashboard`                         | `dashboard.read`    | 时间窗任务/成本/积分/风险/积压摘要                                                   |
| `GET`  | `/api/v1/admin/workflow-runs`                     | `tasks.read`        | workflow keyset 列表                                                                 |
| `GET`  | `/api/v1/admin/workflow-runs/{id}`                | `tasks.read`        | run/task/attempt/费用与脱敏证据                                                      |
| `POST` | `/api/v1/admin/workflow-runs/{id}/cancel`         | `tasks.control`     | 仅取消可证明未投递的工作                                                             |
| `GET`  | `/api/v1/admin/tasks`                             | `tasks.read`        | task/attempt keyset 列表                                                             |
| `GET`  | `/api/v1/admin/tasks/{id}`                        | `tasks.read`        | task、intent、attempt 和回执摘要                                                     |
| `POST` | `/api/v1/admin/tasks/{id}/recover-local-dispatch` | `tasks.control`     | 仅恢复原本地 intent/jobId                                                            |
| `GET`  | `/api/v1/admin/appeals`                           | `appeals.read`      | keyset 申诉队列                                                                      |
| `GET`  | `/api/v1/admin/appeals/{id}`                      | `appeals.read`      | ledger 与用户证据的脱敏详情                                                          |
| `POST` | `/api/v1/admin/appeals/{id}/decide`               | `appeals.decide`    | 裁决与 refund ledger/审计同事务                                                      |
| `GET`  | `/api/v1/admin/credits/reconcile`                 | `credits.reconcile` | ledger replay/投影差异只读                                                           |
| `POST` | `/api/v1/admin/credits/corrections`               | `credits.correct`   | 只追加 correction ledger                                                             |
| `GET`  | `/api/v1/admin/audit-logs`                        | `audit.read`        | 脱敏 keyset 审计                                                                     |
| `GET`  | `/api/v1/admin/audit-logs/{id}`                   | `audit.read`        | 单条脱敏 actor/before/after 证据                                                     |
| `GET`  | `/api/v1/admin/health`                            | `health.read`       | 依赖/队列/门禁状态，不返回 secret                                                    |

创建邀请码 strict body：

```json
{
  "count": 3,
  "expires_at": "2026-09-01T00:00:00Z"
}
```

`expires_at` 可省略或为 `null`，表示长期有效。每个新码固定只能使用一次且不绑定邮箱。首次响应返回 `{ count, plaintext_available:true, codes:[{ id,prefix,plaintext_code }] }`；同 idempotency key 重放必须省略明文并返回 `plaintext_available=false`。数据库保存注册校验使用的 HMAC digest/prefix，并使用邀请码专用 envelope keyring 保存可恢复密文；列表只返回 `can_copy`，不得返回明文、密文或 digest。`POST /api/v1/admin/invites/{invite_id}/reveal` strict body 为 `{}`，仅允许 `invites.write` + step-up 对未使用、未禁用、未过期、无 active registration claim 且密文完整的邀请码返回 `{ id,prefix,plaintext_code }`，响应 `no-store` 并写不含明文的读取审计。历史无密文邀请码返回 `INVITE_PLAINTEXT_UNAVAILABLE`。disable body 固定为空对象；批量 body 固定 `{ invite_ids:uuid[] }`，只允许未使用、未过期且没有 active registration claim 的邀请码，批量操作全成或全败。

注册赠送积分更新 body 固定 `{ enabled:boolean, credits:"10.00" }`。产品语义是大于零的整数积分，管理页面只输入和展示整数；API 在提交时规范化为以 `.00` 结尾的 decimal string，以兼容积分账本的统一精度。设置以版本化数据库记录保存，但页面和 API 不暴露活动、预算或版本操作。验证码通过、正式用户创建、邀请码核销和注册送积分在同一注册完成事务内执行，积分只能经 `packages/credit` 发放；关闭或未配置时不赠送，邮箱验证接口不得在事务外补发。

管理取消 body 固定 `{ expected_run_revision, reason }`。Service 必须锁定 run、reservation 和目标 tasks，只有所有目标 Provider attempt 均可证明未离开本机时才允许取消，并在同一事务推进状态、释放剩余冻结、写 outbox 和成功审计；`accepted/polling/outcome_unknown` 返回 409 且不退款、不换模型、不新建 attempt。local dispatch 恢复 body 固定 `{ queue_dispatch_intent_id, expected_intent_revision, reason }`，只接受 pending 或 lease 已过期的 dispatching intent，并以原 jobId、原 queue/job type、owner CAS 和 S05 recovery sentinel 语义恢复；`task.execute` 与 `moderation.execute` 均须核对 task/workflow 归属，后者还须核对 `moderation.image` 类型，禁止用于 Provider submit 重试。

普通用户申诉接口为 `POST/GET /api/v1/appeals`。创建 strict body 为 `{ ledger_id, reason, screenshot_asset_ids[] }`；服务端验证本人 consume ledger、72h 窗口、同 ledger active 唯一和月限额。管理员 decide body 为 `{ expected_revision, decision:'refund|reject', refund_amount, reason }`；refund_amount 不得超过原 consume 可退余额，且资金只经 `packages/credit`。

### 5.3 模型配置 API

S14A 管理台只暴露“模型配置”一个产品概念。管理员按“用途 → 协议 → API 路径 → Key → 获取模型 → 下拉选择 → 保存/启用”完成配置，不得被要求创建或关联 Provider channel、credential、snapshot、catalog entry、SKU 或 release。

| 方法     | 路径                                              | 权限                                  | 行为                             |
| -------- | ------------------------------------------------- | ------------------------------------- | -------------------------------- |
| `GET`    | `/api/v1/admin/model-configurations`              | `models.read`                         | 查询聚合后的模型配置             |
| `POST`   | `/api/v1/admin/model-configurations/probe-models` | `models.write + provider_keys.rotate` | 真实获取模型下拉列表，不落库     |
| `POST`   | `/api/v1/admin/model-configurations`              | `models.write + provider_keys.rotate` | 重新校验并添加为可用模型         |
| `GET`    | `/api/v1/admin/model-configurations/{id}`         | `models.read`                         | 查询单条配置                     |
| `PATCH`  | `/api/v1/admin/model-configurations/{id}`         | 对应写权限                            | 编辑、更新 Key 或启停            |
| `PUT`    | `/api/v1/admin/model-configurations/{id}/credits` | `pricing.write`                       | 保存公开积分并发布新价格快照     |
| `DELETE` | `/api/v1/admin/model-configurations/{id}`         | `models.publish`                      | 从可用列表移除，历史运行仍可审计 |

`probe-models` body 固定为 `{ purpose:'brain'|'image'|'video', protocol_family:'openai'|'anthropic'|'google', base_url, api_key }`；`image/video` 只接受 `openai`。管理员通常提交 relay allowlist 内的 HTTPS origin，例如 `https://relay.example.com`，服务端自动解析为 `/v1` API 根；仅当中转站明确提供路径前缀时才保留该路径。地址不含 userinfo/query/fragment。服务端按规范化根路径追加 `models`，不得产生 `/v1/v1/models`。Google 也以 OpenAI 格式获取模型列表（Bearer、`data[].id`）；其 Brain 推理按 `03` 独立映射 Google 原生根路径，不由列表格式推断推理协议。返回 `{ probe_token, expires_at, models:[{ id, label }] }`，模型数组必须来自本次真实响应并去重、排序、限量；失败、超时、空列表或 schema 异常不签发 token且不写数据库。Key 不进入 URL、日志、审计或队列；短 TTL `probe_token` 以认证密文携带一次创建所需状态，绑定管理员、协议、路径和模型列表，创建只能选择 token 列表中的一个 ID。

创建 body 固定为 `{ probe_token, selected_model_id, reason }`；修改额外要求 `expected_revision`。同一个领域 Service 使用 token 内凭据重新获取模型列表并确认所选模型仍存在，成功后一次写入 Key 密文和模型运行快照；失败不创建半成品。保存 Brain 配置不得隐式要求该模型同时通过 `moderation.text/moderation.image` PoC，不得创建审核副模型或切换 moderation runtime；内容安全模型的验证、激活与运行闭环由 S12 独立裁决，图片发布和生成仍在缺少有效审核 closure 时 fail closed。创建成功后模型成为同页列表数据，图片/视频行显示“积分配置”。`PUT /{id}/credits` 对图片接受 `{ prices:{ '1k', '2k', '4k' }, expected_revision, reason }`，每项表示每张整数积分；对视频接受 `{ prices:{ '720p', '1080p', '4k' }, expected_revision, reason }`，每项表示每秒整数积分；Brain 拒绝该操作。删除同样要求 `expected_revision + reason`。管理页面只输入和展示整数积分，提交时规范化为以 `.00` 结尾的 decimal string，浏览器不参与价格乘法。积分保存成功后由服务端生成公开投影、SKU 和新 pricing release；视频在 S16 前只保存配置，不进入公开 catalog、quote 或运行。响应及后续查询只返回模型配置 ID、用途、协议、脱敏路径主机、模型名、Key hint、积分摘要和启用状态。管理员配置第二个模型时创建第二条独立配置；运行时不得在不同模型配置间自动 fallback。

Provider channel、credential、model snapshot、catalog entry、SKU 和 release 仍是统一领域 Service 的内部持久化与审计模型；图片模型另有固定 PoC evidence。S12 的 moderation runtime 是独立安全控制面，不是每条 Brain 配置的子对象。以上内部对象均不注册独立 Admin HTTP 路由。旧的 `/api/v1/admin/providers`、`provider-channels`、`models`、`model-poc-runs`、`moderation-runtime`、`model-catalog`、`billing-skus` 与 `pricing-releases` 路径必须返回 404；不得用历史兼容名义保留第二套管理入口。

统一 Service 必须沿用 strict capability/pricing/quota 判别、Key envelope、固定连接测试、catalog availability 与定价快照不变量。Brain/视频保存以凭据重新获取模型列表并确认固定模型 ID 为连接证据，不把内容安全 PoC 混入模型 CRUD。生图模型创建/修改在事务外按服务端固定样本真实调用 1K 基线的 `image.generate` 与 `image.edit` 两个代表能力，全部 passed 后才写 `poc_passed`；1K/2K/4K 是公开计价档，不得为保存配置重复生成六张探针图，更高档位在真实调用时仍按 adapter 能力契约 fail closed。failed/unknown 不落库，模型列表命中不得代替图片调用证据，unknown 不自动重投。探针 Provider 幂等键由本次管理写请求的 `Idempotency-Key` 与 spec key 派生，图片字节验证后清零且不进入日志、数据库或响应。内部步骤不接受浏览器传入 header/request JSON、自定义探测样本、任意状态或内部 ID；外部调用在事务前完成，数据库写入在一次有界事务中完成，失败不得留下半配置。普通 `GET /api/v1/model-catalog` 继续只从 active pricing release closure 投影产品快照并执行当前可用性重校验；涉及图片发布时仍必须满足 S12 moderation closure。

公开模型的当前可用性必须同时核对同 Provider 的 provider scope 与该模型的 model scope 熔断记录。任一记录为 open/half-open 或仍标记 hourly_budget 时，返回 `availability=unavailable`；其他模型的 model scope 不影响当前项。不因 cooldown 到期自动改写为 closed，不改变 pricing catalog revision。Compiler trace 分别记录审批、熔断、预算与规格闭包拒绝原因；图片模型不可用的用户提示应明确指向所选生图模型，不误报为 Brain 创作助手故障。

#### 5.3.1 私有对象存储 Admin API

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

channel create strict body 为 `{ purpose:'private_assets', adapter_key, endpoint_profile_key, region, bucket, root_prefix, reason }`。adapter/profile/region/bucket/prefix 必须通过 `packages/storage` 编译期 registry 的 strict schema；禁止 URL、header、公共 ACL、任意对象 key template 或 `force_path_style`。credential body 使用 adapter 判别联合提交一次 secret bundle；响应只返回 ID/version/由 Storage 专属版本化 HMAC 生成的 hint/status，不返回 ciphertext 或 secret 字段；hint key 不与 Provider、envelope encryption 或其他摘要域复用。

validate 创建 `storage_validation_runs + evaluation v3 intent` 并返回 202；固定 probe 在 run 专用私有 prefix 做 put/head/read/range-read/delete，HTTP 事务内不访问存储，并在 evidence 中固定 `s10-private-assets@1` smoke contract version。active credential 重验通过时保持 active 并更新 evidence/verified_at/revision；失败或 outcome_unknown 不降级 active、不覆盖旧有效 evidence。credential activate 必须引用同 credential/channel 的 passed run/evidence digest。channel activate body 为 `{ expected_runtime_revision, expected_channel_revision, validation_run_id, evidence_digest, reason }`，重新验证 active credential、私有 bucket policy、run 的 `s10-private-assets@1` smoke evidence、S10 所需能力和当前 stage 后原子切换 `storage_runtime_state`；registry capability 声明不能替代 smoke evidence。崩溃接管前只删除精确 validation run ID 的旧 probe；终态残留由固定扫描上限的 sweeper 按 run ID 删除，已删除或已不存在的 probe 必须写入耐久清理标记，避免最旧空记录永久阻塞后续残留；禁止全桶或模糊 prefix 清理。切换只影响新 upload intent。disable/revoke 不能删除对象或改历史 `storage_channel_id`，若导致 active runtime 不可用则新上传 readiness 503。

### 5.3.2 内容安全人工处置 Admin API（S12 激活后由 S14B 挂载）

该组 API 在 S12 的图片/审核管线真正注册并创建隔离队列后才开放；未激活时路由返回 404，管理台不显示 O13。所有写接口要求独立 Admin Session、permission、step-up、reason、expected revision、`Idempotency-Key` 和 `Cache-Control: no-store`。

| 方法   | 路径                                        | 权限                | 行为                                                   |
| ------ | ------------------------------------------- | ------------------- | ------------------------------------------------------ |
| `GET`  | `/api/v1/admin/content-reviews`             | `moderation.read`   | 按状态/截止时间/类型 keyset 查询隔离队列               |
| `GET`  | `/api/v1/admin/content-reviews/{id}`        | `moderation.read`   | 脱敏查看审核证据、artifact/任务/资金摘要               |
| `POST` | `/api/v1/admin/content-reviews/{id}/decide` | `moderation.decide` | `release` 或 `reject`；同事务推进隔离、结算/释放和审计 |

裁决只接受当前 revision；`unknown` 证据不能直接作为 `release` 的理由，必须有人工确认摘要。并发裁决只有一个 CAS 胜者，重复请求重放同一结果；拒绝、审计失败、资金或对象依赖不可用时 fail closed，不返回 Provider 原文、完整 prompt、签名 URL、对象 key 或图片二进制。该接口不得新建 Provider submit，也不得修改历史 ledger。

列表真相是 `content_review_cases`，只查询 `pending` 或显式历史状态；详情重校验 case/evaluation/artifact/task/workflow/reservation 的归属闭包。decide body 固定为 `{ decision:'release'|'reject', expected_revision, confirmation_summary:{ artifact_reviewed:true, assessment:'safe'|'unsafe', policy_version }, reason }`；`release` 只接受 `assessment='safe'`，`reject` 只接受 `assessment='unsafe'`，且 `policy_version` 必须等于原不可变 evaluation 的版本。confirmation summary 证明管理员查看了当前 artifact 并完成独立判断，不能用审核 Provider 的 `unknown` 结果替代人工判断。到期 Worker 使用同一 revision CAS 转 `expired` 并释放未结算 reservation，不能与人工裁决产生双结算。

### 5.4 Skill package 与 catalog release Admin API

这些路由只属于独立 `apps/admin`/admin ingress。全部响应 `Cache-Control: no-store`；写请求必须有独立 Admin Session、CSRF/Origin/Host、`Idempotency-Key`、权限、reason，approve/disable/publish/rollback 还要求近期 MFA step-up。普通 ingress 对 `/api/v1/admin/*` 直接 404，普通用户凭据不能换取管理权限。

权限固定为：`skills.read`、`skills.install`、`skills.review`、`skills.publish`。Beta 可由同一管理员兼有多个 permission，但 API/audit 字段保留 reviewer/publisher 分离；未来启用双人审批时不重写领域动作。

| 方法   | 路径                                                           | 权限             | 说明                                               |
| ------ | -------------------------------------------------------------- | ---------------- | -------------------------------------------------- |
| `POST` | `/api/v1/admin/skill-packages/upload-intents`                  | `skills.install` | 创建 `.skillpkg` quarantine 上传意图               |
| `POST` | `/api/v1/admin/skill-packages/{package_record_id}/complete`    | `skills.install` | 服务端核验对象并固化 manifest 身份                 |
| `GET`  | `/api/v1/admin/skill-packages`                                 | `skills.read`    | keyset 分页列出包和最新 validation 摘要            |
| `GET`  | `/api/v1/admin/skill-packages/{package_record_id}`             | `skills.read`    | 查看 manifest、来源、报告和 release 引用的脱敏详情 |
| `POST` | `/api/v1/admin/skill-packages/{package_record_id}/validations` | `skills.install` | 创建不可变 validation attempt                      |
| `POST` | `/api/v1/admin/skill-packages/{package_record_id}/approve`     | `skills.review`  | 固定 passed report 并审批包                        |
| `POST` | `/api/v1/admin/skill-packages/{package_record_id}/disable`     | `skills.publish` | 安全停用，立即阻止新 catalog/turn 使用             |
| `POST` | `/api/v1/admin/skill-catalog-releases`                         | `skills.publish` | 从 base release + changes 创建完整 draft           |
| `GET`  | `/api/v1/admin/skill-catalog-releases/{release_id}`            | `skills.read`    | 查看完整 manifest、diff 和影响摘要                 |
| `POST` | `/api/v1/admin/skill-catalog-releases/{release_id}/publish`    | `skills.publish` | expected catalog revision 原子切换                 |
| `POST` | `/api/v1/admin/skill-catalog-releases/{release_id}/rollback`   | `skills.publish` | 以目标 release manifest 创建并发布新 release       |

上传意图 strict body：

```json
{
  "file_name": "creative-skills-1.2.0.skillpkg",
  "declared_size_bytes": 123456,
  "declared_archive_sha256": "sha256",
  "source_type": "first_party | legacy_owned | admin_upload"
}
```

响应 `201` 只返回 `package_record_id/upload_url/required_headers/expires_at/max_size_bytes`；`upload_url` 是短 TTL、只允许写该 quarantine key 的临时 capability，不持久化到 `admin_idempotency_records`、package 表、审计或日志。首次请求持久化的幂等业务结果只包含 `package_record_id`、目标摘要、上传窗口和限制；同 key/同 request 在该 package 仍为 `quarantined` 且上传窗口有效时，服务端对同一对象键重新签发新的 URL，不创建第二条 package 记录。上传窗口过期或 package 已 complete/rejected/disabled 时不再签发，只返回当前稳定状态；同 key 不同 request 返回 409。一次性邀请码/恢复码/Key 明文仍不可重放，不能套用本条再签发语义。`file_name` 只作展示并规范化，不参与对象键；服务端不在此时相信 package ID/version。complete body 固定为 `{ "expected_revision": 1 }`，服务端重新读取实际对象 metadata、magic bytes、大小和 SHA-256，解析 manifest 后以条件更新进入 `uploaded`；对象不符或冲突进入 rejected/返回稳定错误，不能覆盖已有版本。

创建 validation body 为 `{ "expected_revision": 2 }`，响应 `202` 返回 `validation_report_id/status=queued`。同 package + validator contract + platform eval suite digest 的并发请求只能创建一个 attempt；同幂等键重放原响应。validation 结果只能由 Worker 状态 CAS 写入，Admin API 不能提交或覆盖 report JSON。

approve strict body：

```json
{
  "expected_revision": 4,
  "validation_report_id": "uuid",
  "validation_report_digest": "sha256",
  "reason": "已核对来源、权利与评测结果"
}
```

report 必须属于该 package、状态 passed，且 validator contract/runtime/eval suite 仍受支持；任一 digest 漂移即 409。审批事务物化不可变 Skill/resource snapshot，但不创建 active release。disable body 为 `expected_revision + reason`；成功后 catalog/turn create 立即按 package 状态 fail closed，并由运营创建移除依赖的新 release。

创建 release strict body：

```json
{
  "base_release_id": "uuid?",
  "changes": [
    { "operation": "add | replace", "package_record_id": "uuid" },
    { "operation": "remove", "package_id": "string" }
  ],
  "reason": "发布新一版创意 Skill"
}
```

`changes` 只是管理命令，Service 必须解析成完整 closure 并持久化不可变 manifest/release digest；响应返回 release ID/no/digest、完整 diff 摘要和 blocking findings，不返回 Skill 正文。publish body 固定为 `{ "expected_catalog_revision": 7, "expected_release_revision": 1, "reason": "..." }`；事务外不得下载、解包或运行 eval。rollback 路径中的 `release_id` 是目标历史 release，body 为 `{ "expected_catalog_revision": 8, "reason": "..." }`，服务端创建新的 release_no/ID 后原子切换，绝不原地恢复旧 release。

所有列表/详情响应禁止返回 quarantine/storage key、签名 URL、完整私有 Skill 正文、eval 输入、密钥命中原文或 source locator；只返回 digest、规则 ID、计数、差异摘要和受控预览。所有写操作及敏感读取写 `admin_audit_logs`，actor 必须来自独立 `admin_principals/admin_sessions`，不能由 `users.role`、请求 body 或普通用户 Session 伪造；审计失败时 approve/disable/publish/rollback fail closed。

### 5.5 管理员账号与安全 Admin API

| 方法   | 路径                                                   | 权限                    | 说明                                           |
| ------ | ------------------------------------------------------ | ----------------------- | ---------------------------------------------- |
| `GET`  | `/api/v1/admin/admin-principals`                       | `admin_accounts.read`   | principal、binding、MFA 和 Session 摘要        |
| `POST` | `/api/v1/admin/admin-principals`                       | `admin_accounts.manage` | 创建 pending principal 和一次 enrollment token |
| `GET`  | `/api/v1/admin/admin-principals/{id}`                  | `admin_accounts.read`   | 脱敏账号安全详情                               |
| `PUT`  | `/api/v1/admin/admin-principals/{id}/role-bindings`    | `admin_accounts.manage` | 用完整目标集合替换 binding                     |
| `POST` | `/api/v1/admin/admin-principals/{id}/enrollment-token` | `admin_accounts.manage` | 撤销旧 token 后重新签发                        |
| `POST` | `/api/v1/admin/admin-principals/{id}/reset-enrollment` | `admin_accounts.manage` | 锁死恢复并撤销既有凭据/Session                 |
| `POST` | `/api/v1/admin/admin-principals/{id}/disable`          | `admin_accounts.manage` | 终局停用                                       |
| `GET`  | `/api/v1/admin/admin-principals/{id}/sessions`         | `admin_accounts.read`   | keyset Session 脱敏摘要                        |
| `POST` | `/api/v1/admin/admin-sessions/{id}/revoke`             | `admin_accounts.manage` | 撤销指定 Session                               |

创建 principal strict body：

```json
{
  "identifier": "admin@example.com",
  "display_name": "运营负责人",
  "role_bindings": [{ "role_key": "operations", "scope_type": "global", "scope_id": null }],
  "reason": "封闭内测运营账号"
}
```

identifier 只用于本次请求和规范化 HMAC 查询，响应与数据库普通列不得回显可直接登录的完整 identifier；成功响应首次可含 `{ principal, enrollment_token, enrollment_expires_at, plaintext_available:true }`。同幂等键重放只返回 principal 和 `plaintext_available:false`。role key 固定为版本化服务端 registry（Beta 至少 `support/operations/finance/security_admin/super_admin`）；请求不能提交 permission 数组。scope type/ID 必须通过该 role 的 allowlist 和资源存在性校验。

binding replace body 固定 `{ expected_principal_revision, expected_bindings_revision, role_bindings, reason }`。enrollment-token body 固定 `{ expected_principal_revision, reason }`；只允许 pending principal，原 issued/claimed token 与未完成 challenge/credential 全部撤销后生成新 token。reset-enrollment body 固定 `{ expected_principal_revision, reason }`；用于另一名 super admin 恢复锁死账号，将目标退回 pending、撤销全部 active credential/Session/recovery code，再按一次明文规则签发 token。disable/revoke body 均要求 expected revision + reason。

上述写操作全部要求近期 step-up、`Idempotency-Key`、principal/binding/session 条件更新和成功审计同事务。actor 不能修改自己的 binding、reset/disable 自己或通过撤销当前唯一 MFA 绕过再认证。所有会改变 super-admin 集合或其有效 MFA 的 Service 先获取固定 transaction advisory lock，再锁定/重读目标和 active super-admin 集合，证明提交后仍至少有一个 active、具备有效 MFA 的 `super_admin`；并发只有一个 revision CAS 成功，其他请求返回 409。Session 列表只返回 session ID、状态、MFA level、created/last_seen/expires 时间、可信 IP hash 和 User-Agent 摘要，不返回 token/CSRF/hash。

## 6. 队列设计

参考旧工程 BullMQ 队列：

```text
workflow
task
provider-callback
agent
asset
evaluation
notification
settlement
```

队列名保留不等于 payload 已激活。S07 激活 `provider-callback` 的 callback/poll payload；`notification` 继续等待 S16 或所属 SPEC 回写，回写前不得存在 Producer、Consumer 或 intent。

### DB 到队列的可恢复投递

- 创建 workflow/task 的数据库事务同时写 `queue_dispatch_intents`；需要推送给用户的变化另写 `event_outbox`，两者分别幂等、分别重试。
- intent payload 入库前必须由 `packages/queue` 从 `unknown` 完成 schema 校验；`payload_version` 与 payload 的 `schema_version` 一致。
- dispatcher 用 `FOR UPDATE SKIP LOCKED` 有界领取 pending/过期 lease intent，在短事务内写 owner token/lease，并把 `next_attempt_at` 设为 lease 到期时间后提交，再在事务外使用稳定 `jobId` 写 BullMQ；sweeper 复用 `(status,next_attempt_at)` 索引。
- Redis add 成功后按 `id + lease_owner` CAS 标记 `dispatched`；失败则 owner CAS 释放、指数退避加 jitter。add 成功但 DB 标记失败时以相同 job ID 重放。
- payload/version/job type 永久非法时 intent 转 `cancelled` 并告警，不得形成 poison retry loop。
- Worker 消费前读取数据库当前状态，过期、取消或已终态 job 直接 no-op。
- `not_dispatched` 可按裁决重新调度；`accepted/polling` 只恢复查询/回调等待；`outcome_unknown` 禁止自动重投 Provider，只等待 30 分钟自动释放或由用户另建新收费动作。
- 普通 sweeper 只恢复 pending/过期 lease。Redis recovery sentinel 缺失时，reconciler 必须用数据库 session advisory lock 选唯一 owner，二次确认 sentinel 后分页核对 `dispatched` intent，并按 DB 真相以原 job ID 重建仍需执行的 job。session lock 使用专用 ops 连接，但不得持有跨 Redis 调用的数据库事务。
- reconciliation 对终态 no-op；`accepted/polling` 只重建查询/等待，`outcome_unknown` 只保留审计并交给超时释放 sweeper，禁止重新提交 Provider。完成全部分页后才原子写 sentinel；中途崩溃时允许下一 owner 接管。
- sentinel 缺失期间 queue control-plane readiness 失败；只读/诊断/恢复可运行，新的生成或收费写操作 fail closed。sentinel 不设 TTL，仅在 Redis 数据丢失或代码明确提升 recovery schema version 时触发新一轮全量核对。
- Redis 全量丢失验收必须证明 pending 和仍需执行的 dispatched job 可恢复、终态不重跑、accepted/outcome_unknown 不重复投递。S05 交付该闭环前不得宣称队列可从 DB 完整重建。

dispatcher 是高频 pending poller，sweeper 是低频过期 lease/overdue/终态检查器；两者必须复用同一 claim/CAS repository。Redis 全丢后的 `dispatched` intent 只由 reconciler 处理，不允许 sweeper 另造重建逻辑。

### 公共 job envelope

所有队列 payload 都必须扩展以下 envelope，并由 `packages/queue` 以 `schema_version + job_type` 作为判别字段：

```json
{
  "schema_version": 1,
  "job_type": "string",
  "trace_id": "uuid"
}
```

规则：

- Producer 与 Consumer 使用同一版本化判别联合；外部/持久化 JSON 先视为 `unknown` 再解析。S08 期间联合同时接受既有 v1 job 与唯一的 v2 `skill-package.validate`，但每个 `job_type` 只能对应文档冻结的一个 schema version，禁止把任意 v1 body 改成 v2 后猜测解析。
- 未支持的 schema version 或 job type fail closed，记录脱敏错误并告警，不得无限重试。
- payload 只携带持久化 ID 和必要路由字段，不得携带密钥、二进制、完整 prompt、对象 key、签名 URL 或完整数据库实体。
- payload 中的 `user_id` 只用于路由/诊断，不能作为授权真相；Consumer 必须从聚合资源重新关联并校验 owner。
- BullMQ 自定义 job ID 不得包含 `:`，禁止随机值。首次 task 使用 `task_id`，新 attempt 使用 `task_attempt_id`；复合键使用 canonical hash 的 base64url/hex 表示并限制为 `[A-Za-z0-9_-]`。
- intent 的 `aggregate_id` 始终是主持久化聚合 UUID，不等于复合 job ID。复合动作使用 `aggregate_type + aggregate_id` 定位资源、使用 canonical hash job ID 去重；没有主 UUID 时必须先创建持久化 operation 记录。
- `provider-callback` 在 S07 回写后只允许本节已冻结的 callback/poll job type；`notification` 仍不属于当前 payload 判别联合，所属 SPEC 回写前不得创建 intent 或注册 Processor。任何未知 job type 必须 fail closed 转 `cancelled` 并告警。
- 新 job type 采用两阶段滚动发布。S08 固定流程为：Release A 先让 `packages/queue` 和 Worker 同时接受 v1/v2、注册但关闭 `skill-package.validate` Producer，并在 heartbeat metadata 报告 `supported_queue_schema_versions=[1,2]`，此时 recovery schema 仍保持 v1；确认所有活跃旧 Worker 已 drain/退出后，Release B 才把 `QUEUE_RECOVERY_SCHEMA_VERSION` 提升到 2。v2 sentinel 缺失期间 readiness 503，由支持 v2 的 reconciler 按 DB intent 重建并写新 sentinel；完成后才可启用 Skill validation Producer。旧 v1 intent/job 继续按原 schema 处理，不批量改写历史 payload。任一步无法证明无旧 Consumer 时 Producer 必须保持关闭。

### S08 transcript 内部兼容边界 (2026-09-07)

**2026-09-09 修订，取代本节旧格式发布/回填/回滚安排**：按 `02` 11.0 只验收新会话 `transcript_v1/1`，不做 legacy 排空兼容、历史回填或双格式运行。切换时先停止旧进程消费并确认本地清理范围，不启动第二 Worker；残留旧 turn/job 不执行也不转换。公网安全 payload、持久化格式的服务端裁决、新流程故障恢复与 Provider 三态约束保持不变。此修订不表示新路径已经可启用。

- transcript 扩展不新增公网原文 API，不改变现有 create/confirm/interrupt、GET turn/session 或 SSE 的安全 payload。`chat_messages`、transcript item、适用的状态/trace/outbox 在 `05` 定义的同一短事务提交；数据库失败不能先向页面宣称完成。
- `agent.continue` 仍传既有 turn/revision/continuation 定位字段；`execution_format/transcript_capture_version` 只从已鉴权关联的数据库 turn 读取，不由模型、客户端或 job 覆盖。Redis 全丢重建 intent 后同样按该持久化格式恢复。
- 发布顺序是扩展 schema -> P1 兼容 API/Worker（执行 legacy，支持 v1 捕获，默认不开捕获）-> P1 导入/影子验证 -> P2 双执行格式 API/Worker -> 只对符合门槛的 session 新建 transcript turn。不修改已有 intent 的 schema/version，也不为格式开新队列或允许第二个 Worker 抢同一任务。
- Worker heartbeat 的受控 metadata 增加 `supported_agent_execution_formats` 与 `supported_transcript_schema_versions`，只含版本枚举，不含内容。**2026-09-13 更新**：当前实现 readiness 报告 `supported_agent_execution_formats: ['transcript_v1']` 与 `supported_transcript_schema_versions: ['1']`（新会话只验收 `transcript_v1/1`，不再对外宣称 `legacy_v1` 执行支持；本行 legacy_v1 表述为 P1 时点历史）。开启前仍须证明所有活跃相关 API/Worker 已运行对应兼容版本；仅 Worker 心跳不足以证明 API 兼容，API 还需部署版本/readiness 验证。旧 Consumer 必须先 drain；未知执行格式应停止消费并告警，不按 legacy 猜测执行。
- 停用 P2 只影响新 turn 的格式选择。已有 transcript turn 仍由兼容 Worker 按原格式运行或排空；存在这种 turn 时不得回滚到仅理解 legacy 的二进制。旧格式 trace 恢复在旧任务全部排空和回滚窗口结束前保留，禁止批量改写 turn 格式来伪造回滚完成。
- 回填只恢复已存在 message 的语义，不触发模型、工具、收费、quote、公开消息或 SSE 重发。中断、retry、outcome_unknown、迟到产物仍沿用既有业务状态和分支映射，不能把“transcript 已写完”投影成“图片已生成”。
- 私有 payload、raw call args、prompt、Skill 正文、签名 URL 和 Provider body 不进入 queue intent、outbox 或 SSE。队列通知至多携带已授权关联的 ID/版本，消费者重新读 DB。

### workflow job payload

```json
{
  "schema_version": 1,
  "job_type": "workflow.advance",
  "trace_id": "uuid",
  "workflow_run_id": "uuid",
  "user_id": "uuid"
}
```

S05 只用该 job 推进测试夹具和验证数据库状态 guard；S04 提交真实收费 workflow 后才接入生产 Producer。Consumer 必须重新读取 workflow/task 数据库状态，不能信任 payload 携带状态快照。

所有 Consumer 状态推进使用数据库 CAS：条件必须包含实体 ID、允许的旧状态和必要 version/owner；受影响行数不是 1 时重新读取并按已完成 no-op 或非法迁移拒绝。业务状态与对应 `event_outbox` 同事务提交，禁止无条件 update 或只依赖 BullMQ job 去重。

### task job payload

```json
{
  "schema_version": 1,
  "job_type": "task.execute",
  "trace_id": "uuid",
  "task_id": "uuid",
  "workflow_run_id": "uuid",
  "task_attempt_id": "uuid?",
  "user_id": "uuid"
}
```

规则：

- `jobId = task_id` 用于首次执行幂等。
- 每次真实 Provider 投递前创建 `task_attempt`。
- 若需要新 attempt，`jobId = task_attempt_id`。
- BullMQ 自带 attempts 只用于本地未送达重试，不用于 Provider 已受理后的重试。

### post-moderation job payload

生成后图片审核使用独立的 `moderation` 队列，避免长耗时图片生成阻塞已完成产物的安全审核和增量交付：

```json
{
  "schema_version": 4,
  "job_type": "moderation.execute",
  "trace_id": "uuid",
  "task_id": "uuid",
  "workflow_run_id": "uuid",
  "user_id": "uuid"
}
```

规则：

- payload 中的 `task_id` 必须回查为 `type=moderation.image` 且属于同一 workflow/user；类型或归属不符 fail closed。
- generation task 成功隔离入库后，在同一短事务激活对应 moderation task 并创建 `moderation` queue intent；事务内仍不得调用审核 Provider。
- `moderation` 与 `task` 各自有界消费；首版各为单并发，使下一张生成与上一张审核可以并行，但同一队列内保持稳定顺序。
- 每张 artifact 审核通过后立即退出 `quarantined` 并发布该张 `artifact.created`；workflow/turn 只在整批任务终结后收口，不得为增量展示提前伪造整批成功。
- 为兼容升级前已持久化 intent，Worker 继续允许旧 `task.execute` 消费 `moderation.image`；新 Producer 只能创建 `moderation.execute`，不得把新审核任务继续写入普通 `task` 队列。
- Redis recovery 必须以持久化 intent 的原 queue/job type 重建；v4 sentinel 完成前 readiness fail closed。单实例 Worker 部署必须先 drain 旧 Worker，再启动同时支持旧 `task.execute` 和新 `moderation.execute` 的 Worker，由新 Worker 完成 v4 reconciliation 后接流。

### provider callback/poll job payload

`provider-callback` 队列只承载已持久化 callback event 的处理和已受理 attempt 的轮询，不承载新的 Provider submit：

```json
{
  "schema_version": 1,
  "job_type": "provider.callback.process",
  "trace_id": "uuid",
  "provider_callback_event_id": "uuid",
  "processing_no": 1
}
```

```json
{
  "schema_version": 1,
  "job_type": "provider.poll",
  "trace_id": "uuid",
  "task_attempt_id": "uuid",
  "poll_no": 1
}
```

规则：

- callback job ID 使用 `compositeJobId(provider_callback_event_id,processing_no)`；poll job ID 使用 `compositeJobId(task_attempt_id,poll_no)`，不得包含冒号。
- callback intent 的 `aggregate_type=provider_callback_event`、`aggregate_id=provider_callback_event_id`；poll intent 的 `aggregate_type=task_attempt`、`aggregate_id=task_attempt_id`。
- payload 禁止 Provider request ID、回执、输出 URL、签名、header、Key、prompt 或二进制；Consumer 必须回查数据库真相。
- callback Consumer 必须匹配 `processing_no=current processing_count+1`；重复/旧序号幂等 no-op，未来序号 fail closed。retryable unmatched 每次增加 processing count 后创建新 intent，不能复用已经 dispatched 的旧 intent/job ID。
- poll Consumer 必须匹配 attempt 当前 `accepted/polling + dispatch_state=accepted + poll_count+1`；重复/旧 poll 幂等 no-op，未来序号或非法状态 fail closed。
- Redis 恢复只能从 DB 重建 callback processing 和 accepted/polling 查询，不得把 callback/poll job 变成 submit。

### agent job payload

S09 激活后，agent 队列是以下严格判别联合：

```json
{
  "schema_version": 1,
  "job_type": "agent.continue",
  "trace_id": "uuid",
  "session_id": "uuid",
  "turn_id": "uuid",
  "user_message_id": "uuid",
  "continuation_no": 1,
  "turn_revision": 1
}
```

```json
{
  "schema_version": 1,
  "job_type": "agent.quote.submit",
  "trace_id": "uuid",
  "turn_id": "uuid",
  "quote_id": "uuid",
  "continuation_no": 1,
  "plan_digest": "sha256",
  "authorization_digest": "sha256"
}
```

```json
{
  "schema_version": 1,
  "job_type": "agent.quote.expire",
  "trace_id": "uuid",
  "turn_id": "uuid",
  "quote_id": "uuid",
  "continuation_no": 1,
  "plan_digest": "sha256"
}
```

- payload 不携带 message、attachments、mention bindings、prompt、Skill 正文、tool args 或模型 Key；Consumer 回查数据库真相。
- job ID 使用 `compositeJobId({job_type,turn_id,continuation_no})`；intent 使用 `aggregate_type=agent_turn`、`aggregate_id=turn_id`。
- create/confirm 与 intent/outbox 同事务；Redis add 仍由 S05 dispatcher 在事务外完成。
- `agent.quote.submit` 只能由 Compiler 成功落库事务为 1A Agent quote 创建；job ID 还必须绑定 quote/plan/authorization digest，稳定幂等。Consumer 重读并锁定 turn/quote/`generate_action@v2` 授权快照，委派 S04 统一 submit application service；不得自行写 ledger/reservation/workflow。digest/continuation/owner 不一致、quote 非 quoted 或余额核对失败时 fail closed；已提交同 quote 按原 workflow 幂等 no-op。
- 每个 Agent quote 同事务创建一个 `agent.quote.expire` intent，`next_attempt_at=quote.expires_at`，稳定 job ID 绑定 quote/plan。Consumer 按 `turn -> quote` 锁序：已 submitted/superseded/cancelled/expired 时 no-op；仍为同一 quoted quote 时原子置 quote expired、turn cancelled、trace cancelled，并写 status/cancelled outbox。不得靠浏览器在线、GET 请求或内存 timer 才收敛。
- 自动提交遇到 `INSUFFICIENT_CREDITS`、价格不可用或单次计划数量越界时停止后台重试，在 `turn -> quote` 短事务取消未提交 quote、把 turn 收敛为公开失败/阻断状态并写安全 reason outbox；不转 `waiting_user_confirmation`，不写费用卡，也不允许浏览器提交旧 quote。用户已有活动 workflow 不属于失败条件，新 task 正常入队并由内部调度控制实际执行并发。权限/风险明确禁止同样 cancel quote 并 block turn；数据库/Redis 暂时故障按队列有界退避重试，不能伪装成用户动作。
- Redis 全丢恢复必须重建仍为 `quoted`、turn 仍为 `run_quote_created` 且存在 live `agent.quote.submit` intent 的任务；不得扫描所有低价 quote 后猜测重建。资金事务已经提交但 wake 丢失时以 DB/outbox 为真相，不重投 Provider。
- `turn_revision` 是创建该 continuation intent 时的审计基线，不是整个 Consumer 生命周期的永久等值条件。当前 DB continuation 小于 payload 为未来消息，或同 continuation 的当前 revision 小于 payload，均 fail closed；DB continuation 大于 payload 为旧 job 幂等 no-op。DB continuation 相同且 revision 已因本 continuation 的合法状态/lease/step 推进而大于 payload 时，Consumer 必须按当前可恢复状态、processing lease 和 step 真相接管，不能把合法 stalled 恢复误判为旧 job。
- session/message/trace 归属不一致 fail closed 并告警。Redis 全丢只重建当前仍可处理、continuation 匹配且存在可恢复 intent 的 job；重建 payload 使用该 intent 的持久化审计基线，不能把数据库当前 revision 改写成新的业务世代。等待确认和终局 turn 不重建。BullMQ attempts 不能绕过 processing lease/revision CAS。

### evaluation job payload

`evaluation` 队列的 payload 是以下判别联合。S08 新增 `skill-package.validate` 必须执行 §6 的 Release A/Release B：解析联合先支持 v1/v2，旧 v1 `evaluation.run` 不迁移；所有旧 Worker 退出后再把 recovery schema 常量升到 v2，完成新 sentinel reconciliation 后才启用 Producer。S14 的 `provider-credential.validate`、`storage-credential.validate` 与 `model-poc.run` 以同一流程加入 v3：Release A 先让 dispatcher/Worker 接受 v1/v2/v3 且关闭三个 Producer，旧 Worker 全部 drain 后 Release B 才提升 recovery schema、重建 v3 sentinel 并启用 Producer。

v1 `evaluation.run` 只允许无网络的确定性 evaluator 或兼容 legacy 任务。S12 的真实 `moderation.image` 是收费 workflow 中的正式 task，消费 `task.execute` 并创建独立 `task_attempt`；不得借 v1 payload 绕过 Provider 三态、成本和恢复真相。审核完成后才把不可变结论写入 `artifact_evaluations`。

```json
{
  "schema_version": 1,
  "job_type": "evaluation.run",
  "trace_id": "uuid",
  "artifact_id": "uuid",
  "evaluation_type": "commerce_evidence | platform_spec | content_safety",
  "workflow_run_id": "uuid"
}
```

```json
{
  "schema_version": 2,
  "job_type": "skill-package.validate",
  "trace_id": "uuid",
  "package_record_id": "uuid",
  "validation_report_id": "uuid",
  "attempt_no": 1,
  "package_digest": "sha256",
  "validator_contract_version": "skill-package-validator@1",
  "platform_eval_suite_digest": "sha256"
}
```

```json
{
  "schema_version": 3,
  "job_type": "provider-credential.validate",
  "trace_id": "uuid",
  "credential_validation_run_id": "uuid",
  "provider_channel_id": "uuid",
  "credential_version_id": "uuid",
  "probe_contract_version": "provider-credential@1",
  "attempt_no": 1
}
```

```json
{
  "schema_version": 3,
  "job_type": "storage-credential.validate",
  "trace_id": "uuid",
  "storage_validation_run_id": "uuid",
  "storage_channel_id": "uuid",
  "credential_version_id": "uuid",
  "probe_contract_version": "storage-private-assets@1",
  "attempt_no": 1
}
```

```json
{
  "schema_version": 3,
  "job_type": "model-poc.run",
  "trace_id": "uuid",
  "model_poc_run_id": "uuid",
  "model_snapshot_id": "uuid",
  "provider_channel_id": "uuid",
  "credential_version_id": "uuid",
  "probe_suite_version": "model-poc@1",
  "requested_spec_keys_digest": "sha256",
  "attempt_no": 1
}
```

- payload 只携带持久化 ID、精确 digest 和 contract version，不携带 archive bytes、对象键、manifest、Skill 正文、eval 内容或 source locator。Consumer 从数据库和隔离 storage 回查，并逐项复算 hash。
- job ID 固定为 `skill-package_validate_{validation_report_id}`，只含 `[A-Za-z0-9_-]`，intent 使用 `aggregate_type=skill_package_validation`、`aggregate_id=validation_report_id`。创建 report 与 queue intent 同一短事务；Redis add 在事务外。
- Consumer 仅允许 `queued/running` 的同一 report attempt。首次领取按 `validation_report_id + status=queued + attempt_no + revision` CAS 为 `running` 并同时写 `processing_owner/processing_lease_expires_at/last_heartbeat_at`；接管只允许 lease 已过期的 running report，并以新 owner/revision CAS 续约。所有中间 heartbeat 与终态写都携带 owner/revision；旧 owner 晚到 no-op。passed/failed/cancelled 终态清空 owner/lease 且永远不重跑 eval。
- 终态 report、report digest、package 状态 `ready_for_review|validation_failed` 与审计/outbox 在同一短事务写入。package revision 已变化、被 rejected/disabled 或 digest 不匹配时 report 转 cancelled/failed closed，不能把旧结果审批到新字节。
- evaluator 无网络、无 Provider/邮件、无生产 Key、无用户数据和数据库管理权限；只可读该 package 的 quarantine/content-addressed 对象并通过窄 repository 写该 report。运行超时、资源超限或 scanner/eval 崩溃统一 failed，不能用“部分通过”进入 review。
- `provider-credential.validate` 与 `model-poc.run` 是 evaluation 队列中仅有的、允许通过 `packages/provider` 访问目标 Provider 的 job type；前者只执行 registry 固定的无副作用 credential capability probe，后者执行 model 固定测试套件。Processor 使用 channel/model 中已固化的 adapter profile，不能接受 payload 中的 secret、prompt、Provider 参数或 URL；credential secret 只由窄 secret repository 在 Worker 内存中解密，绝不进入 job。固定模型夹具由 `probe_suite_version` 编译期解析，输出进入隔离私有存储并按 PoC 生命周期清理，不进入用户资产。
- credential validation job ID 固定为 `provider_credential_validate_{credential_validation_run_id}`，intent 使用 `aggregate_type=provider_credential_validation/aggregate_id=credential_validation_run_id`。创建 run 与 intent 同事务；queued/running lease、owner、revision 和终态 CAS 与 model PoC 同级严格。确定未投递可由管理员创建新 run；请求可能写出、timeout、连接复位或响应不可解析进入 `outcome_unknown`，当前 run 不自动重投，也不切换 active credential。
- `storage-credential.validate` 是 evaluation 队列中唯一允许通过 `packages/storage` 访问目标私有 bucket 的 job type。job ID 固定为 `storage_credential_validate_{storage_validation_run_id}`，intent 使用 `aggregate_type=storage_validation_run/aggregate_id=storage_validation_run_id`。Processor 只从 channel/credential repository 读取 strict adapter 配置和受控内存 secret，在 run 专用 prefix 执行固定 put/head/range-read/delete；payload/日志/审计不含 endpoint、bucket secret、对象 key、URL 或字节。queued/running lease 与终态 CAS 同级严格；timeout/连接复位/删除结果未知进入 outcome_unknown，不自动重跑、不切 active，残留对象只由精确 run ID sweeper 清理。
- model PoC job ID 固定为 `model_poc_{model_poc_run_id}`，intent 使用 `aggregate_type=model_poc_run/aggregate_id=model_poc_run_id`。创建 run 与 intent 同一短事务，Provider 调用在事务外；queued/running lease、owner、revision 和终态 CAS 与 Skill validation 同级严格。确定未投递可由管理员创建新 run 重试；accepted/timeout/连接复位/回执不可解析统一 `outcome_unknown`，当前 run 不自动重投。passed/failed/outcome_unknown/cancelled 都是该 run 终态。

### asset job payload

用途：上传完成后的缩略图生成、服务端元数据探测和异步清理；不在 HTTP 上传完成接口中同步执行。

`asset` 队列同时承载对象存储派生任务和异步导出，不新增第二套队列名。payload 是以下判别联合之一：

```json
{
  "schema_version": 1,
  "job_type": "asset.process",
  "trace_id": "uuid",
  "asset_id": "uuid",
  "operation": "generate_thumbnail | inspect_metadata | cleanup",
  "operation_no": 1,
  "user_id": "uuid",
  "idempotency_key": "asset:{asset_id}:{operation}:{operation_no}"
}
```

`idempotency_key` 是可审计的业务位置键；BullMQ `jobId` 不直接复用含冒号的该值，必须由 `compositeJobId({job_type:'asset.process',asset_id,operation,operation_no})` 生成稳定摘要。

`operation_no` 必须等于持久化 `assets.processing_revision`。`inspect_metadata` 成功后为同一 revision 创建 `generate_thumbnail`；用户对 `processing_failed` 显式重试时先原子递增 revision，再创建新 job。Consumer 每次按 `asset_id + user_id + operation_no + 当前状态` CAS，旧 revision、重复消费和已终局 asset 幂等 no-op。asset 派生任务允许确定性重算，但 BullMQ `attempts` 不承担业务重试；缩略图写入后崩溃必须重放到同一内容寻址 key。

```json
{
  "schema_version": 1,
  "job_type": "export.process",
  "trace_id": "uuid",
  "export_id": "uuid",
  "operation": "build | retry_failed | cleanup",
  "user_id": "uuid",
  "idempotency_key": "export:{export_id}:{operation}:{attempt_no}"
}
```

export job 只携带持久化 ID；Worker 从 `export_jobs/export_job_items` 读取已冻结清单，逐项重新鉴权，不在 payload 中传完整清单、对象键或签名 URL。

### settlement job payload

用途：Provider 或本地任务成功后，由 Credit 模块执行 reservation 结算。Worker 不直接写 `credit_ledger.consume`。

```json
{
  "schema_version": 1,
  "job_type": "settlement.execute",
  "trace_id": "uuid",
  "workflow_run_id": "uuid",
  "task_id": "uuid",
  "task_attempt_id": "uuid",
  "reservation_id": "uuid",
  "provider_reported_cost": "decimal?",
  "artifact_ids": ["uuid"],
  "idempotency_key": "settle:task_attempt:{id}"
}
```

结算事件链：

```text
task_attempt=succeeded
  -> worker 写 task_attempt.provider_reported_cost 和 visibility=quarantined 的原始 artifact
  -> 依赖该输出槽位的 moderation.image task 通过 moderation.execute 创建独立 task_attempt（旧 task.execute 仅兼容存量）
  -> 审核 attempt 三态收敛，并原子写不可变 artifact_evaluation + moderation task 终态/review case
  -> 审核通过后执行最终媒体发布处理并将 artifact 转为可见，写 event_outbox: artifact.created / task.succeeded；1A 不叠加产品水印或 AI 标识
  -> 入队 settlement job
  -> Credit 服务在事务内校验 reservation/task/run 状态
  -> 写 credit_ledger consume
  -> 更新 credit_reservation settled_amount/status
  -> 更新 workflow_run/task 终态
  -> 写 event_outbox: credit.settled / workflow.status_changed
```

规则：

- `settlement` job 必须幂等，幂等键为 `settle:task_attempt:{task_attempt_id}`。
- Credit 服务是唯一允许写 `consume/release/appeal_refund/manual_correction` 流水的业务模块。
- Worker 可以写 Provider 回执、成本摘要和产物入库，但不得自行判断最终扣费金额。
- 真实生成后审核必须是 workflow DAG 中的 `moderation.image` task；每个预期输出槽位有稳定 task/operation key，运行时按 generation task + output index 解析唯一 quarantined artifact。审核 Provider 每次实际调用写独立 task attempt，`accepted/outcome_unknown` 不重投；审核 actual cost 进入 task/attempt 成本和内部毛利指标，但不另建用户隐藏扣费项。
- 多输出 workflow 必须逐张审核、逐张发布：任一输出通过后立即发出该张 `artifact.created`，不得等待其他 generation task 完成；未通过审核的 sibling 继续保持 `quarantined`。
- `settlement` 只允许处理已通过生成后内容安全审核且已退出 `quarantined` 的 artifact；审核拒绝或 24 小时 SLA 内仍未知时，按 `04` 释放 reservation，不写 consume。
- 若结算校验失败，任务进入 `waiting_manual_review`，不得重复结算。
- `accepted` 在超时转为 `outcome_unknown` 后补发成功/失败回执（含 30 分钟释放前）不得自动结算或发布，必须按 `04` 的迟到异常规则处理，平台承担相关 Provider 成本。仍处于 `accepted/polling` 的正常可信终局按原成功/失败路径处理。

## 7. Provider Webhook

路径：

```text
POST /api/v1/webhooks/providers/{provider}
```

要求：

- provider path 必须命中编译期 allowlist；未知 provider 返回 404。
- 对有固定上限的 raw body 先验签再解析；验签使用固定 header schema、时间窗和 constant-time compare。raw body、签名和完整 headers 不落库、不入日志/队列。
- IP allowlist 只能作附加信号，不能替代签名；代理 IP 继续按 `08/10` 的可信代理链解析。
- 验签后从 `unknown` 解析最小 payload，以厂商 event ID 或 canonical body keyed digest 去重。
- 同一短事务插入/复用 `provider_callback_events` 并创建 `provider.callback.process` queue intent；持久化成功后返回泛化 202。
- Consumer 用 `provider_request_id` 找到 `task_attempt`，通过 DB CAS 幂等处理重复回调。
- 回调无法匹配、终态冲突或 outcome_unknown 后迟到时进入 dead letter 并保留审计，不直接丢弃，不等待人工核对，也不自动结算。
- callback 早于本地 accepted CAS 时先标记 unmatched dead letter并写下次归并时间；attempt 写入同一 provider request ID 后以递增 `processing_no` 创建可恢复 callback intent，定时 sweeper 也有界扫描保留期内 retryable unmatched event。该恢复只重新归并 callback，不调用 Provider submit。

入参归一化：

```json
{
  "provider": "string",
  "provider_request_id": "string",
  "status": "accepted | succeeded | failed | cancelled",
  "outputs": [{ "provider_output_id": "string", "media_type": "image" }],
  "error": { "code": "stable_error_code?" },
  "cost": "decimal_string?",
  "occurred_at": "UTC ISO-8601",
  "raw_summary": { "provider_code_hash": "string?" }
}
```

`outputs` 只保存 Provider output ID 和媒体类型等非敏感引用；下载 URL、对象 key 和二进制必须在后续受控 Worker 内存中获取并交给 S10 storage adapter，不写 callback event、queue payload 或日志。重复 webhook 返回相同 202，不泄露 request ID/attempt 是否存在。验签失败返回 401，格式错误返回 400。

## 8. SSE 事件

路径：

```text
GET /api/v1/events?scope=workflow_run:{id}|turn:{id}|session:{id}|canvas:{id}|batch:{id}|suite:{id}|export:{id}&last_event_seq=123
```

事件真相来自 `event_outbox`，不是内存。

业务状态与对应 outbox 事件必须同事务写入。S05 的 append primitive 以 `(scope_type, scope_id)` 派生 PostgreSQL transaction advisory lock，在事务内持锁后分配 `max(event_seq) + 1`，首个事件为 `1`；唯一约束仅作并发兜底。S05 提供按 seq 查询，SSE endpoint/fanout/客户端恢复由 S06 交付。

多实例通过 Redis pub/sub 做低延迟 fanout/wake-up；pub/sub 丢消息不改变真相。客户端或 SSE 服务按 `last_event_seq` 从 `event_outbox` 补齐，直接查 DB 只用于重连补齐或 fanout 故障降级，不替代正常连接的实时推送。

| event_type                   | payload                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `turn.created`               | turn 摘要/user_status                                                           |
| `turn.status_changed`        | previous_user_status/user_status；提交事件额外携带可选 workflow_run_id          |
| `turn.message_delta`         | assistant 文本增量、安全摘要，不包含完整 prompt                                 |
| `turn.activity_started`      | activity_id/activity_type/display_summary/status                                |
| `turn.activity_finished`     | activity_id/activity_type/display_summary/status/public_error_code?             |
| `turn.confirmation_required` | clarification/product_facts/risk 的 strict 判别联合；不含 cost                  |
| `turn.guardrail_triggered`   | guardrail_type/action/summary；类型与固定摘要按下文的共享公开契约校验           |
| `turn.superseded`            | previous_turn_id/new_turn_id/reason                                             |
| `turn.interrupted`           | turn_id/reason                                                                  |
| `turn.cancelled`             | turn_id/reason=user_requested\|confirmation_expired\|policy_cancelled           |
| `turn.completed`             | turn 终局摘要                                                                   |
| `turn.failed`                | error_code/summary                                                              |
| `workflow.created`           | run 摘要                                                                        |
| `workflow.status_changed`    | from/to                                                                         |
| `task.status_changed`        | task_id/from/to                                                                 |
| `task.progress`              | progress/message                                                                |
| `artifact.created`           | artifact_id/task_id/visibility；仅在内容安全审核通过并退出 `quarantined` 后发布 |
| `content_review.resolved`    | content_review_case_id/decision/artifact_id；审核裁决或到期关闭时发布           |
| `credit.reserved`            | amount                                                                          |
| `credit.settled`             | amount                                                                          |
| `credit.released`            | amount                                                                          |
| `risk.warning`               | evaluation 摘要                                                                 |
| `appeal.updated`             | appeal 状态                                                                     |
| `canvas.graph_saved`         | canvas_id/revision，3a；不携带完整 graph_json                                   |
| `canvas.node_status_changed` | canvas_id/node_id/task_id/user_status，workflow/task 的 UI 投影                 |
| `canvas.export_updated`      | canvas_id/export_id/status/error_code                                           |
| `canvas.template_published`  | canvas_id/template_id/version                                                   |
| `batch.status_changed`       | batch_id/status/succeeded_count/failed_count                                    |
| `suite.status_changed`       | suite_id/status/succeeded_count/failed_count                                    |
| `export.status_changed`      | export_id/status/succeeded_count/failed_count/expires_at                        |

`turn.failed` 的 Producer 必须把 Compiler rejection 归一到本节公开错误码与服务端固定摘要，不能把内部 `rule_id` 或临时文案直接写入事件。SSE 投影层可以为已经持久化的旧 Compiler 摘要保留有限白名单以保证历史回放，但新事件不得继续产生这些旧变体；未知错误码、未知摘要和额外字段仍然 fail closed。

Agent 失败摘要、公开错误码及 guardrail 类型以 `packages/shared/src/agent-public-contract.ts` 为唯一代码定义；Worker 发射、API 投影与 Web 校验必须引用它，禁止分别维护白名单。公开内容安全错误码包括 `CONTENT_SAFETY_BLOCKED`、`CONTENT_SAFETY_UNAVAILABLE`，不得输出内部诊断原文。跨层测试必须覆盖每个固定失败摘要及 guardrail 类型，并用真实 HTTP SSE 与 GET turn 验证失败结果可读。

`guardrail_type` 允许 `round_budget`、`tool_budget`、`repeated_tool_call`、`no_progress`、`repeated_error`、`token_budget`、`invalid_model_output`、`cost_budget`、`pricing_drift`、`public_text_policy`、`content_safety`。`invalid_model_output` 根据失败边界使用结构未形成、连续无效输出或工具批次违规的固定摘要；安全、上下文、重复图片查看与恢复耗尽也使用共享契约中的固定摘要。GET turn 的 `failure_summary` 必须读取最近的 `turn.failed` 或 `turn.guardrail_triggered`，与 SSE 保持一致，不得因刷新丢失原因。

S07 及后续 SPEC 新增公网事件类型时，必须在同一交付中同步扩展服务端 `projectPublicEvent` 投影白名单、Web `SUPPORTED_EVENTS` 白名单和对应契约测试。任一环节未完成时保持 fail closed：不得向客户端发送未知 payload，也不得通过跳过未知事件推进游标。

SSE 客户端断线、页面刷新或切换网络后必须使用 `last_event_seq` 恢复。页面刷新不得影响已经落库的 turn、quote、workflow、task 或 reservation。

turn 级事件规则：

- 所有 turn 事件必须带 `turn_id`、`event_seq`、`agent_trace_id`。
- `turn.message_delta` 只用于用户体验，不作为审计真相；审计以 `agent_trace_steps` 和业务表为准。
- 客户端同时检查 event_seq 与每个 message_id 的 delta_seq（从 1 连续递增，is_final 后不再追加）；不一致须恢复快照。完整快照中的消息不得再次拼接无法对应的增量。
- turn payload 的逐事件 strict 字段、枚举和限制以 S08 §12.2 为正文；`turn.message_delta` 只能在完整 assistant 文本通过 schema/公开文本/内容安全并持久化后确定性切片。运行中可用独立的 `turn.response_draft_delta/cleared` 预览显式 `agent_respond` 或原生 `chat_text` 的已校验公开前缀；草稿不是消息或终态，不得转发未经检查的文本、reasoning 流或其他工具入参，GET turn 仅在当前步骤仍运行时恢复草稿。
- GET turn 重建草稿时若遇到非法预览事件、重复/跳号或累计超长，必须丢弃整个预览并返回 `response_draft=null`，不得返回已拼接的部分文本或使其余有效快照不可读。仅记录不含正文/事件 payload 的受控诊断；鉴权、正式消息、确认、活动及 SSE 事件校验仍 fail closed，数据库和其他完整性错误不得吞掉。
- 内部 `tool_name/args_hash/error_code` 只写 trace，不进入公网。`turn.activity_*` 的 `activity_type` 只允许 `knowledge_loading/context_reading/plan_preparing/safety_checking`，`display_summary` 由服务端按真实阶段从固定枚举映射，不接受模型自由文本。`context_reading` 首轮使用“正在理解你的需求”，紧接成功图片物化的推理轮使用“正在分析参考图片”，其他工具结果返回后的后续推理轮使用“正在继续思考”；历史事件中的“正在读取已授权的上下文”只为回放兼容而保留，不得由新事件继续产生。activity type 与 summary 必须属于同一受控映射，且同一 `activity_id` 的 started/finished 必须一致。
- `turn.status_changed.previous_user_status/user_status` 只允许 `thinking/waiting_for_you/stopped/completed/failed`，由服务端映射内部状态；数据库 `from/to` 不进入公网，前端不得直接翻译内部枚举。报价提交产生的 `turn.status_changed` 额外携带可选 `workflow_run_id`（uuid），仅用于前端关联 run 作用域事件与生成占位；不含 Provider、内部模型或成本信息。
- `turn.confirmation_required` 只包含必要澄清、商品事实和风险等拥有真实 `confirmation_id/type/version/public_payload/expires_at` 的 strict 分支；任何生成入口都不包含 `cost@v1`。
- 每次内部 turn 状态迁移仍占用连续 event seq；若迁移前后映射为同一 `user_status`，公开 status event 允许两值相同，客户端必须只推进 cursor，不生成重复阶段提示。
- `turn.interrupted` 仅补充用户主动停止；所有 cancelled 路径同时写 `turn.cancelled`。确认过期不能伪装为用户停止。
- `artifact_visibility=quarantined` 的产物，用户侧详情、文件、下载、分享接口统一返回 `ARTIFACT_QUARANTINED`；只有具备内容安全复核权限的运营接口可查看处置记录。
- 前端收到 `turn.confirmation_required` 后只能展示对应澄清/事实/风险动作，不得自行 submit quote 或构造资金证据。
- 跨上传组澄清仍使用 `clarification@v1`，其 `public_payload` 可额外携带服务端计算的 `scope_digest`（64 位小写十六进制）；此时 `allow_free_text=false`，选项必须是 `option-1`（只处理最近上传）与 `option-2`（同时处理这些上传组）。API 事件校验与 Web SSE 校验必须一致接受并校验该字段，客户端不得回传或覆盖 digest。
- 新用户消息到达时，服务端按本文件 `POST /api/agent/turns` 的 supersede 规则处理旧 turn。
- canvas 事件只做 UI 投影；节点运行状态仍以 workflow/task/attempt 为真相。`canvas.graph_saved` 不广播私有图正文，客户端需要时按 revision 重新读取。

连接、心跳和看门狗：

- 服务端每 15 秒发送一次 SSE heartbeat：`event: heartbeat`，payload 包含 `server_time`、`scope` 和当前 `last_event_seq`。
- heartbeat 不写入业务状态表；可写轻量连接日志，不作为审计真相。
- 客户端 45 秒未收到任何事件或 heartbeat，必须主动断开并用最近的 `last_event_seq` 重连。
- 客户端重连后若发现 seq 缺口，必须请求缺失事件；若缺失事件已超过保留期，则调用对应详情 API 重建页面状态。
- 服务端发送失败不得影响 worker 执行；SSE 只是投影通道。
- 客户端页面刷新后，先调用对应 workflow/task/canvas 详情 API 重建当前状态，再以返回的 `last_event_seq` 订阅增量事件。
- 服务端按事件等级保留 outbox：`critical` 至少 30 天，`normal` 至少 7 天，`debug` 至少 1 天。
- `critical` 包括账本、workflow/task 终态、artifact 创建、申诉、Provider unknown 和人工操作；`normal` 包括 turn 状态/终态和确认事件；`debug` 包括 `turn.message_delta` 和 activity 摘要流。
- 保留期表示最短保留时间，不授权直接删空 scope。当前 `event_seq` 依赖 scope 内 `max + 1`；归档/清理实现必须先保留独立高水位或每 scope 最新锚点，确保后续序号不重用。该能力落地前保留全部 outbox 事件。

## 9. 错误码

| code                                   | HTTP | 含义                                                      |
| -------------------------------------- | ---: | --------------------------------------------------------- |
| `UNAUTHORIZED`                         |  401 | 未登录                                                    |
| `FORBIDDEN`                            |  403 | 无权限                                                    |
| `RESOURCE_NOT_FOUND`                   |  404 | 资源不存在或无权访问                                      |
| `IDEMPOTENCY_CONFLICT`                 |  409 | 幂等键冲突                                                |
| `REGISTRATION_NOT_ELIGIBLE`            |  403 | 当前无法完成注册；提示检查邀请码和邮箱，但不细分内部原因  |
| `AGREEMENT_VERSION_INVALID`            |  409 | 当前法律文本版本已变化或不可用；刷新正文后重新同意        |
| `AUTH_VERIFICATION_REQUIRED`           |  403 | 邮箱尚未验证                                              |
| `AUTH_OTP_INVALID_OR_EXPIRED`          |  422 | 验证码错误、过期或已消费                                  |
| `AUTH_OTP_ATTEMPTS_EXCEEDED`           |  429 | 当前验证码错误次数已耗尽                                  |
| `AUTH_OTP_RATE_LIMITED`                |  429 | 认证操作过于频繁                                          |
| `AUTH_VERIFICATION_TICKET_INVALID`     |  401 | 验证上下文已失效                                          |
| `AUTH_MAIL_UNAVAILABLE`                |  503 | 邮件未确认发出，不宣称发送成功                            |
| `AUTH_TEMPORARILY_UNAVAILABLE`         |  503 | 认证保护依赖不可用，可稍后重试                            |
| `RUN_QUOTE_EXPIRED`                    |  409 | 费用报价过期                                              |
| `COST_ACK_REQUIRED`                    |  409 | 历史 quote 确认证据缺失，或内部生成动作证据分支不匹配     |
| `COST_MODEL_UNAVAILABLE`               |  503 | 计价模型未就绪或当前价格不可用                            |
| `CREDIT_ACCOUNT_UNAVAILABLE`           |  503 | 积分账户投影无法安全读取                                  |
| `CREDIT_BALANCE_EMPTY`                 |  409 | 提交 Agent 生图确认前余额为 0；不会调用模型或进入收费链路 |
| `RESERVATION_STATE_INVALID`            |  409 | 预留状态已变化，当前操作不能继续                          |
| `SETTLEMENT_PROTECTED`                 |  409 | Provider 结果仍未确认，禁止自动结算或释放                 |
| `CONCURRENCY_LIMIT_EXCEEDED`           |  429 | 仅兼容历史事件回放；新生成提交不再返回                    |
| `INSUFFICIENT_CREDITS`                 |  402 | 积分不足                                                  |
| `ACCOUNT_FROZEN`                       |  403 | 当前账户已被风控暂时锁定                                  |
| `RATE_LIMITED`                         |  429 | 请求过于频繁，请稍后重试                                  |
| `RESOURCE_BUSY`                        |  409 | 节点/任务占用                                             |
| `PRODUCT_SKU_CONFLICT`                 |  409 | 当前账户已存在相同 SKU/货号                               |
| `PRODUCT_REVISION_CONFLICT`            |  409 | 商品档案已变化，刷新后重试                                |
| `PRODUCT_FACT_VERSION_CONFLICT`        |  409 | 商品事实版本已变化，刷新最新事实后重新确认                |
| `ASSET_UPLOAD_INVALID`                 |  422 | 上传声明、实际类型、大小、图片结构或对象完整性不合法      |
| `ASSET_UPLOAD_EXPIRED`                 |  410 | 上传窗口已过期，需重新选择文件                            |
| `ASSET_NOT_READY`                      |  409 | 素材仍在处理或处理失败，暂不能预览、引用或设为主图        |
| `ASSET_PROCESSING_FAILED`              |  422 | 素材处理失败，可由用户显式重试                            |
| `ASSET_IN_USE`                         |  409 | 素材仍被非终局 turn/workflow 引用，当前不能删除           |
| `REFERENCE_NOT_AVAILABLE`              |  404 | 引用不存在、已失效或无权访问；不泄露具体原因              |
| `MUTATION_OWNER_VIOLATION`             |  403 | 修改权不匹配                                              |
| `PLAN_VALIDATION_FAILED`               |  422 | 候选计划结构或依赖无效；不创建报价或任务                  |
| `CAPABILITY_NOT_AVAILABLE`             |  422 | 当前 Skill、阶段或输入不支持所请求的生成能力              |
| `PROVIDER_UNAVAILABLE`                 |  503 | Provider 不可用                                           |
| `PROVIDER_OUTCOME_UNKNOWN`             |  202 | Provider 结果未知                                         |
| `CONTENT_BLOCKED`                      |  422 | 内容安全拦截                                              |
| `CONTENT_SAFETY_UNAVAILABLE`           |  503 | 内容审核路由、模型或 Provider 不可用；不进入收费生成      |
| `CONTENT_SAFETY_BLOCKED`               |  422 | 内容未通过生成前安全审核；不进入收费生成                  |
| `AGENT_BRAIN_TERMINAL_OUTPUT_INVALID`  |  503 | 创作助手输出格式异常，重试一次后仍失败；按模型故障处理    |
| `ASSET_REVISION_CONFLICT`              |  409 | 素材已发生变化，请刷新后重试                              |
| `MODERATION_ROUTE_MARGIN_INVALID`      |  409 | 审核路由会使 active 图片规格低于毛利门禁，拒绝切换        |
| `ARTIFACT_QUARANTINED`                 |  403 | 产物待人工复核，暂不可访问                                |
| `CONTENT_REVIEW_REVISION_CONFLICT`     |  409 | 内容安全处置已被其他裁决更新，刷新证据后重试              |
| `COMMERCE_EVIDENCE_BLOCKED`            |  422 | 商品事实冲突硬拦                                          |
| `RISK_CONFIRMATION_REQUIRED`           |  409 | 需要风险确认                                              |
| `AGENT_LOOP_LIMIT_EXCEEDED`            |  429 | Agent 循环次数或工具调用次数超限                          |
| `AGENT_REPEATED_TOOL_CALL`             |  409 | 同一 turn 内重复等价工具调用被拦截                        |
| `AGENT_NO_PROGRESS_LOOP`               |  409 | 当前尝试没有取得新进展；提示用户补充信息或换一种要求      |
| `AGENT_REPEATED_TOOL_ERROR`            |  409 | 同一能力连续失败；已停止重复尝试，提示稍后重试或调整要求  |
| `AGENT_BUDGET_EXCEEDED`                |  429 | 当前对话的模型预算已用尽；未进入新的收费生成              |
| `AGENT_CONTEXT_UNAVAILABLE`            |  503 | 当前上下文暂时无法安全读取；提示稍后重试或移除无效引用    |
| `AGENT_SKILL_KNOWLEDGE_REQUIRED`       |  503 | 创作助手所需专业知识未就绪；不猜测回复或进入收费链路      |
| `AGENT_COMPILER_UNAVAILABLE`           |  503 | 生成计划暂时不能安全提交；不创建报价或任务                |
| `AGENT_MODEL_UNAVAILABLE`              |  503 | 创作助手暂时不可用；不猜测回复或进入收费链路              |
| `AGENT_IMAGE_GENERATION_FAILED`        |  503 | 图片生成失败，本次冻结积分已全额退回；可重新发起          |
| `AGENT_IMAGE_OUTCOME_UNKNOWN_RELEASED` |  503 | 图片结果未能确认，冻结积分已全额退回；重生成可能重复出图  |
| `AGENT_TOOL_NOT_ALLOWED`               |  403 | 当前状态或权限不允许使用该能力；不暴露内部工具细节        |
| `AGENT_CONFIRMATION_NOT_AVAILABLE`     |  409 | 当前确认类型尚不可处理；保留用户输入并提示稍后继续        |
| `AGENT_CONFIRMATION_EXPIRED`           |  410 | 本次确认已过期；提示重新发起当前请求                      |
| `TURN_ALREADY_SUBMITTED`               |  409 | turn 已提交生成任务；停止操作应改走 workflow cancel       |
| `TURN_SUPERSEDED`                      |  409 | turn 已被新消息取代                                       |
| `SKILL_SELECTION_REQUIRED`             |  422 | 请选择一个创作 Skill 后再发送                             |
| `SKILL_SELECTION_INVALID`              |  422 | 所选 Skill 或风格当前不可用；刷新列表后重新选择           |
| `SKILL_RESOURCE_LIMIT_EXCEEDED`        |  422 | 所选知识资源超过运行上限；不静默截断或执行                |
| `SKILL_VERSION_DRIFT`                  |  503 | 知识版本校验失败；停止使用并通知运营检查发布包            |
| `SKILL_PACKAGE_UPLOAD_INVALID`         |  422 | 上传对象、类型、大小、hash 或 archive 结构不合法          |
| `SKILL_PACKAGE_VERSION_CONFLICT`       |  409 | 同 package/Skill 精确版本对应不同 digest，禁止覆盖        |
| `SKILL_PACKAGE_VALIDATION_FAILED`      |  422 | 包未通过结构、安全、权利或评测门禁；返回规则摘要          |
| `SKILL_PACKAGE_STATE_INVALID`          |  409 | 当前 package/report 状态不允许该管理操作                  |
| `SKILL_PACKAGE_DISABLED`               |  410 | 包已安全停用；只能安装新版本，不能原地恢复                |
| `SKILL_CATALOG_RELEASE_INVALID`        |  422 | release 依赖闭包、版本、资源或 stage 不完整               |
| `SKILL_CATALOG_REVISION_CONFLICT`      |  409 | active catalog 已变化；刷新 diff 后重新发布               |
| `CANVAS_REVISION_CONFLICT`             |  409 | 画布已被其他标签或请求更新                                |
| `CANVAS_GRAPH_INVALID`                 |  422 | 图 schema、节点或边不合法                                 |
| `CANVAS_CYCLE_DETECTED`                |  422 | DAG 存在环，返回可定位节点/边                             |
| `CANVAS_REFERENCE_INVALID`             |  422 | `@` 引用不属于当前节点输入边                              |
| `CANVAS_INPUT_NOT_READY`               |  409 | 必需上游未就绪或已隔离                                    |
| `CANVAS_COMPILE_STALE`                 |  409 | 画布 revision/输入版本已改变                              |
| `AGGREGATE_NOT_EDITABLE`               |  409 | batch/suite 已提交，不可再改草稿                          |
| `AGGREGATE_REVISION_CONFLICT`          |  409 | batch/suite 草稿已在其他请求更新                          |
| `EXPORT_NOT_READY`                     |  409 | 导出未完成或仍有待处理项                                  |
| `EXPORT_EXPIRED`                       |  410 | 导出打包文件已过期                                        |
| `TEMPLATE_VERSION_RETIRED`             |  410 | 模板版本已下架，禁止新实例化                              |

`AGENT_CALL_OUTCOME_UNKNOWN` 仅是 `agent_trace_steps.error_code`、指标和审计使用的内部恢复分类，不是公网 API 错误码：它表示 LLM 请求可能已经离开本机，但未取得可验证 outcome/usage，因此保留成本 exposure 并禁止复用旧输出。用户只看到上表的 `AGENT_MODEL_UNAVAILABLE` 或 `AGENT_BUDGET_EXCEEDED` 安全摘要；API/SSE 不得暴露该内部分类或据此暗示 Provider 是否收到请求。

Brain 失败仍使用 `AGENT_MODEL_UNAVAILABLE`，但服务端应依据 `03` 的受控诊断选择下列固定摘要，说明原因及下一步。明确上游原因优先于通用 HTTP/流异常；普通 400 不得推定为上下文超限，无明确原因不得推定为超时或模型能力不足。GET turn 与 SSE 使用同一持久化摘要，刷新不得退回泛化提示；历史“创作助手暂时不可用，请稍后重试”保持可回放，不回填未经证明的原因。

| 已知分类                       | 固定公开摘要                                                               |
| ------------------------------ | -------------------------------------------------------------------------- |
| 请求限流                       | 推理模型请求过于频繁，本轮已停止；请稍后重新发送，或更换推理模型           |
| 响应超时                       | 推理模型响应超时，本轮已停止；请稍后重新发送，或更换推理模型               |
| 连接异常                       | 与推理模型的连接异常，未取得完整响应；请稍后重新发送，或更换推理模型       |
| 上下文超限                     | 本次内容超过推理模型容量；请减少图片或对话内容后重新发送                   |
| 通道认证、权限或模型配置       | 推理模型通道配置异常，本轮已停止；请更换推理模型或联系管理员               |
| 通道额度不足                   | 推理模型通道额度不足，本轮已停止；请更换推理模型或联系管理员               |
| 请求不被接受                   | 推理模型未接受本次请求，本轮已停止；请更换推理模型，若仍失败请联系管理员   |
| 服务异常                       | 推理模型服务暂时异常，本轮已停止；请稍后重新发送，或更换推理模型           |
| 返回格式、完整性或用量凭据异常 | 推理模型返回内容不完整或格式异常，本轮已停止；请重新发送，或更换推理模型   |
| 未分类流异常                   | 推理模型响应中途异常结束，未取得完整结果；请稍后重新发送，或更换推理模型   |
| 上游内容拒绝                   | 推理模型未通过本次内容检查，本轮已停止；请调整描述或图片后重新发送         |
| 无可验证原因                   | 未取得推理模型的完整响应，具体原因尚未确认；请稍后重新发送，或更换推理模型 |

仅改变公开解释，不改变三态回执、费用或重试策略；不得公开诊断原文、内部异常码、请求正文、Key、URL 或私有推理，不得把通道额度不足描述成用户积分不足，也不得承诺失败请求未计费。

恢复清扫器达到有界接管上限时，继续使用 `AGENT_MODEL_UNAVAILABLE` 与内部 `processing_recovery_exhausted` 诊断，但公开摘要应明确“本次处理未能恢复，已停止，请重新发送需求”，不将恢复失败描述成模型服务故障。不得释放未知投递的成本 exposure 或自动重投。

图片 workflow 结算失败且没有已发布产物时，`turn.failed` 使用 `AGENT_IMAGE_GENERATION_FAILED` 和固定摘要“图片生成失败，本次冻结的积分已全额退回；请重新发起生成”。若持久化任务原因为 `PROVIDER_OUTCOME_UNKNOWN_EXPIRED`，使用 `AGENT_IMAGE_OUTCOME_UNKNOWN_RELEASED` 和“图片生成结果未能确认，本次冻结的积分已全额退回；重新生成可能产生重复图片”。这些摘要只在释放积分的同一终态事务内发出，不推断上游是否计费；message、SSE、快照共用持久化结论。部分成功仍返回已发布图片及未完成部分退款说明，不改成全额退款或 Brain 故障。新增公开码和摘要统一声明在 shared 契约，API/Web 不另维护白名单。

## 10. 权限校验矩阵

| 操作                  | 游客 | 免费用户 | 会员 |             管理员 |
| --------------------- | ---: | -------: | ---: | -----------------: |
| 浏览模板              |   是 |       是 |   是 |                 是 |
| 查看有效公开分享      |   是 |       是 |   是 |                 是 |
| 生成任务              |   否 |       是 |   是 |                 是 |
| 上传资产              |   否 |       是 |   是 |                 是 |
| 查看自己任务          |   否 |       是 |   是 |                 是 |
| 查看他人任务          |   否 |       否 |   否 |  管理员/运营按权限 |
| 模型熔断              |   否 |       否 |   否 |                 是 |
| 申诉裁决              |   否 |       否 |   否 |                 是 |
| 编辑自己画布          |   否 |       是 |   是 |                 是 |
| 编辑他人画布          |   否 |       否 |   否 | 仅审计查看，不代改 |
| 编辑自己批量/套图草稿 |   否 |       是 |   是 |                 是 |
| 下载自己的导出        |   否 |       是 |   是 |                 是 |

## 11. 审计要求

必须审计：

- 服务端生成动作证据的创建与消费；历史费用确认只保留兼容审计。
- 风险确认。
- Provider 原始回执摘要。
- 申诉裁决。
- 人工冲正。
- 模型熔断和恢复。
- 管理员查看敏感资产。
