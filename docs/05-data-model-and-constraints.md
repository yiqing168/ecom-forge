# 05 数据模型与约束

### 会话设计师快照（2026-10-08，覆盖旧版允许下一 turn 改选规则）

`chat_sessions` 新增可空 `creative_direction_snapshot_json jsonb` 与 `creative_direction_snapshot_hash varchar(64)`，必须同为空或同非空。快照 strict 结构为 `{schema_version:1, selection, resolved_profile?, resolution_turn_id?, resolution_step_id?}`，selection 由 `06` 裁决。只有自动 v3 可包含解析结果，结果必须是 profile 方法 v2，两个来源 ID 同时存在。新会话创建时固定 selection，后续在 session 行锁内核对；自动首次有效规划在 session/turn 写边界内原子保存结果及 hash。旧会话保留 NULL，读取时按该用户该会话全局最新 turn 派生，首次合法继续时固化。禁止修改历史 generation preferences、hash、transcript 或旧 migration。失败/中断/被取代的规划不可解析；并发、重放与重启以存储快照为真相。

### 创作方向快照补充（2026-10-04）

`agent_turns.generation_preferences_json` 增加可选 `creative_direction`，结构由 `06` 裁决，仍是 schema version 2 的向后兼容扩展。现有 `generation_preferences_hash` 覆盖选择及版本，无新增表、字段或迁移。省略时沿用原生行为，不回填历史 JSON 或 hash。创建后选择不可变；新 turn 可改变选择，旧 turn 的重试/恢复必须使用原版本。服务端版本档案保留旧定义，未来修改必须新增版本。

2026-10-07 增加方法 v2，版本 `1 | 2` 均可解析和恢复；仅新选择采用 v2，不批量升级历史偏好、turn、checkpoint 或 hash。方法升级不改变数据库 schema version。

原生 `assistant_output` 的 `tools` 模式可带通过公开文本检查的可选 `commentary`（最多 2000 字符）；`terminal` 模式不可携带。公开说明的 `chat_messages.id` 等于该 transcript item ID，与模型输出及结算同事务写入，恢复通过已有模型来源绑定验证，不重复发布。旧 payload 缺省字段不变，不新增表列或手改历史。

会话图片候选的可选 `source_group` 为 `{message_id, created_at, is_latest_upload}`，仅由服务端从同用户同会话的历史用户消息构造，随 `context_snapshot_json` 及其 hash 冻结。旧快照缺失该字段保持兼容，不推测或回填来源。该扩展不新增数据库列。候选计划的 `scope_decision` 随原生 transcript payload/authoring draft 保存，恢复不得改写本轮范围或增加节点。成功编译后它还须原样进入 `canonical_plan` 并参与 `plan_digest`，由 `run_quotes.plan_snapshot_json` 的既有计划快照保存；旧计划无该字段时不回填、不重算历史 digest。

| 项       | 内容                                                          |
| -------- | ------------------------------------------------------------- |
| 状态     | v0.8 1A generation preferences 与生成动作证据 v2 回写后待复审 |
| 基准     | PRD v1.11、参考工程 `D:\agent\image` 的 Prisma schema         |
| 完成节点 | 编码前                                                        |
| 裁决范围 | 表、字段、枚举、唯一约束、索引、账本不变量、迁移策略          |
| 不裁决   | UI、接口语义、Provider PoC 脚本                               |

## 1. 目标

本文件把 PRD 的核心表落成工程可实现的数据契约。字段命名可以在实际 ORM 中按规范调整，但不变量、关系和唯一约束不得丢失。

## 2. 参考工程可复用模式

`D:\agent\image` 已有多包项目可参考：

- 提交前费用快照、TTL 和幂等模式：可吸收为新项目 `run_quotes`；不吸收旧画布产品形态。
- `Generation` / `GenerationCandidate`：生成任务和候选产物分离。
- `AgentTurn` / `AgentMessage`：Agent 过程状态、消息、工具调用审计。
- `AgentSkill`：Skill 目录、版本、风险标签、必需输入。
- `ModelConfig` / `ProviderKey`：Provider、模型、能力、密钥验证和默认模型。
- `EventOutbox`：按项目顺序事件，支持 SSE 断线恢复。
- `WorkerHeartbeat`：Worker 存活和运维状态。

新项目需要在此基础上新增积分账本、Provider attempt、产物归属和保真审计。

## 3. 核心枚举

```text
trigger_mode: chat | canvas | suite | batch
producer_mode: chat | canvas | suite
mutation_owner: chat_session | canvas | suite
origin_domain: creative | commerce
workflow_run_status: reserved | queued | running | waiting_manual_review | succeeded | failed | cancelling | cancelled | refunding | refunded | disputed
task_status: pending | queued | running | succeeded | failed | cancelled | blocked | waiting_manual_review
task_attempt_status: created | dispatching | accepted | polling | succeeded | failed | timeout | outcome_unknown
dispatch_state: not_dispatched | accepted | outcome_unknown
reservation_status: created | frozen | partially_settled | settled | releasing | released | correction_required
ledger_type: grant | reservation_freeze | consume | release | appeal_refund | manual_correction | expiry
artifact_visibility: private | shared | public | quarantined | deleted
asset_status: uploading | processing | ready | processing_failed | rejected | deleted
asset_upload_status: pending | completed | expired | rejected
evaluation_status: pass | warning | unknown | blocked
content_review_status: pending | released | rejected | expired
content_review_decision: release | reject
content_safety_preflight_status: queued | running | passed | blocked | failed | outcome_unknown | cancelled
risk_decision: confirmed | cancelled
share_report_status: open | reviewing | dismissed | actioned
membership_tier: free | pro | team
membership_source: system_grant | admin_grant | purchase
template_type: recipe | canvas
asset_embedding_status: draft | ready | disabled
referral_reward_status: pending | granted | rejected
platform_rule_status: draft | active | retired
template_unlock_type: free | credits | membership
template_status: draft | published | retired
reference_status: draft | published | retired
favorite_target_type: template | reference
batch_status: draft | quoted | submitted | running | partially_succeeded | succeeded | failed | cancelled
batch_item_status: pending | queued | running | succeeded | failed | cancelled
suite_status: draft | quoted | submitted | running | partially_succeeded | succeeded | failed | cancelled
suite_item_status: pending | queued | running | succeeded | failed | cancelled
export_job_status: queued | running | partially_succeeded | succeeded | failed | expired
export_item_status: queued | running | succeeded | failed | skipped
export_source_type: batch | records | suite | canvas
registration_claim_status: pending | verified | redeemed | released | expired
registration_reward_decision: pending | granted | rejected
mail_delivery_status: queued | sent | delivered | bounced | complained | failed | outcome_unknown
mail_purpose: email_verification | password_reset
queue_dispatch_status: pending | dispatching | dispatched | cancelled
provider_callback_status: queued | processing | processed | dead_letter
provider_circuit_scope: provider | model
provider_circuit_status: closed | open | half_open
skill_kind: primary | auxiliary
skill_visibility: public | internal
skill_resource_type: catalog | planning_view | preset | reference | eval_dataset
skill_package_status: quarantined | uploaded | validating | validation_failed | ready_for_review | approved | disabled | rejected
skill_package_validation_status: queued | running | passed | failed | cancelled
skill_package_risk_status: clear | needs_review | critical
skill_catalog_release_status: draft | published | retired
admin_principal_status: active | disabled
admin_session_status: active | revoked | expired
admin_actor_type: admin_session | bootstrap_cli | system
admin_audit_result: succeeded | failed | blocked
admin_idempotency_status: in_progress | completed | failed
```

`batch` trigger 及 template/reference/batch/suite/export 相关枚举是对应 S18/S20/S22/S25 的前向扩展值；`skill_kind/skill_visibility`、`skill_resource_type.preset`、Skill package/release 枚举由 S08 前向扩展。不要求修改 S02 已提交 migration；启用对应功能前必须先新增 Drizzle 前向 migration、共享类型和契约测试，再开放 API/UI。

## 4. 用户和权限

### users

| 字段                | 类型          | 说明                                              |
| ------------------- | ------------- | ------------------------------------------------- |
| `id`                | uuid          | 主键                                              |
| `email`             | string unique | 邮箱                                              |
| `email_verified_at` | timestamptz?  | 邮箱验证的服务端时间                              |
| `display_name`      | string        | 昵称                                              |
| `role`              | enum          | 用户域 legacy/迁移来源；不是 Admin 授权真相       |
| `risk_status`       | enum          | normal/frozen/limited                             |
| `risk_revision`     | integer       | 风险状态 CAS 版本，初始为 1，每次风险裁决单调递增 |
| `created_at`        | datetime      | 创建时间                                          |
| `updated_at`        | datetime      | Better Auth 维护的更新时间                        |

索引：

- `unique(email)`。
- `index(risk_status)`。
- `risk_status` 与 `risk_revision` 必须在同一条件更新中变更；管理端不得用无版本覆盖写入风险状态。

Better Auth 依赖表由认证框架管理，阶段 0 schema 需声明并迁移其会话、账号和验证相关表，包括但不限于 `auth_sessions`、`auth_accounts`、`auth_verifications`。业务表不直接承载多端登录会话。

`users.email_verified_at` 是邮箱验证的唯一业务真相，不新增第二个 `email_verified boolean`。Better Auth 逻辑字段映射固定为：`null -> false`、非空时间 -> `true`、写 `true` 时设置或保留服务端时间、写 `false` 时置空。编码前必须以 adapter 集成测试证明该映射。

`users.role` 不得签发 Admin Session，也不得作为 `/api/v1/admin/*` 的最终授权依据。独立管理控制面由 S14 的 `admin_principals/admin_credentials/admin_sessions/admin_role_bindings/admin_mfa_recovery_codes` 裁决；普通用户认证域与管理员认证域禁止共享 Session、Cookie 或找回流程。

### admin_principals / admin_credentials / admin_enrollment_tokens / admin_auth_challenges / admin_sessions / admin_role_bindings / admin_mfa_recovery_codes

这些表由 S14 新的 Drizzle 前向 migration 创建，不属于 S08 编码范围：

- `admin_principals`：`id/identifier_hash/identifier_key_id/identifier_hint/display_name/status/authz_version/revision/disabled_reason?/created_at/updated_at`。status 固定 `pending_enrollment | active | disabled`；不要求关联 `users.id`。`disabled` 或 `authz_version` 变化立即使旧 Admin Session 失效。identifier 只按独立 HMAC keyring 查询，不保存可直接登录的明文邮箱/用户名；hint 只能是不可用于登录的受限掩码。
- `admin_credentials`：`id/admin_principal_id/credential_type/credential_public_id?/password_hash?/password_hash_metadata?/secret_ciphertext?/secret_key_id?/status/revision/created_at/rotated_at?`。密码只保存经评审库生成的 Argon2id hash 与参数版本；TOTP secret 只保存 envelope encryption 密文；WebAuthn 保存公开 credential/material，禁止可逆保存密码。一个 principal 同类 active credential 的数量和“最后一个 MFA”保护由条件更新与领域校验共同保证。
- `admin_enrollment_tokens`：`id/admin_principal_id/token_hash/key_id/status/attempt_count/max_attempts/expires_at/claimed_at?/used_at?/revoked_at?/created_by_admin_id/revision/created_at`。status 固定 `issued | claimed | used | revoked | expired`。除首个 super_admin CLI 外，新增管理员必须使用短期一次 enrollment token 自行设置密码和绑定 TOTP；不生成、保存或传递临时密码。明文 token 只在创建响应显示一次，幂等重放不可恢复。`start` 在 principal/token 行锁内从 issued 原子转 claimed；activate 后转 used。claimed 中断只能由另一管理员撤销并重新签发，不能恢复原 token/TOTP secret。
- `admin_auth_challenges`：`id/admin_principal_id/purpose/challenge_token_hash/identifier_rekey_hash?/identifier_rekey_key_id?/status/attempt_count/max_attempts/expires_at/used_at?/created_at`。`identifier_rekey_*` 只保存登录请求中按 active key 计算的 HMAC 摘要，用于 MFA 成功后的 revision CAS 重键，不保存原始 identifier。purpose 固定为 `enrollment_mfa | login_mfa | recovery_mfa | step_up | mfa_rotation`；challenge 使用独立 HMAC hash，只能一次消费，过期/失败达到上限后终局失效，不能换取普通用户 Session。
- `admin_sessions`：`id/admin_principal_id/session_token_hash/csrf_token_hash/csrf_key_id/status/authz_version_snapshot/mfa_level/mfa_verified_at/step_up_at?/recovery_restricted/session_expires_at/idle_expires_at/revoked_at?/created_at/last_seen_at`。Session token 只保存独立 keyed hash；CSRF token 由本次请求 Cookie 中的原始 Session token、session ID 和独立 CSRF derivation key 确定性派生，数据库只保存派生值 hash/key ID 用于一致性检查，因此刷新页面可重新取得同一内存态 token 而无需保存明文。Cookie 与普通用户域隔离；恢复码签发的受限 Session 在完成新 TOTP 绑定前不能执行高风险操作。
- `admin_role_bindings`：`id/admin_principal_id/role_key/scope_type/scope_key/permission_snapshot_hash/revision/created_at/updated_at`。`scope_key` 将无资源 scope 规范化为 `global`，资源 scope 使用其 canonical ID；角色只是 permission 集合来源，Guard 最终校验 active principal/session、MFA、permission 和 scope。
- `admin_mfa_recovery_codes`：`id/admin_principal_id/code_hash/used_at?/created_at`。只保存 keyed hash，单次消费。

至少约束：`unique(identifier_key_id,identifier_hash)`、`unique(admin_sessions.session_token_hash)`、`unique(admin_enrollment_tokens.token_hash)`、`unique(admin_credentials.credential_public_id) where not null`、`unique(admin_auth_challenges.challenge_token_hash)`、`unique(admin_principal_id,role_key,scope_type,scope_key)`，以及 active session 查询索引 `(admin_principal_id,status,session_expires_at)`、challenge/enrollment 清理索引 `(status,expires_at)`。同一 principal 同 credential type 的 active/pending 数量和同一 principal 的 issued/claimed enrollment 数量由事务行锁、条件更新和可表达的唯一约束共同保护。所有可能改变 active super_admin 集合或其有效 MFA 的事务先获取同一固定 transaction advisory lock，再重读并证明提交后仍至少有一个可用 super_admin；不能用无锁 count 或只靠前端。管理账号不开放公网自助注册、普通用户密码找回或社交登录。

identifier 登录查询必须对当前及仍在验证窗口内的历史 HMAC keyring 计算候选 hash，不得因 active key 轮换锁死旧管理员。密码 + MFA 成功后可在 principal 行锁内以 revision CAS 把 hash/key ID 重写到 active key；若新 hash 已被其他 principal 占用则 fail closed 并告警，不合并身份。keyring 退役前必须证明所有 active/pending principal 已重键或完成受控重新开通。

### auth_verifications

由 Better Auth `emailOTP` 插件拥有验证码生命周期，应用只通过认证模块访问：

- OTP 只保存 `HMAC-SHA-256(AUTH_OTP_HASH_SECRET, otp)` 或插件支持的等价 keyed hash，禁止明文、可逆加密和无密钥快速 hash。
- verification identity 必须隔离 `email_verification` 与 `password_reset` purpose。
- 单 OTP 有效期 10 分钟、最多错误 5 次、成功后一次性消费；轮换后旧 OTP 立即失效。
- 不得把 OTP 写入审计日志、事件、队列或邮件投递记录。

### registration_claims

本节及 `registration_reward_claims`、`mail_deliveries`、`queue_dispatch_intents` 已由 S03 前向 migration 创建；S05 复用既有队列意图表。不得修改、重命名或删除 S02/S03 已提交或已应用的 migration。

发注册 OTP 前对邀请码容量做短期占位；claim 不是用户账号，也不是正式核销。

| 字段                    | 类型          | 说明                                       |
| ----------------------- | ------------- | ------------------------------------------ |
| `id`                    | uuid          | 主键，也是 ticket 的服务端引用             |
| `invite_code_id`        | uuid          | 邀请码                                     |
| `user_id`               | uuid?         | 注册完成事务创建的正式用户                 |
| `email_hash`            | string        | canonical email 的独立 HMAC                |
| `pending_email`         | varchar(320)? | 仅供完成注册使用的规范化邮箱；终局后清空   |
| `pending_display_name`  | varchar(120)? | 仅供完成注册使用的昵称；终局后清空         |
| `pending_password_hash` | text?         | Better Auth 密码哈希，禁止明文；终局后清空 |
| `agreement_version`     | varchar(64)?  | 注册申请固定的协议版本；历史行可为空       |
| `ticket_hash`           | string?       | verification ticket 的独立 HMAC            |
| `ticket_nonce`          | string?       | 非敏感随机 nonce，用于幂等重算             |
| `ticket_version`        | int           | 成功重发后递增                             |
| `status`                | enum          | pending/verified/redeemed/released/expired |
| `idempotency_key`       | string        | 首次注册幂等键                             |
| `request_hash`          | string        | 规范化注册 payload 摘要，用于幂等冲突检测  |
| `expires_at`            | timestamptz   | claim 最长有效期，初始 30 分钟             |
| `created_at`            | timestamptz   | 创建                                       |
| `updated_at`            | timestamptz   | 更新                                       |

约束：

- `unique(idempotency_key)`。
- `unique(ticket_hash) where ticket_hash is not null`。
- 同一 `email_hash` 只能有一个 active `pending/verified` claim；`verified` 仅为历史迁移兼容状态，新流程不得写入。使用显式 active 标识或可由状态表达的 partial unique index，禁止在索引谓词中使用 `now()`。
- 邀请码行锁内按 `used_count + active_claim_count < max_uses` 创建 claim；过期 pending claim 先原子转 `expired` 再创建新 claim。
- 新流程在 OTP 校验成功事务中直接创建已验证用户与 credential account、正式核销邀请码、发放注册送积分并把 claim 从 `pending` 转为 `redeemed`；不得暴露 `verified` 中间态或依赖后置 finalizer。
- `pending_email/pending_display_name/pending_password_hash` 只允许 `pending` claim 非空；`redeemed/expired/released` 必须清空这些字段以及 ticket。密码哈希按密码凭据处理，不进入日志、审计、事件或 API 响应。

### reward_campaigns

S14 将注册赠送从环境开关提升为版本化活动，但所有赠送仍只经 `packages/credit` 追加 ledger：

| 字段                      | 类型          | 说明                                                  |
| ------------------------- | ------------- | ----------------------------------------------------- |
| `id`                      | uuid          | 主键                                                  |
| `campaign_key`            | string        | 稳定活动 key                                          |
| `version_no`              | int           | 同 key 递增版本                                       |
| `kind`                    | enum          | registration/invitation；S14 不以奖励活动替代人工冲正 |
| `status`                  | enum          | draft/active/disabled；disabled 终局                  |
| `grant_credits`           | numeric(18,2) | 单次赠送积分，string 读写                             |
| `max_grants`              | int           | 最大成功 grant 数                                     |
| `budget_credits`          | numeric(18,2) | 活动积分总预算                                        |
| `granted_count`           | int           | 成功 grant 数投影，须可由 claim 对账                  |
| `granted_credits`         | numeric(18,2) | 已赠积分投影，须可由 ledger 对账                      |
| `starts_at/expires_at`    | timestamptz?  | 活动窗口                                              |
| `eligibility_policy_json` | json          | strict 资格规则版本，不允许脚本                       |
| `revision`                | int           | expected revision                                     |
| `created_by_admin_id`     | uuid?         | 管理员；legacy bootstrap 可空                         |
| `created_at/activated_at` | timestamptz?  | 生命周期时间；created_at 必填                         |

约束：`unique(campaign_key,version_no)`；同 key 最多一个 active version。激活后金额、预算和资格规则不可更新；变更创建新 version。grant 前在 campaign 行锁内同时校验窗口、状态、`max_grants` 和 `budget_credits`，成功 claim、ledger、账户投影与 campaign 投影同事务；停用不回滚已发积分。

### registration_reward_claims

邮箱验证成功不等于无条件发奖励。本表记录活动维度的反刷裁决：

| 字段                        | 类型        | 说明                          |
| --------------------------- | ----------- | ----------------------------- |
| `id`                        | uuid        | 主键                          |
| `campaign_key`              | string      | 奖励活动版本                  |
| `reward_campaign_id`        | uuid?       | S14 精确活动版本；legacy 可空 |
| `user_id`                   | uuid        | 用户                          |
| `mailbox_fingerprint`       | string      | 奖励邮箱族的独立 HMAC         |
| `fingerprint_key_id`        | string      | HMAC key 版本                 |
| `fingerprint_rules_version` | string      | Gmail/relay 等规则版本        |
| `device_hash`               | string?     | 风险信号，不保存原始设备信息  |
| `ip_prefix_hash`            | string?     | 风险信号，不保存原始 IP       |
| `decision`                  | enum        | pending/granted/rejected      |
| `reason_code`               | string?     | 脱敏裁决原因                  |
| `ledger_id`                 | uuid?       | granted 时关联注册赠送流水    |
| `created_at`                | timestamptz | 创建                          |
| `updated_at`                | timestamptz | 更新                          |

约束：

- `unique(campaign_key, user_id)`。
- `unique(campaign_key, mailbox_fingerprint)`。
- reward claim 转 `granted`、注册赠送 ledger 和余额投影必须在同一事务内完成，只能通过 `packages/credit` 写账本。

## 5. 积分账本

### credit_accounts

| 字段         | 类型        | 说明         |
| ------------ | ----------- | ------------ |
| `user_id`    | uuid unique | 用户         |
| `balance`    | decimal     | 可用余额投影 |
| `frozen`     | decimal     | 冻结余额投影 |
| `version`    | int         | 乐观锁       |
| `updated_at` | datetime    | 更新时间     |

### credit_reservations

| 字段               | 类型               | 说明     |
| ------------------ | ------------------ | -------- |
| `id`               | uuid               | 主键     |
| `user_id`          | uuid               | 用户     |
| `workflow_run_id`  | uuid? unique       | 工作流   |
| `estimated_amount` | decimal            | 预估冻结 |
| `settled_amount`   | decimal            | 已结算   |
| `released_amount`  | decimal            | 已释放   |
| `status`           | reservation_status | 状态     |
| `idempotency_key`  | string unique      | 幂等键   |
| `created_at`       | datetime           | 创建     |

### credit_ledger

| 字段              | 类型          | 说明                                         |
| ----------------- | ------------- | -------------------------------------------- |
| `id`              | uuid          | 主键                                         |
| `user_id`         | uuid          | 用户                                         |
| `type`            | ledger_type   | 流水类型                                     |
| `amount`          | decimal       | 正负金额                                     |
| `reservation_id`  | uuid?         | 关联预留                                     |
| `workflow_run_id` | uuid?         | 关联运行                                     |
| `task_id`         | uuid?         | 关联任务                                     |
| `appeal_id`       | uuid?         | 关联申诉                                     |
| `idempotency_key` | string unique | 幂等键                                       |
| `account_version` | int?          | 账户内资金顺序；旧流水迁移期可空，新写入必填 |
| `balance_after`   | decimal       | 写入后余额快照                               |
| `frozen_after`    | decimal       | 写入后冻结快照                               |
| `metadata`        | json          | 审计信息                                     |
| `created_at`      | datetime      | 创建                                         |

不变量：

- 不直接修改 `credit_accounts` 作为业务事实。
- 任何余额变化必须有 `credit_ledger`。
- `credit_accounts.balance/frozen` 可通过 `credit_ledger` 重放校验。
- 写资金前，除核对账户版本与末条投影，还须对已版本化流水按类型、amount 逐笔计算 balance/frozen 并核对每条快照，错误符号、负投影或中间漂移均拒绝本次写入。历史空版本前缀仍按既有快照兼容重建作为起点，不改写历史，也不声称它已有逐笔金额验证。
- 资金重放按 `(user_id, account_version)` 递增，不按 `created_at` 推断写入顺序；`created_at` 只用于展示和时间筛选。S04 前向 migration 为新流水增加 `account_version`，并建立 `unique(user_id, account_version) where account_version is not null`；历史空值仅作迁移兼容，新写入必须等于锁定账户的 `version + 1`。
- `amount` 使用账户视角：增加可用余额为正数，减少可用余额为负数。
- 冻结、解冻和消费的记账方向固定：`reservation_freeze.amount` 为负数，`release.amount` 为正数，`consume.amount` 为负数。
- 每次冻结只写一条 `reservation_freeze` 流水；每次解冻只写一条 `release` 流水；每次结算只写一条 `consume` 流水，不允许实现自行选择符号或双写策略。

## 6. 计划和工作流

### run_quotes

用于保存提交前费用报价和服务端编译快照。它不是用户侧规划或确认流程；任何生成入口都不展示费用卡，quote 由服务端根据已鉴权生成动作证据提交。

| 字段                      | 类型         | 说明                                                           |
| ------------------------- | ------------ | -------------------------------------------------------------- |
| `id`                      | uuid         | 主键                                                           |
| `user_id`                 | uuid         | 用户                                                           |
| `source`                  | enum         | chat/canvas/suite；batch 由 S18 前向扩展                       |
| `source_id`               | uuid?        | chat 时为 agent turn；其他入口为其持久化聚合                   |
| `product_id`              | uuid?        | 关联商品档案                                                   |
| `workflow_run_id`         | uuid? unique | 关联运行                                                       |
| `status`                  | enum         | quoted/submitted/superseded/cancelled/expired                  |
| `prompt_preview`          | json         | 给用户看的摘要                                                 |
| `items_snapshot`          | json         | 给用户展示的费用项快照，不含执行参数                           |
| `estimated_call_count`    | int          | 预估调用数                                                     |
| `estimated_total_credits` | decimal      | 预估积分                                                       |
| `has_unknown_price`       | boolean      | 是否有未知价格                                                 |
| `idempotency_key`         | string       | 提交幂等键                                                     |
| `input_signature`         | string       | 用户、入口、Skill、引用、参数和费用版本 hash                   |
| `submission_mode`         | enum?        | 新生成任务固定 auto_submit；confirmation_required 仅兼容历史行 |
| `plan_digest`             | sha256?      | canonical plan digest；S09 新行必填                            |
| `authorization_digest`    | sha256?      | chat turn 授权 digest；S09 chat 新行必填                       |
| `confirmation_snapshot`   | json         | 历史兼容字段；新生成任务写空对象，不作为 UI 或授权证据         |
| `plan_snapshot`           | json         | 服务端编译后的可执行计划快照                                   |
| `skill_snapshot`          | json         | 服务端解析后的 Skill 快照                                      |
| `pricing_snapshot`        | json         | 计价规则、模型版本和成本版本快照                               |
| `confirmed_at`            | datetime?    | 服务端提交 quote 的时间；不表示弹窗确认                        |
| `expires_at`              | datetime     | 过期时间                                                       |

约束：

- `unique(idempotency_key)`。
- `unique(user_id, source, input_signature)` where status=`quoted`；submitted 历史报价不参与该旧 S04 去重索引。S09 Agent quote 另由 `unique(source,source_id)` 在 quoted/submitted 状态兜底。
- `unique(source, source_id)` where `source='chat' and source_id is not null and status in ('quoted','submitted')`，并保留 `agent_turns.run_quote_id` 唯一约束作为双向一致性兜底；chat quote 的 `source_id` 必须等于关联 turn ID。历史 `expired/superseded/cancelled` 不阻塞同一 turn 的后续合法 quote；不得把该约束扩大到 canvas/suite，同一持久化聚合的不同 revision 允许新 quote。
- `workflow_run_id` 在同一事务内可先空后回填，不能长期悬空。
- `status` 允许 `superseded`，用于新 turn 或新报价覆盖旧报价。
- `plan_snapshot`、`skill_snapshot`、`pricing_snapshot` 由 S04 前向 migration 增加，默认空对象仅用于历史行兼容；新 quote 必须写入非空服务端快照，禁止客户端提供或覆盖。
- `items_snapshot` 由 S04 前向 migration 增加，默认空数组仅用于历史行兼容；新 quote 必须单独写入对用户展示的费用项，禁止继续塞入 `prompt_preview`，也不得包含 Provider 参数或执行快照。
- S09 以新的 Drizzle migration 前向增加 `source_id/submission_mode/plan_digest/authorization_digest`，不修改历史 migration。S09 新 quote 必须有 `submission_mode + plan_digest`；chat quote 还必须有 `source_id + authorization_digest`，非 chat 的 authorization digest 必须为空。
- `index(status, expires_at)` 支持服务端到期收敛；Agent quote 的延迟 expiry intent 是主恢复路径，索引扫描只作告警/补偿，不得替代 intent 幂等语义。

### workflow_runs

| 字段               | 类型                | 说明                                     |
| ------------------ | ------------------- | ---------------------------------------- |
| `id`               | uuid                | 主键                                     |
| `user_id`          | uuid                | 用户                                     |
| `product_id`       | uuid?               | 关联商品档案                             |
| `trigger_mode`     | enum                | chat/canvas/suite；batch 由 S18 前向扩展 |
| `run_quote_id`     | uuid?               | 费用报价                                 |
| `reservation_id`   | uuid?               | 积分预留                                 |
| `status`           | workflow_run_status | 状态                                     |
| `revision`         | integer             | 状态 CAS 版本，初始为 1                  |
| `plan_snapshot`    | json                | 完整计划快照                             |
| `skill_snapshot`   | json                | Skill 快照                               |
| `pricing_snapshot` | json                | 计价快照                                 |
| `created_at`       | datetime            | 创建                                     |
| `finished_at`      | datetime?           | 完成                                     |

约束：

- `unique(run_quote_id)`，可为空。
- `unique(reservation_id)`，可为空。
- `index(user_id,status,created_at)`。
- 每次 workflow 状态推进必须在同一条件更新中令 `revision + 1`；管理取消必须提交 `expected_run_revision`。
- 旧数据或人工补录可以为空；阶段 0 新建收费运行时，`run_quote_id` 和 `reservation_id` 必须同时存在。
- 新建收费运行时 `run_quote_id` 和 `reservation_id` 应同时存在；`reservation_id` 通过同一事务关联预留，不能出现无预留的收费执行态。

## 7. 任务和 Provider attempt

### tasks

| 字段              | 类型          | 说明                                                                        |
| ----------------- | ------------- | --------------------------------------------------------------------------- |
| `id`              | uuid          | 主键                                                                        |
| `workflow_run_id` | uuid          | 工作流                                                                      |
| `parent_task_id`  | uuid?         | 上游；明确单图重试时可跨 workflow 指向被重试的终局 task，形成不可变重试血缘 |
| `batch_item_id`   | uuid?         | 1B 批量条目；S18 前向字段                                                   |
| `suite_item_id`   | uuid?         | 2B 套图条目；S22 前向字段                                                   |
| `type`            | string        | 工具/模型任务类型                                                           |
| `status`          | task_status   | 状态                                                                        |
| `model_id`        | uuid?         | 模型注册                                                                    |
| `model_version`   | string?       | 模型版本                                                                    |
| `cost_estimate`   | decimal       | 预估成本                                                                    |
| `cost_actual`     | decimal?      | 实际成本                                                                    |
| `idempotency_key` | string unique | 幂等                                                                        |
| `dag_node_id`     | string        | 计划节点 ID                                                                 |
| `dag_json`        | json          | 可审计 DAG 快照                                                             |
| `params_snapshot` | json          | 参数                                                                        |
| `error_code`      | string?       | 错误码                                                                      |
| `error_message`   | string?       | 错误摘要                                                                    |
| `created_at`      | datetime      | 创建                                                                        |
| `started_at`      | datetime?     | 开始                                                                        |
| `ended_at`        | datetime?     | 结束                                                                        |

### agent_turns

S08 会话历史扩展新增 `execution_format string not null default 'legacy_v1'`，只允许 `legacy_v1 | transcript_v1`；以及 `transcript_capture_version int?`，只允许 null 或 1。API 创建时冻结二者，confirm、重试、lease 接管和进程升级均不得原地改写。历史行保持 `legacy_v1/null`；影子期新行是 `legacy_v1/1`；通过切读门槛后新行才是 `transcript_v1/1`。这两个字段不增加业务状态，也不由请求/队列 payload 指定。

| 字段                            | 类型         | 说明                                                                                                                                                                                                                      |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                            | uuid         | 主键                                                                                                                                                                                                                      |
| `session_id`                    | uuid         | 会话                                                                                                                                                                                                                      |
| `user_id`                       | uuid         | 用户                                                                                                                                                                                                                      |
| `status`                        | enum         | received_user_input/loading_context/detecting_intent/validating_context/clarifying/planning/plan_ready/waiting_user_confirmation/run_quote_created/waiting_provider_confirmation/done/blocked/failed/cancelled/superseded |
| `revision`                      | int          | 默认 1；状态、owner、确认和 supersede 的 CAS 版本                                                                                                                                                                         |
| `continuation_no`               | int          | 默认 1；每次有效确认后递增                                                                                                                                                                                                |
| `primary_skill_id`              | string?      | 用户显式选择的精确 primary `slug@version`；审计/诊断标识，不建立 `skills.id` 外键，仅 S08 前 legacy 行允许为空                                                                                                            |
| `skill_selection_snapshot_json` | json?        | strict 不可变 primary/Preset/dependency/catalog 快照；不含 Skill 正文，S08 新行必填                                                                                                                                       |
| `skill_selection_snapshot_hash` | sha256?      | canonical selection snapshot hash；S08 新行必填                                                                                                                                                                           |
| `model_selection_snapshot_json` | json?        | strict 产品模型选择：catalog revision 与 brain/image/video entry ID+version；不含 Provider/价格/Key，S11 激活后新行必填                                                                                                   |
| `model_selection_snapshot_hash` | sha256?      | canonical 产品模型选择 hash；进入 create request、Compiler context 和模型复核，S11 激活后新行必填                                                                                                                         |
| `generation_preferences_json`   | json?        | strict 用户生成偏好：`schema_version=2/output_kind/aspect_ratio/resolution_tier`；比例为具体 `W:H` 或 `auto`，不含图片张数，是本 turn 约束，不是 Provider 参数或报价                                                      |
| `generation_preferences_hash`   | sha256?      | canonical 生成偏好 hash；进入 create request、Brain context 与 Compiler requirements，S11 激活后新行必填                                                                                                                  |
| `execution_authorization_json`  | json?        | strict 不可变生成动作证据：`schema_version=2/kind=generate_action/create_request_hash/policy_version`；由 API 派生，不含用户费用模式或金额上限；S09 新行必填，legacy 可空                                                 |
| `execution_authorization_hash`  | sha256?      | 生成动作证据 canonical hash；进入 Compiler context 与自动提交幂等键；S09 新行必填，legacy 可空                                                                                                                            |
| `create_idempotency_key`        | string?      | create 的用户级幂等键；仅 S08 前 legacy 行允许为空                                                                                                                                                                        |
| `create_request_hash`           | sha256?      | 规范化 create 请求 hash；仅 S08 前 legacy 行允许为空                                                                                                                                                                      |
| `create_response_json`          | json?        | 首次 create 的不可变响应快照；仅 S08 前 legacy 行允许为空                                                                                                                                                                 |
| `interrupt_idempotency_key`     | string?      | 首次成功 interrupt 的用户级幂等键                                                                                                                                                                                         |
| `interrupt_request_hash`        | sha256?      | 规范化 `turn_id + strict interrupt body` hash                                                                                                                                                                             |
| `interrupt_response_json`       | json?        | 首次成功 interrupt 的不可变响应快照                                                                                                                                                                                       |
| `context_snapshot_json`         | json?        | 当前 continuation 的 ID、版本、hash、选择原因和预算；多轮改图可包含服务端冻结的会话图片候选、稳定序号与 lineage，但不含图片二进制、完整 prompt/正文/URL；首次 Worker 固化前允许为空                                       |
| `context_snapshot_hash`         | sha256?      | 当前 continuation 上下文指纹                                                                                                                                                                                              |
| `processing_owner`              | string?      | Worker 随机 owner token                                                                                                                                                                                                   |
| `processing_lease_expires_at`   | timestamptz? | processing lease；与 owner 成对                                                                                                                                                                                           |
| `run_quote_id`                  | uuid?        | 费用报价                                                                                                                                                                                                                  |
| `workflow_run_id`               | uuid?        | 工作流                                                                                                                                                                                                                    |
| `superseded_by_turn_id`         | uuid?        | 替代 turn                                                                                                                                                                                                                 |
| `interrupted_at`                | timestamptz? | 用户主动中断时间                                                                                                                                                                                                          |
| `confirmed_at`                  | timestamptz? | 最近一次有效确认时间                                                                                                                                                                                                      |
| `created_at`                    | timestamptz  | 创建                                                                                                                                                                                                                      |
| `ended_at`                      | timestamptz? | 结束                                                                                                                                                                                                                      |

约束：

- `index(session_id, created_at)`。
- `index(user_id, status, created_at)`。
- `unique(user_id, create_idempotency_key)` where key not null；create key/request hash/response 必须全部为空或全部存在。S08 Service 新行必须全部存在，全空只兼容 legacy 行，response 写入后不可更新。
- `unique(user_id, interrupt_idempotency_key)` where key not null；interrupt request hash 必须包含路由 `turn_id` 与 strict body，避免同一用户把相同 key/body 打到另一 turn 时错误重放。interrupt key/request hash/response 必须同时为空或同时存在，response 写入后不可更新。
- `primary_skill_id/skill_selection_snapshot_json/skill_selection_snapshot_hash` 必须全部为空或全部存在；全空只兼容 S08 前 legacy 行。S08 Service 新行必须全部存在，snapshot/hash 创建后不可更新。
- `model_selection_snapshot_json/model_selection_snapshot_hash` 必须同时为空或同时存在；S11 激活前 legacy/local fake 可空，激活后 staging/beta/production 新 turn 必填且创建后不可更新。brain entry 必填，image/video 按 primary capability 可空；所有 entry 只保存产品 catalog ID/version/revision，服务端 context 另行解析不可变 model/SKU closure。
- `generation_preferences_json/generation_preferences_hash` 必须同时为空或同时存在；S11 新 turn 必填且创建后不可更新。1A 固定 `schema_version=2/output_kind=image`、`resolution_tier=1k|2k|4k`，比例使用规范化正整数比值或字面量 `auto`，禁止携带 `output_count`。固定比例是用户硬约束；`auto` 只授权 Brain 在所选模型规格支持范围内为每个图片 candidate 节点选择具体比例，Compiler 冻结具体值后才允许进入 task/Provider。图片张数由 Brain 写入 candidate，Compiler 必须按 Skill 默认、所选 image entry capability 和平台单 turn 上限重校验。偏好只约束 Brain/Compiler，不能直接当作 Provider payload、SKU 或费用真相。
- `execution_authorization_json/execution_authorization_hash` 必须同时为空或同时存在；S09 Service 新行必须同时存在，snapshot/hash 创建后不可更新。1A 只接受 API 从已鉴权幂等生成动作派生的 `generate_action@v2`，其 `create_request_hash/policy_version` 必须与 turn 真相一致；禁止持久化客户端自报的费用模式或金额上限。
- 内置 Skill 的 `primary_skill_id` 由工程内容 loader 按 slug 解析当前版本，不依赖 `skills`、package、release 或审批数据；外部 Skill 的 kind/status/stage/definition hash 由创建 turn 的领域事务及 Worker selection snapshot 闭包重校验并固化。
- `revision > 0`、`continuation_no > 0`；`processing_owner` 与 `processing_lease_expires_at` 必须同时为空或同时非空。
- `context_snapshot_json/context_snapshot_hash` 必须同时为空或同时存在，并以 turn owner/revision/continuation CAS 写入。
- 每个 session 至多一个 `workflow_run_id is null` 且 status 非终局的 turn；Service 仍先锁 `chat_sessions`，部分唯一约束只作并发兜底。
- `unique(run_quote_id)` where `run_quote_id is not null`。
- `unique(workflow_run_id)` where `workflow_run_id is not null`。

### agent_turn_confirmations

| 字段                    | 类型         | 说明                                          |
| ----------------------- | ------------ | --------------------------------------------- |
| `id`                    | uuid         | 主键                                          |
| `turn_id`               | uuid         | Agent turn                                    |
| `user_id`               | uuid         | 用户隔离                                      |
| `confirmation_no`       | int          | turn 内递增                                   |
| `type`                  | enum         | clarification/product_facts/cost/risk         |
| `status`                | enum         | pending/answered/expired/superseded/cancelled |
| `answer_schema_version` | int          | 服务端 answer schema 版本                     |
| `public_payload_json`   | json         | 可展示表单/摘要，不含内部规则                 |
| `payload_digest`        | sha256       | 服务端确认快照 hash                           |
| `answer_json`           | json?        | 通过 strict schema 的答案                     |
| `idempotency_key`       | string?      | 首次有效回答的用户级幂等键                    |
| `request_hash`          | sha256?      | 规范化 `turn_id + strict confirm body` hash   |
| `response_json`         | json?        | 首次有效 confirm 的不可变响应                 |
| `expires_at`            | timestamptz  | 服务端过期时间                                |
| `answered_at`           | timestamptz? | 回答时间                                      |
| `created_at`            | timestamptz  | 创建                                          |

约束：

- `unique(turn_id, confirmation_no)`；`unique(user_id,idempotency_key)` where key not null。
- `index(status,expires_at)`、`index(turn_id,created_at)`。
- confirm request hash 必须包含路由 `turn_id` 与 strict body；同一用户复用 key 到另一 turn/confirmation 必须命中 `IDEMPOTENCY_CONFLICT`，不能重放旧 turn 响应。
- `answered` 必须同时具有 answer/idempotency key/request hash/response/answered_at；其他状态不得伪装为已回答。response 写入后不可更新。
- type/version/payload digest/expiry 由服务端裁决；前端缓存和模型输出不能修改。

### task_attempts

| 字段                     | 类型                | 说明              |
| ------------------------ | ------------------- | ----------------- |
| `id`                     | uuid                | 主键              |
| `task_id`                | uuid                | 任务              |
| `attempt_no`             | int                 | 第几次            |
| `status`                 | task_attempt_status | 状态              |
| `dispatch_state`         | dispatch_state      | 投递状态          |
| `provider`               | string              | Provider          |
| `provider_request_id`    | string?             | Provider 请求 ID  |
| `provider_receipt`       | json                | 回执摘要          |
| `provider_reported_cost` | decimal?            | Provider 报告成本 |
| `raw_error_summary`      | json?               | 错误摘要          |
| `started_at`             | datetime?           | 开始              |
| `accepted_at`            | datetime?           | Provider 确认受理 |
| `last_polled_at`         | datetime?           | 最近轮询时间      |
| `next_poll_at`           | datetime?           | 下次轮询时间      |
| `poll_count`             | int                 | 已完成轮询次数    |
| `ended_at`               | datetime?           | 结束              |

约束：

- `unique(task_id, attempt_no)`。
- `unique(provider, provider_request_id)` where `provider_request_id is not null`。
- `index(task_id,status)`。
- `index(dispatch_state,started_at)`。
- `index(status,next_poll_at)` where `status in ('accepted','polling')`。
- `poll_count >= 0`；非 polling 状态允许 `next_poll_at` 为空，poll Consumer 只能按 DB 当前状态和计数推进。
- 创建新 attempt 时必须在同一事务锁定目标 task 行，重新校验 task 与最新 attempt 状态，再以 `max(attempt_no) + 1` 分配序号；首个 attempt 为 `1`。
- `unique(task_id, attempt_no)` 是并发兜底，不允许在无 task 行锁的条件下先查 max 再写。
- 同一 task execution intent 在 task 行锁内发现已有当前 attempt 时必须复用；后续公网 retry 的请求幂等由统一写接口幂等层负责。`accepted/polling/outcome_unknown` 不得由恢复扫描自动创建新的 Provider attempt。

### provider_callback_events

保存验签成功后的 Provider callback 真相和 dead letter；不保存 raw body、签名、完整输出 URL 或厂商原始错误。

| 字段                      | 类型                     | 说明                                          |
| ------------------------- | ------------------------ | --------------------------------------------- |
| `id`                      | uuid                     | 主键，也是 callback queue aggregate           |
| `provider`                | string                   | allowlisted Provider                          |
| `dedup_key`               | string                   | event ID 或 canonical body digest 的稳定 HMAC |
| `provider_event_id_hint`  | string?                  | 非敏感、不可用于鉴权的事件 ID 提示            |
| `provider_request_id`     | string?                  | 归一化 Provider 请求 ID                       |
| `task_attempt_id`         | uuid?                    | 匹配后的 attempt                              |
| `status`                  | provider_callback_status | 处理状态                                      |
| `normalized_payload_json` | json                     | 通过 schema 的最小回执                        |
| `raw_summary_json`        | json                     | HTTP 状态族/厂商 code hash 等脱敏摘要         |
| `signature_key_id`        | string                   | 验签 key 版本，不含 secret                    |
| `body_digest`             | string                   | 原始 body 的 keyed digest                     |
| `error_code`              | string?                  | 稳定 dead-letter/处理错误码                   |
| `processing_count`        | int                      | 已完成 callback 归并次数                      |
| `next_process_at`         | timestamptz?             | retryable dead letter 的下次归并时间          |
| `received_at`             | timestamptz              | 服务端接收时间                                |
| `processed_at`            | timestamptz?             | 终态处理时间                                  |

约束：

- `unique(provider, dedup_key)`，重复 webhook 复用原记录并返回相同泛化响应。
- `processing_count >= 0`；每个处理 intent 的 `processing_no` 必须等于当前 `processing_count + 1`。
- `index(status, next_process_at)`、`index(provider, provider_request_id)`、`index(task_attempt_id, received_at)`。
- callback event 与首个 `provider.callback.process(processing_no=1)` queue intent 在同一短事务创建；无法匹配、非法终态或 outcome_unknown 后迟到回执转 `dead_letter`，不得删除或自动结算。只有 retryable unmatched 可按 `processing_count + 1` 创建新 intent；永久非法/迟到事件不重放。
- `normalized_payload_json/raw_summary_json` 使用白名单 schema；禁止存 raw body、headers、签名、Key、prompt、对象 key、签名 URL、图片二进制或完整厂商错误。

### provider_circuit_states

保存 Provider/model 运行时熔断控制真相；`models.status` 继续表达 PoC/人工准入，不承担瞬时 circuit 状态。

| 字段                | 类型                    | 说明                                            |
| ------------------- | ----------------------- | ----------------------------------------------- |
| `id`                | uuid                    | 主键                                            |
| `scope_type`        | provider_circuit_scope  | provider/model                                  |
| `scope_key`         | string                  | `provider:{id}` 或 `model:{uuid}` canonical key |
| `provider`          | string                  | Provider                                        |
| `model_id`          | uuid?                   | model scope 时必填                              |
| `status`            | provider_circuit_status | closed/open/half_open                           |
| `revision`          | int                     | CAS 版本                                        |
| `reason_code`       | string?                 | 稳定原因                                        |
| `window_started_at` | timestamptz             | 当前统计窗口开始                                |
| `sample_count`      | int                     | 样本数                                          |
| `failure_count`     | int                     | 确定失败数                                      |
| `unknown_count`     | int                     | outcome_unknown 数                              |
| `opened_at`         | timestamptz?            | 打开时间                                        |
| `probe_after`       | timestamptz?            | open 时为最早探针时间；half-open 时为租约截止   |
| `probe_owner`       | string?                 | 单探针 owner token                              |
| `updated_at`        | timestamptz             | 更新时间                                        |

约束：

- `unique(scope_key)`、`index(status, probe_after)`、`index(provider, status)`。
- `revision >= 0` 且所有计数非负；model scope 要求 `model_id is not null`，provider scope 要求 `model_id is null`。
- 状态/计数/owner 变更使用 `scope_key + expected_revision` CAS；half-open 同一时刻只允许一个 probe owner。
- open 领取 probe 时把 `probe_after` 原子改写为服务端 `now +` 不可变 model snapshot 中的 `circuit_open_ms`，作为 half-open 租约截止；provider scope 的后续检查只读取持久化截止，不按另一个模型参数重算。租约过期必须在行锁内以 revision CAS 转回 open，清空 `probe_owner`，写 `reason_code=half_open_probe_timeout`，并从恢复时刻重算 `probe_after`；该次检查不得同时领取新 probe。
- 受控人工恢复允许以同一 CAS 语义将 open 或租约已过期/无有效租约的 half-open 转为 closed 并清空窗口/owner；有效租约内的 half-open 不得强制恢复。运行时或人工 circuit 恢复均不得修改 `models.status`。
- Redis 只保存速率/并发短 TTL 计数；数据库 circuit 状态在进程重启和 Redis 丢失后仍有效。

## 8. 产物、资产和商品事实

### artifacts

| 字段                     | 类型     | 说明                                                      |
| ------------------------ | -------- | --------------------------------------------------------- |
| `id`                     | uuid     | 主键                                                      |
| `task_id`                | uuid     | 来源任务                                                  |
| `user_id`                | uuid     | 用户                                                      |
| `product_id`             | uuid?    | 关联商品档案                                              |
| `type`                   | enum     | image/video/text/package                                  |
| `storage_channel_id`     | uuid?    | 精确存储通道；legacy/local 可空                           |
| `storage_key`            | string   | 对象存储 key                                              |
| `content_hash`           | string   | 对象内容 hash，用于完整性校验                             |
| `published_storage_key`  | string?  | S12 审核与发布处理后的可交付对象 key                      |
| `published_content_hash` | string?  | 可交付对象内容 hash                                       |
| `publication_snapshot`   | json?    | 审核、存储与发布处理器版本摘要；1A 不含产品水印或 AI 标识 |
| `publication_revision`   | int      | 发布 CAS 版本，默认 1                                     |
| `thumbnail_key`          | string?  | 缩略图                                                    |
| `meta_json`              | json     | 产物元数据                                                |
| `params_snapshot`        | json     | 参数快照                                                  |
| `source_artifact_id`     | uuid?    | 源产物                                                    |
| `source_action`          | enum     | generate/edit/replace                                     |
| `canvas_node_id`         | uuid?    | 画布节点                                                  |
| `origin_domain`          | enum     | creative/commerce                                         |
| `producer_mode`          | enum     | chat/canvas/suite                                         |
| `producer_session_id`    | uuid?    | 对话会话                                                  |
| `mutation_owner`         | enum     | chat_session/canvas/suite                                 |
| `visibility`             | enum     | private/shared/public/quarantined/deleted                 |
| `created_at`             | datetime | 创建                                                      |

产物可先以 `quarantined` 入库，`storage_key/content_hash` 指向 Provider 输出经 magic-byte、大小、维度和解码校验后写入的私有原始对象；该 key 永不进入普通用户响应。S12 新生成的图片只有在 `published_storage_key/published_content_hash/publication_snapshot` 全部存在且 publication revision CAS 成功后，才能转为 `private/shared/public`；用户预览、下载、存资产和缩略图只能读取 published 对象。审核失败或持续未知不得直接转为 `private`。管理员人工复核必须走审计接口。

S12 发布处理使用由 `artifact_id + publication_revision` 派生的确定性对象 key。外部 put 在事务外执行；写出后崩溃时先 head 并校验 hash，匹配则收敛原操作，不匹配或结果未知保持 quarantined 并人工处置，禁止换 key 重复生成。发布对象、publication snapshot、artifact visibility、settlement/outbox 通过 task owner/revision 与 artifact revision 条件写入推进；历史原始对象按 S15 保留期清理，不在失败路径模糊删除。

### artifact_input_bindings

记录生成/编辑产物使用的全部输入 lineage；`artifacts.source_artifact_id` 继续表示单一主要修改父产物，不能代替多素材证据：

| 字段                      | 类型     | 说明                                                                                   |
| ------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `id`                      | uuid     | 主键                                                                                   |
| `artifact_id`             | uuid     | 输出产物                                                                               |
| `source_type`             | enum     | asset/artifact                                                                         |
| `source_asset_id`         | uuid?    | source_type=asset 时唯一存在                                                           |
| `source_artifact_id`      | uuid?    | source_type=artifact 时唯一存在                                                        |
| `source_version_or_hash`  | string   | 编译时固定的 processing/publication revision 或 content hash                           |
| `role`                    | string   | primary_subject/reference/identity_anchor/pixel_anchor/context 等 strict registry role |
| `transform_snapshot_json` | json     | 裁切/遮罩/旋转/保持范围的规范化参数或 null 语义；不保存图片二进制                      |
| `sort_order`              | int      | 用户素材顺序                                                                           |
| `created_at`              | datetime | 创建                                                                                   |

约束：source asset/artifact 两列必须按 `source_type` 恰好一个非空；`unique(artifact_id,sort_order)`，同一输出的 source ID + role 不可重复。创建 artifact 时必须从 Compiler 已授权 binding snapshot 原子物化，不能由 Provider/LLM 回执补写。源对象后续逻辑删除不改变历史 hash/role/transform 证据，但新任务不能继续读取已删除源。R1-R5、下载权限和多素材拼贴仍按当前用户与任务快照重校验，lineage 不是授权捷径。

### assets

| 字段                    | 类型      | 说明                                                          |
| ----------------------- | --------- | ------------------------------------------------------------- |
| `id`                    | uuid      | 主键                                                          |
| `user_id`               | uuid      | 用户                                                          |
| `product_id`            | uuid?     | 关联商品档案                                                  |
| `folder_id`             | uuid?     | 文件夹                                                        |
| `display_name`          | string    | 经服务端清理的展示名，不是对象路径                            |
| `storage_channel_id`    | uuid?     | 精确存储通道；legacy/local 可空                               |
| `storage_key`           | string    | 私有原对象 key，不进入公网 DTO                                |
| `thumbnail_key`         | string?   | 去元数据重编码后的私有缩略图 key                              |
| `content_hash`          | string?   | 服务端读取对象计算的 SHA-256；ready/rejected 前允许为空       |
| `file_size_bytes`       | bigint    | 服务端探测的实际大小；uploading 时为声明上限占位              |
| `mime_type`             | string?   | 服务端 magic-byte 判定的 MIME；不能直接采用客户端声明         |
| `meta_json`             | json      | strict 安全元数据：宽、高、处理器版本等，不保存 EXIF 原文     |
| `kind`                  | enum      | upload/generated/imported                                     |
| `origin`                | enum      | upload/creative_artifact/commerce_artifact                    |
| `source_artifact_id`    | uuid?     | 来源产物                                                      |
| `status`                | enum      | uploading/processing/ready/processing_failed/rejected/deleted |
| `processing_revision`   | int       | 从 1 开始；每次显式重试递增                                   |
| `processing_error_code` | string?   | 稳定安全错误码，不保存底层异常或文件内容                      |
| `created_at`            | datetime  | 创建                                                          |
| `updated_at`            | datetime  | 状态更新                                                      |
| `deleted_at`            | datetime? | 逻辑删除时间；只有 status=deleted 时非空                      |

约束与索引：

- `processing_revision > 0`；`(status = 'deleted') = (deleted_at is not null)`。
- `status = 'ready'` 时 `content_hash/mime_type/thumbnail_key` 均非空；其他状态不得被构造为 Agent binding 或商品主图。
- `kind=upload` 必须 `origin=upload/source_artifact_id is null`；`kind=generated` 必须存在 `source_artifact_id` 且 origin 为对应 artifact 域。
- `unique(user_id, source_artifact_id)` where `source_artifact_id is not null and deleted_at is null`，保证同一作品并发存资产恰好一次。
- 保留 `(user_id,product_id,created_at)`、`(user_id,folder_id,created_at)`，新增 `(user_id,status,created_at)`。

### asset_upload_intents

上传 capability 的持久化幂等与窗口真相，不保存签名 URL/token：

| 字段                 | 类型      | 说明                                                 |
| -------------------- | --------- | ---------------------------------------------------- |
| `id`                 | uuid      | upload ID                                            |
| `user_id`            | uuid      | 当前用户                                             |
| `asset_id`           | uuid      | 本次上传唯一目标 asset                               |
| `storage_channel_id` | uuid?     | 创建 intent 时固定；legacy/local 可空                |
| `status`             | enum      | pending/completed/expired/rejected                   |
| `idempotency_key`    | string    | 当前用户写幂等键                                     |
| `request_hash`       | string    | canonical 请求摘要                                   |
| `response_json`      | json      | 只含 upload/asset ID、限制和窗口，不含 URL/token/key |
| `declared_mime_type` | string    | 仅用于上传策略和后续相容性核对，不作为真实 MIME      |
| `max_size_bytes`     | bigint    | 服务端冻结上限，1A 图片不得超过 20MB                 |
| `expires_at`         | datetime  | 上传窗口                                             |
| `completed_at`       | datetime? | complete 首次成功时间                                |
| `created_at`         | datetime  | 创建                                                 |
| `updated_at`         | datetime  | 状态更新                                             |

约束：`unique(user_id,idempotency_key)`、`unique(asset_id)`；completed 仅允许 pending 原子迁移，过期或 rejected 不可恢复。同 key/同 request 只为同一对象重新签发短 TTL capability，不能创建第二个 asset。

S14 以新增 nullable FK 为 `artifacts/assets/asset_upload_intents` 增加 `storage_channel_id`，不改写历史对象。local/test 与 legacy 行可空并按原 adapter 读取；staging/beta/production 的新 upload intent、asset 和 artifact 必须固定 active `storage_runtime_state` 的精确 channel ID。任何读取、签名、派生或删除都先按行上的 channel 路由，禁止使用“当前 active channel”猜测历史对象位置；channel disabled 时默认拒绝新写，历史读取是否继续仅由受控 credential 状态和安全策略裁决，不能静默去另一 bucket 查找。

### resource_write_requests

S10 商品、事实、资产重试与作品存资产写接口的持久化幂等真相：`id/user_id/operation/idempotency_key_hash/request_hash/status/response_status?/response_json?/created_at/completed_at?`。

- `unique(user_id,operation,idempotency_key_hash)`；operation 必须是规范化路由模板，path resource ID 进入 request hash。
- 原始 `Idempotency-Key` 不落库，只保存独立安全域密钥计算的 HMAC 摘要；同 key 不同 request hash 返回 `IDEMPOTENCY_CONFLICT`。
- 领域写入与 completed response 必须在同一事务提交；失败事务不留下成功记录。上传 URL 仍由 `asset_upload_intents` 单独裁决，因为它需要在重放时重新签发短期 capability。

### asset_folders

| 字段               | 类型     | 说明     |
| ------------------ | -------- | -------- |
| `id`               | uuid     | 主键     |
| `user_id`          | uuid     | 用户     |
| `parent_folder_id` | uuid?    | 父文件夹 |
| `name`             | string   | 文件夹名 |
| `created_at`       | datetime | 创建     |
| `updated_at`       | datetime | 更新     |

约束：`unique(user_id, parent_folder_id, name)`。

### product_fact_sets

| 字段              | 类型      | 说明                      |
| ----------------- | --------- | ------------------------- |
| `id`              | uuid      | 主键                      |
| `user_id`         | uuid      | 用户                      |
| `product_id`      | uuid?     | 商品档案                  |
| `version_no`      | int       | 商品内从 1 递增的事实版本 |
| `source_asset_id` | uuid      | 原图素材                  |
| `facts_json`      | json      | 事实                      |
| `confirmed_at`    | datetime? | 确认时间                  |
| `confirmed_by`    | uuid      | 用户                      |
| `source_version`  | string    | 原图版本                  |
| `created_at`      | datetime  | 创建                      |

约束：`product_id` 在 S10 正式入口必须非空，`version_no > 0`，`unique(product_id,version_no)`。事实集只追加不更新；创建时锁定商品，在同一事务写事实行与 `products.latest_fact_set_id/revision`。

### products

1A 最小商品档案，用于按商品组织生成记录，不做完整 ERP/SPU/SKU 管理。

| 字段                 | 类型     | 说明                    |
| -------------------- | -------- | ----------------------- |
| `id`                 | uuid     | 主键                    |
| `user_id`            | uuid     | 用户                    |
| `sku_code`           | string?  | 用户自填 SKU/货号       |
| `name`               | string   | 商品名称                |
| `primary_asset_id`   | uuid?    | 主商品图                |
| `latest_fact_set_id` | uuid?    | 最新确认事实            |
| `status`             | enum     | active/archived         |
| `revision`           | int      | 乐观并发版本，从 1 开始 |
| `created_at`         | datetime | 创建                    |
| `updated_at`         | datetime | 更新                    |

约束：

- `index(user_id, updated_at)`。
- `index(user_id, sku_code)`。
- `unique(user_id, sku_code)` where `sku_code is not null`。
- `revision > 0`；商品编辑必须使用 `id + user_id + revision` CAS。

1A 规则：

- 商品档案是归档和筛选维度，不改变产物修改权。
- 用户可以不填 SKU；系统可用商品名和首张素材创建最小档案。
- 一个产物最多关联一个当前商品档案；跨商品复用素材必须生成新的 workflow 记录。
- `primary_asset_id/latest_fact_set_id` 的同用户、所属商品和 lifecycle 约束由 Service 在持锁事务内重校验，不能只依赖外键。

## 9. 校验、风险确认和分享

### artifact_evaluations

| 字段                | 类型              | 说明                                                        |
| ------------------- | ----------------- | ----------------------------------------------------------- |
| `id`                | uuid              | 主键                                                        |
| `artifact_id`       | uuid              | 产物                                                        |
| `task_id`           | uuid?             | 执行该校验的 task；S12 content_safety 必填                  |
| `task_attempt_id`   | uuid?             | 实际外部审核 attempt；S12 content_safety 必填且唯一         |
| `model_snapshot_id` | uuid?             | 精确审核模型；S12 content_safety 必填                       |
| `evaluator_type`    | enum              | platform_spec/commerce_evidence/content_safety              |
| `evaluator_version` | string            | 策略/实现版本                                               |
| `operation_key`     | sha256            | artifact/type/version/model 的稳定幂等键                    |
| `evidence_snapshot` | json              | 脱敏证据与 runtime/credential/policy digest，不含原图或正文 |
| `findings_json`     | json              | 结构化安全发现                                              |
| `confidence`        | decimal?          | 置信度；调用结果 unknown 且无可信回执时为空                 |
| `status`            | evaluation_status | pass/warning/unknown/blocked                                |
| `created_at`        | datetime          | 创建                                                        |

`artifact_evaluations` 只在对应 task attempt 得到可裁决终态时插入，插入后不可修改；`unique(operation_key)`、`unique(task_attempt_id) where task_attempt_id is not null`、`unique(artifact_id,evaluator_type,evaluator_version)`。`confidence` 非空时必须在 `[0,1]`，`pass/warning/blocked` 必须有可信 confidence，因超时、崩溃或非法回执形成的 `unknown` 必须为空，不能伪造 0。S12 的生成后真实审核必须先创建 `task + task_attempt`，沿用 S07 三态、成本 exposure/actual、owner/lease 和恢复规则；不能由无 attempt 的 `evaluation.run` 直接联网。审核结论与 moderation task 终态、review case 或 publication intent/outbox 在同一短事务写入，重复回执只重放同一 evaluation。

### content_safety_preflights

保存 S12 在创建 quote/reservation 前执行的真实文本/输入图片审核。它是外部调用与恢复真相，不能只写 Agent 日志或内存标志：

| 字段                             | 类型         | 说明                                                           |
| -------------------------------- | ------------ | -------------------------------------------------------------- |
| `id`                             | uuid         | 主键                                                           |
| `turn_id`                        | uuid         | 当前 Agent turn                                                |
| `continuation_no`                | int          | 当前 continuation                                              |
| `capability`                     | string/enum  | moderation.text 或 moderation.image                            |
| `check_no`                       | int          | 同 capability 的稳定分片序号                                   |
| `input_digest`                   | sha256       | 规范化文本或绑定 ID/version/hash 集合；不保存完整输入          |
| `model_snapshot_id`              | uuid         | 精确内部审核模型                                               |
| `credential_version_id`          | uuid         | 调用时 credential                                              |
| `runtime_revision`               | int          | 调用时 moderation route revision                               |
| `policy_version`                 | string       | 内容安全策略版本                                               |
| `operation_key`                  | sha256       | turn/continuation/capability/check/input/model 的稳定幂等键    |
| `status`                         | enum         | queued/running/passed/blocked/failed/outcome_unknown/cancelled |
| `dispatch_state`                 | enum         | not_dispatched/accepted/outcome_unknown                        |
| `reserved_cost_cny`              | decimal      | 调用前保守 exposure；unknown 时保留                            |
| `actual_cost_cny`                | decimal?     | 可信回执实际成本                                               |
| `evidence_summary_json`          | json?        | policy/reason code/置信度/证据 digest；无正文、图片或原文      |
| `revision`                       | int          | owner/CAS                                                      |
| `processing_owner/lease/...`     | string/time? | 恢复租约                                                       |
| `created_at/started_at/ended_at` | timestamptz? | 生命周期；created_at 必填                                      |

约束：`unique(operation_key)`、`unique(turn_id,continuation_no,capability,check_no)`、`revision > 0`，owner/lease 只在 running 且必须成对。开始前固定 model/credential/runtime/policy/input digest 和 exposure；事务外调用 Provider。只有明确未写出可以保持 `not_dispatched` 并由同 operation key 恢复；开始网络写出前先保守标记 outcome_unknown，可信响应后才能收敛 accepted + pass/blocked。进程崩溃、超时、连接复位、响应非法或成本未知均终结为 outcome_unknown、保留 exposure 且不自动重投。全部 required checks passed 才能编译 quote；任一 blocked 阻断 turn，任一 unknown/依赖不可用返回内容安全不可用。

### content_review_cases

承载 S12 生成后审核 `unknown` 的人工处置队列和并发裁决真相；不得直接覆盖不可变的 `artifact_evaluations` 证据：

| 字段                    | 类型         | 说明                                                       |
| ----------------------- | ------------ | ---------------------------------------------------------- |
| `id`                    | uuid         | 主键                                                       |
| `artifact_id`           | uuid         | 隔离产物                                                   |
| `evaluation_id`         | uuid         | 触发人工复核的 content_safety evaluation                   |
| `status`                | enum         | pending/released/rejected/expired                          |
| `deadline_at`           | timestamptz  | 服务端创建时间起 24 小时                                   |
| `revision`              | int          | 并发裁决 CAS，从 1 开始                                    |
| `decision`              | enum?        | release/reject；pending/expired 时为空                     |
| `decision_summary_json` | json?        | 人工确认的脱敏摘要，不含图片、prompt、URL 或 Provider 原文 |
| `decided_by_admin_id`   | uuid?        | 裁决管理员                                                 |
| `decision_reason`       | string?      | 必填业务原因                                               |
| `decided_at`            | timestamptz? | 裁决时间                                                   |
| `created_at/updated_at` | timestamptz  | 生命周期                                                   |

约束：`unique(evaluation_id)`；`revision > 0`；`index(status,deadline_at,id)`。创建 case 时必须验证 evaluation 属于同一 artifact、`evaluator_type=content_safety/status=unknown` 且 artifact 为 `quarantined`。`release/reject/expired` 为终局；人工 release 必须写新的人工确认摘要，不能把原 unknown evaluation 原地改成 pass。裁决以 `id + expected_revision` 单赢家 CAS 推进 artifact/task/workflow、settlement/release intent、outbox 和成功审计；任一写入失败整笔回滚。到期 Worker 与人工裁决竞争使用同一 CAS，只有一个终态赢家，重复消费幂等返回原结果。

### risk_confirmations

| 字段                | 类型          | 说明                |
| ------------------- | ------------- | ------------------- |
| `id`                | uuid          | 主键                |
| `artifact_id`       | uuid          | 产物                |
| `evaluation_id`     | uuid          | 校验                |
| `user_id`           | uuid          | 确认用户            |
| `decision`          | risk_decision | confirmed/cancelled |
| `evidence_snapshot` | json          | 确认前证据          |
| `confirmed_at`      | datetime      | 时间                |

### shares

| 字段            | 类型          | 说明           |
| --------------- | ------------- | -------------- |
| `id`            | uuid          | 主键           |
| `user_id`       | uuid          | 用户           |
| `artifact_id`   | uuid          | 创意产物       |
| `slug`          | string unique | 公开路径       |
| `allow_remix`   | boolean       | 是否允许做同款 |
| `revoked_at`    | datetime?     | 撤回           |
| `view_count`    | int           | 浏览           |
| `convert_count` | int           | 转化           |
| `created_at`    | datetime      | 创建           |

### share_reports

阶段 2A 启用，记录公开分享页举报和运营处置，不把举报状态塞进访问日志。

| 字段               | 类型                | 说明                                            |
| ------------------ | ------------------- | ----------------------------------------------- |
| `id`               | uuid                | 主键                                            |
| `share_id`         | uuid                | 被举报分享                                      |
| `reporter_user_id` | uuid?               | 已登录举报人，匿名时为空                        |
| `reason`           | enum                | infringement/illegal/sexual/fraud/privacy/other |
| `description`      | string?             | 补充说明                                        |
| `status`           | share_report_status | open/reviewing/dismissed/actioned               |
| `ip_hash`          | string              | 匿名防刷哈希，不保存明文 IP                     |
| `decided_by`       | uuid?               | 运营处理人                                      |
| `decision_note`    | string?             | 处置摘要                                        |
| `created_at`       | datetime            | 创建                                            |
| `decided_at`       | datetime?           | 处置时间                                        |

约束和索引：`index(status, created_at)`、`index(share_id, created_at)`；同一用户/IP 对同一分享的重复举报必须限流和幂等。运营处置同时写 `admin_audit_logs`。

## 10. 画布、会员、模板和规范占位

### memberships

| 字段                    | 类型              | 说明                         |
| ----------------------- | ----------------- | ---------------------------- |
| `user_id`               | uuid unique       | 用户                         |
| `tier`                  | membership_tier   | 等级                         |
| `expires_at`            | datetime?         | 到期                         |
| `monthly_credit_policy` | json              | 月赠送策略                   |
| `source`                | membership_source | 系统赠送/管理员授予/未来购买 |
| `granted_by`            | uuid?             | 管理员授予人；系统或购买为空 |
| `updated_at`            | datetime          | 最近权益变更时间             |

### canvases

| 字段            | 类型      | 说明                                        |
| --------------- | --------- | ------------------------------------------- |
| `id`            | uuid      | 主键                                        |
| `user_id`       | uuid      | 用户                                        |
| `title`         | string    | 名称                                        |
| `graph_json`    | json      | 可编辑图快照，不承载运行真相                |
| `revision`      | bigint    | 乐观并发版本，每次成功保存递增；3a 前向迁移 |
| `thumbnail_key` | string?   | 缩略图                                      |
| `created_at`    | datetime  | 创建时间；3a 前向迁移                       |
| `updated_at`    | datetime  | 更新时间                                    |
| `deleted_at`    | datetime? | 软删除时间；3a 前向迁移                     |

`graph_json` v1 必须使用版本化结构，至少包含：

```json
{
  "schema_version": 1,
  "nodes": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "type": "text | image | video | note",
      "mode": "material | generation | note",
      "position": { "x": 0, "y": 0 },
      "data": {
        "label": "string",
        "current_version_id": "uuid?",
        "params": {},
        "mentions": [
          {
            "source_edge_id": "00000000-0000-4000-8000-000000000101",
            "source_node_id": "00000000-0000-4000-8000-000000000002",
            "source_artifact_id": "uuid?"
          }
        ]
      }
    }
  ],
  "edges": [
    {
      "id": "00000000-0000-4000-8000-000000000101",
      "source": "00000000-0000-4000-8000-000000000002",
      "source_handle": "string",
      "target": "00000000-0000-4000-8000-000000000001",
      "target_handle": "string",
      "input_slot_id": "string",
      "input_order": 0,
      "role": "subject | style | composition | first_frame | last_frame | other"
    }
  ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}
```

约束：

- `revision` 默认 1，保存使用 `where id=? and user_id=? and revision=?` compare-and-set；冲突不得 last-write-wins。
- node/edge ID 必须是规范小写 UUIDv4 字符串，在画布生命周期内稳定。客户端手工建图使用 `crypto.randomUUID()`，服务端挂载产物、模板实例化和复制画布时由服务端生成；保存和编译均校验格式与图内唯一性。
- 复制画布必须生成新 canvas ID，并重映射全部 node/edge ID；不得保留跨画布可碰撞或可关联的旧 ID。
- `mentions.source_edge_id` 必须指向当前节点的输入边；服务端保存和编译时校验，不允许引用全画布任意节点。
- `input_order` 在同一目标输入槽内唯一且从 0 连续；语义顺序不由节点坐标推断。
- `input_slot_id` 是目标节点能力声明中的稳定输入槽标识，决定输入类型、数量和 readiness；`role` 是该条边在槽内的业务用途，两者不是同义字段。通用 `references` 槽可容纳多个 `subject/style/composition/other` 角色，专用 `first_frame/last_frame` 槽只接受匹配角色；允许值由版本化节点能力 schema 裁决。
- `processing`、Provider 状态、签名 URL 和用户可变余额不得进入 `graph_json`；运行真相仍在 workflow/task/attempt，当前结果指向 `node_versions`/artifact。
- v1 不接受未知 node type/mode；新增应用节点或 schema 字段必须升级 `schema_version` 并提供向前迁移。
- 3a 默认单画布规模上限由 S24 性能门禁冻结后写入运营配置；客户端和服务端使用同一值。

`revision`、`created_at`、`deleted_at` 是阶段 3a 的前向字段，不修改 S02 已提交迁移；S24 通过新 migration 增加。

### node_versions

| 字段              | 类型     | 说明                  |
| ----------------- | -------- | --------------------- |
| `id`              | uuid     | 主键                  |
| `canvas_id`       | uuid     | 画布                  |
| `node_id`         | uuid     | 稳定节点 ID           |
| `version_no`      | int      | 版本号                |
| `artifact_id`     | uuid?    | 产物                  |
| `params_snapshot` | json     | 参数                  |
| `source_action`   | enum     | generate/edit/replace |
| `created_at`      | datetime | 创建                  |

约束：`unique(canvas_id, node_id, version_no)`。

### templates / template_unlocks

阶段 2A 启用配方模板，3b 增加画布模板。S02 已提交的占位表不修改；S20 通过前向 migration 补齐下列字段和约束。

`templates` 的每一行代表一个不可变发布版本，不把“模板身份”和“版本号”混成 `type + version`：

| 字段                  | 类型            | 说明                                  |
| --------------------- | --------------- | ------------------------------------- |
| `id`                  | uuid            | 不可变版本 ID                         |
| `template_key`        | uuid            | 同一模板系列的稳定 ID；S20 前向字段   |
| `owner_user_id`       | uuid?           | 作者；官方系统模板可空                |
| `type`                | template_type   | recipe/canvas                         |
| `version`             | string          | 系列内版本号                          |
| `title`               | string          | 展示名称                              |
| `definition_snapshot` | json            | 该版本不可变定义                      |
| `cover`               | string?         | 封面对象键/资源引用，不存签名 URL     |
| `category`            | string          | 分类                                  |
| `unlock_type`         | enum            | free/credits/membership               |
| `price`               | decimal         | 积分价格                              |
| `status`              | template_status | draft/published/retired；S20 前向字段 |
| `stats`               | json            | 浏览、使用、点赞等投影                |
| `published_at`        | datetime?       | 发布时间；S20 前向字段                |
| `created_at`          | datetime        | 创建时间                              |

约束：

- `unique(template_key, version)`；同类型可存在多个模板，禁止 `unique(type, version)`。
- `status=published` 后 `definition_snapshot`、`template_key`、`version` 不可更新；修改必须创建同 `template_key` 的新版本行。
- 列表按 `template_key` 聚合可见版本；任务、解锁和做同款始终绑定实际使用的 `templates.id`，不能静默漂移到最新版。
- `index(status, type, category, published_at)`。

`template_unlocks` 使用 `unique(user_id, template_id)`，字段为 `user_id`、`template_id`（精确版本 ID）、`unlocked_at`、`ledger_id`；重复解锁必须返回原记录且不重复扣费。

### reference_items / content_favorites

阶段 2A 的官方参考图库与收藏使用独立记录，不伪装成某个用户的私有 `assets`。

| 表                  | 核心字段                                                                                                                                       | 约束                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `reference_items`   | `id`、`title`、`category`、`media_type`、`storage_key`、`thumbnail_key`、`source_json`、`license_json`、`status`、`published_at`、`created_at` | `index(status, category, published_at)`；下架后不可新引用             |
| `content_favorites` | `user_id`、`target_type`(template/reference)、`target_id`、`created_at`                                                                        | `unique(user_id, target_type, target_id)`；服务端校验目标存在和可见性 |

收藏是发现页投影，不授予素材修改权或模板解锁权；引用参考图时仍快照来源和授权。

### batches / batch_items

阶段 1B 前向迁移。`batch` 是批量编排聚合，不成为产物修改权 owner；每个条目仍按其实际 recipe/suite 产出模式写 artifact 归属。

| 表            | 核心字段                                                                                                                                                                                            | 约束和索引                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `batches`     | `id`、`user_id`、`name`、`status`、`revision`、`config_snapshot`、`run_quote_id?`、`workflow_run_id?`、`total_count`、`succeeded_count`、`failed_count`、`created_at`、`updated_at`、`finished_at?` | `unique(run_quote_id)`、`unique(workflow_run_id)`、`index(user_id,status,created_at)` |
| `batch_items` | `id`、`batch_id`、`product_id?`、`source_row_no`、`input_snapshot`、`status`、`error_code?`、`created_at`、`started_at?`、`ended_at?`                                                               | `unique(batch_id,source_row_no)`、`index(batch_id,status)`                            |

S18 前向 migration 给 `tasks` 增加可空 `batch_item_id`，一个 batch item 可对应多个 task；批量提交只创建一个父 `workflow_run` 和一次 reservation，条目状态是 task 聚合投影，不能自行扣费。`revision` 默认 1，草稿 PATCH 使用 compare-and-set；quote 的 `input_signature` 必须包含 batch ID、revision 和全部条目输入版本。

### suites / suite_items

阶段 2B 前向迁移，用于保存草稿配置、一次报价和分组结果，不能只依赖前端表单状态。

| 表            | 核心字段                                                                                                                                                                           | 约束和索引                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `suites`      | `id`、`user_id`、`product_id`、`mode`、`status`、`revision`、`config_snapshot`、`run_quote_id?`、`workflow_run_id?`、`result_manifest`、`created_at`、`updated_at`、`finished_at?` | `unique(run_quote_id)`、`unique(workflow_run_id)`、`index(user_id,product_id,created_at)` |
| `suite_items` | `id`、`suite_id`、`group_key`、`image_type`、`position`、`input_snapshot`、`status`、`artifact_id?`、`error_code?`、`created_at`、`ended_at?`                                      | `unique(suite_id,group_key,position)`、`index(suite_id,status)`                           |

S22 前向 migration 给 `tasks` 增加可空 `suite_item_id`；一个 suite item 的最终 artifact 必须能反查 task、workflow、商品事实版本和费用快照。`revision` 默认 1，草稿 PATCH 使用 compare-and-set；quote 的 `input_signature` 必须包含 suite ID、revision、商品事实版本和全部输入版本。

### export_jobs / export_job_items

阶段 1B 起统一承载批量、生成记录和画布导出；API 中的 `export_id` 即 `export_jobs.id`。

| 字段                 | 类型               | 说明                                       |
| -------------------- | ------------------ | ------------------------------------------ |
| `id`                 | uuid               | 导出任务 ID                                |
| `user_id`            | uuid               | 所有人                                     |
| `source_type`        | export_source_type | batch/records/suite/canvas                 |
| `source_id`          | uuid?              | batch/suite/canvas 聚合 ID；records 可空   |
| `status`             | export_job_status  | 状态                                       |
| `selection_snapshot` | json               | 创建时已鉴权的选择范围和版本，不含签名 URL |
| `result_manifest`    | json               | 成功文件摘要                               |
| `failure_manifest`   | json               | 失败/跳过项和稳定错误码                    |
| `storage_key`        | string?            | 打包文件对象键，仅服务端使用               |
| `idempotency_key`    | string             | 创建幂等键                                 |
| `expires_at`         | datetime?          | 打包文件过期时间                           |
| `created_at`         | datetime           | 创建                                       |
| `started_at`         | datetime?          | 开始                                       |
| `completed_at`       | datetime?          | 完成                                       |

`export_job_items` 字段为 `id`、`export_job_id`、`artifact_id?`、`item_type`(artifact/report)、`output_name`、`status`、`error_code?`、`created_at`、`completed_at?`。约束为 `unique(export_job_id,item_type,output_name)`，并要求 `item_type=artifact` 时 `artifact_id` 非空、`item_type=report` 时按报告快照命名；不能依赖 nullable 列参与唯一约束防重复。

导出约束：`unique(user_id,idempotency_key)`、`index(user_id,status,created_at)`、`index(source_type,source_id)`。每次下载重新鉴权并临时签发 URL；不得持久化签名 URL。重试只重跑 failed item，复用原 selection snapshot，不重新生成 artifact。

### referrals

内测邀请和返积分防刷：

- `id`
- `inviter_id`
- `invitee_id`
- `reward_status`
- `fraud_flag`
- `created_at`

约束：`unique(invitee_id)`。

### invite_campaigns / invite_code_batches

两表是已提交 migration 与历史数据的兼容结构。S14A 简化后，新邀请码不创建或引用活动/批次；不得据此恢复活动、发行规则、批次或独立的明文查看页面。列表按行复制使用 S14A 裁决的受控 reveal API。

`invite_campaigns`：

| 字段                          | 类型         | 说明                                            |
| ----------------------------- | ------------ | ----------------------------------------------- |
| `id`                          | uuid         | 主键                                            |
| `campaign_key`                | string       | 稳定业务 key                                    |
| `name`                        | string       | 管理端名称                                      |
| `status`                      | enum         | draft/active/closed；closed 终局                |
| `starts_at/expires_at`        | timestamptz? | 活动窗口，以服务端 UTC 裁决                     |
| `issuance_limit`              | int          | 活动最多生成的 code 数                          |
| `default_max_uses`            | int          | 新 code 默认容量                                |
| `default_validity_seconds`    | int?         | 新 code 默认有效期                              |
| `email_constraint_json`       | json         | strict 邮箱/域名约束；不保存任意表达式          |
| `reward_campaign_id`          | uuid?        | 注册奖励活动；code 创建时固定 snapshot          |
| `internal_note`               | string?      | 内部备注，禁止放 secret/完整用户清单            |
| `revision`                    | int          | expected revision                               |
| `created_by_admin_id`         | uuid?        | S14 管理员；legacy/CLI 可空并由 actor_type 审计 |
| `created_at/activated_at/...` | timestamptz  | 生命周期时间                                    |

`invite_code_batches`：`id/campaign_id/count/settings_snapshot_json/settings_digest/created_by_admin_id/created_at`，只供历史记录读取与迁移兼容。

约束：已有外键与唯一约束继续保留，避免破坏历史数据；运行时代码不得再创建、激活或关闭活动，也不得创建新批次。

### invite_codes

邀请内测入口使用，记录邀请码发放、核销和额度。

| 字段                     | 类型         | 说明                                         |
| ------------------------ | ------------ | -------------------------------------------- |
| `id`                     | uuid         | 主键                                         |
| `code_digest`            | string       | 邀请码 HMAC，禁止保存明文                    |
| `key_id`                 | string       | 非敏感 HMAC key 版本                         |
| `code_prefix`            | string?      | 可选非敏感前缀，仅用于运营识别               |
| `code_ciphertext`        | string?      | 新邀请码明文的 envelope 密文；历史数据可为空 |
| `code_nonce`             | string?      | AES-GCM nonce；与其余密文字段同时存在        |
| `code_auth_tag`          | string?      | AES-GCM auth tag；与其余密文字段同时存在     |
| `code_encryption_key_id` | string?      | 邀请码专用 envelope key ID；历史数据可为空   |
| `campaign_id`            | uuid?        | legacy 兼容关联；新写入为空                  |
| `batch_id`               | uuid?        | legacy 兼容关联；新写入为空                  |
| `email_allowlist`        | json         | 可用邮箱/域名约束                            |
| `max_uses`               | int          | 最大使用次数                                 |
| `used_count`             | int          | 已正式核销次数，不包含 active claim          |
| `issued_by`              | uuid?        | 发放人                                       |
| `expires_at`             | timestamptz? | 过期                                         |
| `disabled_at`            | timestamptz? | 禁用                                         |
| `revision`               | int          | 容量/有效期/停用 CAS                         |
| `created_at`             | timestamptz  | 创建                                         |

约束：

- `unique(key_id, code_digest)`；查询时按 active key 和仍在有效期内的历史 keyring 计算候选 digest。
- 新管理台邀请码固定 `max_uses=1`、`email_allowlist=[]`、`campaign_id/batch_id=null`，可选 `expires_at`；批量上限由 typed config 校验。
- 新管理台邀请码必须使用专用 envelope keyring 写满四个加密列；数据库不得保存明文。完整明文只允许首次创建响应和单码受控 reveal 响应返回，幂等响应、批量列表、审计、日志、事件和队列不得保存或返回；历史 HMAC-only 记录不可恢复。
- 只允许停用未使用、未过期且没有 active registration claim 的邀请码；单个/批量停用使用行锁与幂等记录，批量操作全成或全败，停用后不得恢复。
- 旧 `code` 字段迁移使用新增 migration，回填 digest 后再通过多版本灰度停用明文读取；不得修改已提交 migration。

### invite_code_redemptions

记录邀请码核销和返积分归因。

| 字段             | 类型     | 说明           |
| ---------------- | -------- | -------------- |
| `id`             | uuid     | 主键           |
| `invite_code_id` | uuid     | 邀请码         |
| `user_id`        | uuid     | 核销用户       |
| `redeemed_at`    | datetime | 核销时间       |
| `ledger_id`      | uuid?    | 对应返积分流水 |
| `created_at`     | datetime | 创建           |

约束：`unique(invite_code_id, user_id)`。

该表只由注册 OTP 通过后的完成事务正式写入。前端不得在验证前调用独立 redeem 路径；`registration_claims` 负责验证前容量占位，两者不能互相替代。

### platform_spec_rules

1A 必须落库占位，2B 启用规则内容：

- `platform`
- `country`
- `image_type`
- `rules_json`
- `source`
- `effective_from`
- `effective_to`
- `version`
- `status`
- `updated_at`

约束：规则版本不得原地覆盖。

## 11. Agent、Skill 和模型

### chat_sessions

| 字段                      | 类型      | 说明                                                  |
| ------------------------- | --------- | ----------------------------------------------------- |
| `id`                      | uuid      | 主键                                                  |
| `user_id`                 | uuid      | 用户                                                  |
| `title`                   | string    | 标题，NFKC + trim 后 1-120 字符                       |
| `primary_skill_slug`      | string?   | 会话固定的主 Skill 逻辑身份；首个 turn 原子写入       |
| `revision`                | int       | 默认 1；重命名和归档的 CAS 版本                       |
| `todo_json`               | json      | 会话任务清单                                          |
| `plan_preview`            | json?     | 计划预览                                              |
| `summary_json`            | json      | strict 会话摘要；默认空对象                           |
| `summary_version`         | int       | 默认 0；摘要 CAS 版本                                 |
| `summary_through_turn_id` | uuid?     | 摘要已覆盖到的最后一个终局 turn，只能单调向前         |
| `archived_at`             | datetime? | 用户“删除会话”的软删除时间；历史 turn/资金/审计不删除 |
| `created_at`              | datetime  | 创建                                                  |
| `updated_at`              | datetime  | 最近消息、重命名或归档时间                            |

摘要只能覆盖终局 turn，并记录来源 message IDs；`session_id + expected_summary_version` CAS 失败必须重读，不能覆盖较新的摘要或把未确认事实升级为用户授权。

约束：

- `revision > 0`；普通列表和详情只读取 `archived_at is null`，随机 ID、已归档和跨用户统一 404。
- `primary_skill_slug` 为空只兼容尚未创建 turn 的会话；首个 turn 必须与 session 同事务写入，后续 turn 只能使用同 slug。开始新的创作方向必须新建会话；内置 Skill 升版只改变新 turn 的精确快照，不改变会话创作方向。
- 新 user/assistant message 与 `chat_sessions.updated_at` 在同一事务推进；为未归档列表提供 `(user_id, archived_at, updated_at, id)` 索引，会话列表稳定按 `(updated_at desc,id desc)` keyset 排序。
- 重命名使用 `id + user_id + revision + archived_at is null` CAS。归档前必须确认不存在未终局 turn 或未终局 workflow；不能以“删除会话”静默中断、取消、退款或删除历史证据。
- 归档是终局用户动作，不提供前端硬删除或恢复。历史 turn、message、trace、workflow、artifact 和资金证据继续保留并按原权限供内部审计。

### agent_session_mutations

保存会话重命名与归档的用户级幂等响应，不复用 Redis 或 Admin 幂等表。

| 字段                   | 类型     | 说明                                    |
| ---------------------- | -------- | --------------------------------------- |
| `id`                   | uuid     | 主键                                    |
| `user_id`              | uuid     | 当前用户                                |
| `session_id`           | uuid     | 目标会话                                |
| `operation`            | string   | `rename` or `archive`                   |
| `idempotency_key_hash` | hmac     | Agent Session 专属 keyring HMAC         |
| `request_hash`         | sha256   | 路由 session ID + strict body canonical |
| `response_json`        | json     | 首次成功不可变响应                      |
| `created_at`           | datetime | 创建                                    |

约束：`unique(user_id,operation,idempotency_key_hash)`；同 key + 同 request hash 重放原响应，同 key + 不同 hash 返回 `IDEMPOTENCY_CONFLICT`。mutation、session CAS 和 response row 必须在同一短事务，日志不得记录原始幂等键或会话正文。

### chat_messages

| 字段               | 类型     | 说明                                                      |
| ------------------ | -------- | --------------------------------------------------------- |
| `id`               | uuid     | 主键                                                      |
| `session_id`       | uuid     | 会话                                                      |
| `role`             | enum     | user/assistant/system/tool                                |
| `content`          | text     | 内容                                                      |
| `turn_id`          | uuid?    | 关联 turn                                                 |
| `attachments`      | json     | 附件                                                      |
| `tool_calls`       | json     | 安全 call ID/tool version/args hash/step ID；不存原始参数 |
| `skill_snapshots`  | json     | 实际加载 resource snapshot ID/hash 的安全索引；不存正文   |
| `pending_approval` | json     | 商品事实、澄清和风险确认内容；不承载费用确认              |
| `created_at`       | datetime | 创建                                                      |

`role=tool/system` 的消息只供引擎上下文和审计，不进入用户 GET turn 的 messages；tool `content` 必须是 strict 脱敏 observation，不得保存原始 Provider 响应、完整 Skill 正文、Key、签名 URL 或其他用户存在性。公网进度统一来自 `turn.activity_*`。

### S08 会话 transcript 扩展 (2026-09-07)

**2026-09-09 范围修订**：遵循 `02` 11.0，只支持新会话原生 transcript 执行；本次不实现旧消息导入、summary v1 转换、双格式恢复或回滚。下文保留的 legacy/import 字段是既有 schema 的历史定义，不构成运行兼容要求，不修改已存在 migration。新路径从服务端 session 读取真实 generation，禁止常量占位；输入依赖必须匹配实际已授权图片绑定、已加载 Skill 资源及同次读取的事实集版本，不得从输出猜测或事后重新查询最新版本来替代原输入证据。

本节为前向实现契约。2026-09-07 已生成 `0038_agent_session_transcript.sql`，并在独立测试库验证空库从零及既有结构升级；尚未应用到本地验收库，API/Worker 尚未接入捕获或切读。已在测试库应用的 migration 同样不可修改，后续结构修正必须新增 migration。`chat_messages` 保留公开投影；新格式语义历史使用下列私有表，不把原始工具参数加回 `chat_messages` 或 trace。基础层验证记录见 S08 第 17.6 节，不代表本节所有运行时约束已实现。

`chat_sessions` 新增字段：

| 字段                       | 类型   | 说明                                                                               |
| -------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `message_history_revision` | bigint | 默认 0；每次 message 增删/正文或附件语义变化同事务递增，独立于重命名 revision      |
| `transcript_next_sequence` | bigint | 默认 1；该 session 下下一批 item 的首序号，事务性分配                              |
| `transcript_generation`    | bigint | 默认 1；压缩、撤销、投影失效推进；普通尾部追加不推进                               |
| `transcript_state_json`    | json   | strict schema v1；默认 `{schema_version:1,mode:off}`；含导入与切读检查点，不含正文 |

`transcript_state_json.mode` 只允许 `off | backfill | shadow | active | invalid`，不是用户可见会话状态。backfill 记录 import attempt ID、source revision、稳定 `(created_at,id)` 截止点/游标、来源数量、已导入数量和有序内容 digest；shadow/active 记录完整性验证版本、验证到的 sequence 和校验 digest。验证游标只证明其覆盖范围，不能豁免随后追加内容的校验。bigint 在应用协议中使用十进制字符串或 bigint，禁止不经范围校验转 JS number。

受控 transcript 读取只接受以下已经完成切读门禁的 strict v1 状态：`{schema_version:1,mode:"active",integrity_version:1,verified_through_sequence:<非负十进制字符串>,verified_digest:<sha256>}`。`verified_through_sequence` 是该 active 检查点实际覆盖的最后一个 sequence，不是会话读取上限；新追加的尾部仍须逐条验证来源、完整性和 live 依赖。单 item 必须在当前 `transcript_next_sequence` 已分配范围内；完整窗口的连续性和协议闭合另行验证，不能因某条 item 可读就把未闭合历史交给模型。`shadow` 仍是影子写入状态，不能作为模型读源；`off/backfill/invalid` 同样不可读。读取过程中若 session generation 改变，必须丢弃本次结果并重新读取，不能把已授权正文返回给调用者。

### agent_transcript_items

| 字段                                     | 类型        | 说明                                                                                    |
| ---------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `id`                                     | uuid        | 宿主分配的稳定 item 身份                                                                |
| `user_id/session_id`                     | uuid        | 显式租户及会话范围                                                                      |
| `turn_id`                                | uuid?       | 所属 turn；无 turn 的真实 legacy 消息可空                                               |
| `continuation_no`                        | int?        | 有 turn 的新记录必填，记录原始 continuation                                             |
| `sequence_no`                            | bigint      | session 内从 1 开始递增的持久化语义顺序                                                 |
| `schema_version`                         | int         | 首版固定 1                                                                              |
| `item_type`                              | string      | `user_message/assistant_output/tool_result/host_context/legacy_message` 判别联合        |
| `source_key`                             | string      | 宿主生成的消息 ID/已持久化 model step/领域事件/call 位置幂等键，不含用户原文            |
| `source_message_id/source_trace_step_id` | uuid?       | 真实来源索引；trace 不是内容真相，清理 trace 不得级联删除语义历史                       |
| `import_attempt_id`                      | uuid?       | 仅 backfill 产生的 legacy_message 必填；用于限制未启用导入副本的清理范围                |
| `reply_to_item_id`                       | uuid?       | tool_result 引用所属 assistant_output                                                   |
| `call_ordinal`                           | int?        | tool_result 在原批次中的位置，0-3                                                       |
| `payload_json`                           | json        | strict envelope；存小型语义值或受控 payload 引用                                        |
| `payload_digest`                         | sha256      | schema/type 与完整逻辑 payload 的 canonical digest，引用必须包含内容 hash               |
| `resource_dependencies_json`             | jsonb       | strict 资源身份/version/hash 引用数组，默认空；派生内容的可撤销依赖，不含正文或访问 URL |
| `created_at`                             | timestamptz | 服务端 UTC 记录时间；回放按 sequence，不按此时间排序                                    |

约束：

- `unique(session_id,sequence_no)`、`unique(session_id,source_key)`；sequence 正数。幂等重放先查 source key：同 digest 返回原 item，不增加 counter；不同 digest 拒绝，不覆盖旧值。
- assistant_output 保存完整、有序的调用数组、严格 terminal outcome，或唯一无工具调用的原生聊天文本；三者用判别 envelope 区分，不能把一次工具批次拆成无关联的多条助手消息。纯文本不伪装成 terminal tool，也不构成生成动作。wire call ID 从 assistant item ID + ordinal 确定性派生，provider 原始 call ID 只作经过长度/字符校验的来源信息，不承担全局唯一或费用幂等。
- tool_result 的 `reply_to_item_id/call_ordinal` 必须同时存在，其余类型必须为空；`unique(reply_to_item_id,call_ordinal)` 只作用于 tool_result。以包含 user/session/turn 的复合引用约束保证父子归属一致；持锁事务内再验证父 item 是 assistant、ordinal 在真实调用数组内、工具/参数 hash 匹配。不能只相信 JSON 内自报的 call ID。
- tool_result 记录已验证的结果或明确 rejected/not_executed/unknown 语义。异步提交 receipt 已经是一次调用结果；后续业务变化用新的 host_context，不更新旧 result。
- 所有 session/turn/source/payload 引用必须重新核验租户、归属和来源一致性；表外来源没有可用复合外键时由同事务关系校验兜底，不能仅检查 UUID 存在。读接口同样显式带 user_id/session_id。
- `(session_id,sequence_no)` 索引支持 keyset 读取，禁止每步全表读后内存截断。单 envelope 规范化 UTF-8 上限 64 KiB；图片、Skill 正文、签名 URL、Key 和原始 Provider body 不能进入 envelope。
- 必须保留完整语义参数。超过 envelope 阈值的已验证计划/文本使用下表引用；已有不可变且生命周期一致的业务计划可直接以受控 ID + version/hash 引用，不能使用 trace summary 或无实体的悬空 draft ID。
- `resource_dependencies_json` 复用已鉴权 attachment/Skill resource snapshot 的身份与版本语义；`jsonb_path_ops` GIN 索引支持按资源身份定位，另建 `(session_id,import_attempt_id)` 索引限定导入清理。对模型输出保守继承本次有效输入的资源依赖，对 tool_result 继承调用及结果资源依赖，不只索引结果 JSON 中恰好出现的 ID。summary v2 记录覆盖范围依赖的并集，不能因压缩而丢掉撤销关系。查询和投影均重新检查资源当前权限/生命周期，索引不是权限证据。

**P1 item envelope 与纯协议校验边界 (2026-09-08)**

以下为内部 v1 捕获结构，不是新的公网协议或工具授权。所有对象 strict；宿主在进入此层前完成既有领域规范化。本轮仅实现无 I/O 校验，不接通生产写入。

- 记录对应上表全部字段，使用 snake_case；`sequence_no` 在纯校验接口中只接受规范正十进制字符串，范围为 PostgreSQL 有符号 bigint，repository 将数据库 bigint 无损转字符串。`continuation_no` 为正 int32 或 null，UUID 身份规范为小写，`created_at` 为服务端 UTC ISO 字符串。source key 为 1-256 字符的宿主标识（字母、数字、下划线、点、冒号、斜线、短横线），不得放用户正文。
- 语义值使用 `{type:inline,value:<领域 JSON object>}` 或下节完整 `private_payload` 引用。inline 必须通过宿主提供的既有 strict 领域 schema，且前后 canonical JSON 一致；引用仅检查结构、声明的 kind/hash/字节数，显式返回待授权物化的引用清单，不声称引用正文已经验证。大型计划可用私有引用，不为 64 KiB 缩短创意文本。已有业务实体的直接引用后续按实际 repository 契约接入，不增加任意 URL 引用。
- `user_message` envelope 为 `{schema_version:1,type:user_message,content}`，必须有真实 `source_message_id`，content 只用 inline；附件、正文和确认答案形态由宿主领域 schema 选择，不把宿主上下文伪装成用户文本。
- 原生用户消息的宿主 content v1 为 `{text,attachments}`：逐字保存已入库 `chat_messages.content`，附件逐项复用 Compiler `attachmentSnapshotSchema`，不再 trim、排序、重新编号或把 upload 请求替代成未核验的引用。最多 9 个附件且 binding key/position 不重复；mention 过滤后 position 可以不连续。持久化 schema 不重复施加创建请求的 2,000 字限制，确认回答可能包含选项标签与正文拼接。消息的 Skill selection 指针属于宿主上下文，工具摘要/pending approval 不得混入原生用户消息；确认的结构化答案和事实版本须另写带真实 confirmation 来源的 host context，不能靠显示文案恢复。
- 原生用户消息的资源依赖必须与其附件快照集合完全一致，不能只验证已声明列表而遗漏正文附件；仅验证这个消息种类的绑定器必须对其他 item 类型拒绝，不充当全局授权器。每次读取重新按 owner + resource ID 查询当前 asset/artifact，核对生命周期、媒体类型、version/hash 和适用的 publication revision，并检查当前用户可访问。读取历史本身不授予 mutable 权限，不因产物来自另一会话而拒绝同一用户的合法只读引用。此 DB 授权不替代既有图片物化时的对象存储可读性、实际字节/hash/格式核验；未完成物化不能宣称图片已验证。
- `assistant_output` envelope 的 `mode:tools|terminal` 为 `{schema_version:1,type:assistant_output,mode,calls}`：tools 保留 1-4 个原顺序调用；terminal 恰好 1 个逻辑动作，同样必须记录结果。`mode:text` 为 `{schema_version:1,type:assistant_output,mode:text,text,calls:[]}`，仅保存通过公开文本安全检查、满足本轮预算并已正式发布的无工具聊天正文，无实际工具调用、无 tool_result；不能从正文解析工具或计划。模型 usage 结算、该 item、assistant chat message、outbox 和 turn 完成必须同事务；预算拒绝只结算并记录脱敏失败，不写正文或重投模型。每个调用为 `{name,arguments,arguments_digest,provider_call_id,provider_metadata?}`，name 为注册的 `name@version`，digest 是完整规范参数的 shared canonical hash（私有引用使用 content_digest），provider call ID 为 null 或 1-128 位 ASCII 字母/数字/下划线，仅作来源。工具与 terminal 不得混批；可选 provider_metadata 只允许 `{google:{thoughtSignature}}` 不透明签名，签名参与 envelope digest，不进入公开 trace、摘要或工具参数；不添加模型隐藏推理或 Provider 原始响应。
- `tool_result` envelope 为 `{schema_version:1,type:tool_result,name,arguments_digest,status,result}`；status 只允许 `succeeded | rejected | not_executed | unknown`。result 对每种状态分别使用宿主结果 schema/允许的私有 kind，不用错误原文填充。协议身份只取外层 `reply_to_item_id/call_ordinal`，不能由 result 正文声称。
- `host_context` envelope 为 `{schema_version:1,type:host_context,name,content}`，name 是宿主注册的版本化事件名，content 使用对应 schema，业务 receipt/原 turn/attempt 等来源由该 schema 与 repository 共同核验。`legacy_message` 为 `{schema_version:1,type:legacy_message,role,content,source_content_digest}`，role 只允许真实 user/assistant/tool；必须同时记录来源 message ID 和 import attempt。legacy 工具摘要不能参与原生配对，不能补造调用。
- `confirmation_answer@1` 是确认的宿主事件，不冒充用户消息或模型调用。content 保存 `confirmation_id/confirmation_type/answer_schema_version/payload_digest/answer`；商品事实另外保存真实 `mode/source_asset_id/source_version`。复用 API 的 clarification、product facts 请求/答案 schema 与既有事实去重方法，统一放入无 I/O 的 Agent 包，API 原导出和公网协议不变。原始已规范化的确认答案逐字保存，fact set 的去重内容只用于核验领域事实，不能反过来覆盖用户答案。
- 该事件只接受同 owner/turn 下的 `answered` confirmation，版本为 1；重新校验其公开问题摘要、答案完整内容、保存的 confirm response 中 turn/continuation 和事件 scope。source key 固定为 `confirmation:<id>:answered`。已回答后不再按原 pending TTL 判过期；反之，未回答、取消或不支持的 risk 确认不能进入语义历史。clarification 的选项 ID/label、自由文本开关与长度必须对应原问题；商品确认的 product/fact set/version 必须对应真实已确认业务记录。
- 商品确认事件依赖一条 strict `product_fact_set` 引用：`kind/object_id/object_version/content_hash/owner_user_id/product_id/source_asset_id/source_version`，object version 为 fact set 正整数版本的十进制字符串，content hash 覆盖领域去重后的 facts。查询再次验证当前用户、source asset 的归属/状态/版本/商品绑定、product 归属/未归档及 fact set 的归属/版本/确认人/来源/内容。历史 fact set 不必仍是最新版本，不能因新增事实版本把真实旧确认篡改成新事实；当前事实选择由后续宿主上下文另行裁决。clarification 本身无领域资源依赖；模型生成的问题/建议仍须由原调用项保留完整输入依赖。
- 所有 `host_context` 都须经宿主来源验证器，不以存在 turn/trace 或空资源数组替代来源语义校验。缺少验证器、未知事件或返回 false/异常，读取失败且不物化其私有正文。该验证不提供执行/重试权限，生命周期清理和窗口闭合仍分别执行。
- `core_skill_knowledge@1` 只记录当前 turn 已冻结 selection 的核心资源有序引用（primary、所选 Preset、required auxiliary），包含 selection digest、catalog ID/version 和每项 Skill ID/name/definition hash/package ID/resource snapshot ID/package resource ID/path/hash，不复制正文。source key 为 `turn:<turn_id>:continuation:<n>:core-skill`，无 message/trace/import 来源。宿主重读 owned turn，校验 selection hash 和 continuation，再逐项比较原有顺序；optional/L2 不得冒充核心加载，须由真实工具调用/结果另行绑定。
- `previous_attempt_failure@1` 记录同一会话中**紧邻上一轮**的终态失败，用于用户失败后只说「继续/重新生成」时把原请求接续下去。content 只有受控字段 `{turn_id, user_status: blocked|failed, stop_reason}`：`turn_id` 是上一轮（非本轮），`stop_reason` 取该轮 `agent_traces.loop_guardrail_hit`，为空时取该轮最新一处失败步骤的 `error_code`，两者都必须是受控码（`^[A-Za-z][A-Za-z0-9_]{2,63}$`），无法归因时为 `null`。**不得**写入总结、Provider 原文、失败文案或任何自由文本（`docs/08`）。content 只由 `agent_turns.status` 与该轮 trace/step 的受控码推导（均为终态后不可变的行），写入与读取复验调用同一推导函数；**不得**改用 `event_outbox` 等投递日志或任何后续轮次会覆盖的来源，否则条目在后续读取时必然复验失败。source key 固定为 `previous-attempt-failure:<turn_id>`（`<turn_id>` 为本轮），`source_message_id/source_trace_step_id/import_attempt_id/reply_to_item_id/call_ordinal` 均为 null，资源依赖固定为空数组，且仅在 `continuation_no = 1` 写入。上一轮为 `done` 或会话无上一轮时不写该条目。推导口径冻结在 `@1`：改用其他口径必须新增 `@2` 事件名并保留 `@1` 的验证器，否则存量条目会全部复验失败。
- Skill 依赖使用 `kind:skill_resource` 加上述资源身份和 catalog ID/version（不含显示 name）；必须与核心引用完整相等。历史读取只授权已被来源绑定的依赖，不授权工具执行。内置资源从本进程第一方 catalog 解析，要求原 Skill/version、definition、package 和资源身份/hash 仍精确匹配，禁止将旧引用替换成 slug 对应的新正文，也禁止同名外部包作为 fallback。catalog 因其他 Skill 更新而改变不单独撤销内容完全未变的历史引用；原 catalog 身份仍由 source selection digest 绑定。
- 外部历史知识要求原 release 的 manifest/digest/package/Skill/resource 闭包、approved validation report、当前已发布 Skill、当前已批准且未停用/阻断的 package 和资源元数据一致。曾发布后正常 retired 的 release 仍可作历史来源，切换 active catalog 本身不撤销旧知识；这不放宽当前执行的 active release 校验。风险复审到期（使用数据库时间）、源 hash/身份漂移或停用立即拒绝历史读取，不等待清理任务。授权阶段只读资源元数据；真正物化正文还须在授权后检查正文 hash，并在返回前再次授权。
- 资源依赖逐项使用宿主注入的既有 attachment/Skill snapshot 身份 schema，无损校验并拒绝重复条目；模型输出仍需由 repository 校验保守继承的完整依赖。tool result 的依赖至少覆盖父 assistant 依赖。空数组、声明的 scope 或通过 schema 均不是当前权限证据。
- `inspect_image@1` 与 `load_skill@1` 的捕获复用 Worker 实际执行的 strict 参数 schema（置于 Agent 共享契约），不另造宽松历史版。输出整批验证后才可提交/执行；无法通过校验的后续成员不能使前面的成员先执行。历史协议保持模型原调用顺序；wire ID 由 item ID/ordinal 派生，不以 Provider call ID 授权或幂等。
- 两个只读工具的 `succeeded` 语义分别为：图片的完整已鉴权 attachment binding、请求 detail 和 `materialized:true`；知识的 Skill ID、view、`already_loaded` 及该次实际加载的有序 Skill 资源依赖引用。知识资源不复制正文，图片不保存二进制或 URL。图片结果必须对应原 binding key/detail，知识结果必须对应原 Skill/view/reference paths，optional planning 只返回该 Skill 的 `SKILL.md`。结果依赖为父调用依赖与真实结果资源依赖的完整并集。
- 工具批次 source key 由宿主固定为 `model:<llm_step_id>:output`，结果固定为 `assistant:<assistant_item_id>:result:<ordinal>`。tool result 读取必须提供结果来源验证器，按已验证父调用复验真实请求与语义结果的对应关系；不存在验证器或不匹配时，在私有结果物化前拒绝。此验证不能证明前面的模型输入依赖完整，也不取代 live 授权、整批闭合和领域 operation 恢复。
- 工具 `rejected` 只保存稳定 public error code；`not_executed` 保存 `earlier_call_failed | turn_interrupted | turn_superseded | turn_expired | lease_lost | budget_exhausted` 原因；`unknown` 仅保存稳定 public error code。拒绝、未知和未执行不能携带伪成功正文。上述两工具为只读，结果并不提供付费执行/重试权限；模型输出、来源授权、整批闭合及事务 fencing 均是独立门槛。遗留 trace 摘要缺少原始参数，不能经这些 schema 猜测补齐。
- 普通 prepare 不接受 `redacted`；读回复验可识别下文 tombstone，但纯协议校验遇到它必须拒绝可执行回放，不能伪造闭合/成功。整组不可用投影及已闭合证明留给生命周期实现。
- 纯协议校验接收显式 user/session、连续 sequence 区间和 `require_closed`。区间起点必须来自真实开头或 repository 验证过的闭合检查点，不接受丢掉 pending 父项后自称完整；校验器自身不证明数据库无缺页。逐条复验 digest、身份、来源去重；同一会话上一个调用批次未闭合前禁止新 assistant 输出，user/host 事件可以穿插。result 只能指向前面的实际 assistant、真实 ordinal、同 turn、同工具/参数 digest；恢复结果允许来自新的 continuation，不要求与父 continuation 相等，但不得早于父 continuation。工具和 terminal 均遵守此条件，纯协议层与 repository 层必须一致拒绝倒退。
- 结果可按完成顺序追加，协议检查按原 ordinal 判定：任一 rejected/unknown/not_executed 后的更高 ordinal 只能为 not_executed，不能继续标成功。require_closed=false 只报告缺失协议项，不执行、不推断是否已投递；true 在缺结果时拒绝。规范 wire ID 为 `call_` + 去短横线的小写 assistant UUID + `_` + ordinal；它不是 operation key，不用于费用幂等。唯一配对和完整性检查不能代替持锁事务、owner fencing、领域 receipt 或权限。
- envelope 的 64 KiB 按规范化后完整 payload_json 的 UTF-8 字节计算，payload_digest 覆盖完整 envelope；读回重新计算。JSON 安全与无损规则复用私有 payload 层，不增加第二套 canonical 算法；错误仅输出固定内部分类，不附正文或底层异常。sequence 必须先通过格式/长度校验，再执行 bigint 范围转换；不能仅在转换之后捕获超长或非数字输入的异常。

**模型输出的来源绑定 (2026-09-08)**

- 所有原生 `assistant_output`（包括 terminal）必须引用本用户、本 session、本 turn 的真实 `llm_call/agent` step。读取入口强制执行同一来源检查，不提供省略检查的可选回调。该 step 必须 `succeeded` 且无 error code，purpose 必须为 `agent_step`，原始 continuation 必须与 item 一致；当前 turn 可以已经进入更晚的 continuation。缺 step 或来源标记时，在依赖授权和私有参数读取之前拒绝。
- 外部调用前，宿主从本次实际有效输入（核心知识、有效摘要、历史窗口、图片与权威上下文）构建完整、去重且顺序稳定的资源依赖数组，并在原 step 的 `input_summary.transcript_input` 冻结 strict `{schema_version:1,step_id,continuation_no,resource_dependencies_digest}`。digest 复用 shared canonical SHA-256，覆盖整个有序数组；每个依赖仍使用既有 strict schema、无损校验和重复检查。空数组也必须有明确来源证明。不得在输出返回后用输出自身声明的依赖补写输入标记；纯摘要构造器不证明宿主已经完整收集实际模型输入。
- 成功输出接受时，在 assistant item/usage 的同一事务写 `output_summary.transcript_output`，strict `{schema_version:1,step_id,assistant_item_id,sequence_no,payload_digest}`。绑定真实 item 身份、顺序和完整 envelope 摘要，不记录正文。source key 固定为 `model:<step_id>:output`；assistant 不携带 message/import/result 来源。输出依赖必须逐项、按冻结顺序与输入依赖摘要一致；工具结果新增的资源仅在下一次模型输入中继承。
- 创意写作原始结果只取 adapter 返回且通过一致性校验的 `authoring_output`（`02`），转换为 terminal `agent_author_prompts@1` 的完整有序参数，必要时用 `authoring` 私有 payload。直接 `agent_candidate_plan@1` 与写作结果不可混淆；不能从合并后的业务计划补造写作调用、参数顺序或 Provider ID。Provider ID 只接受 1-128 位安全 ASCII 标识，否则保存 null；原始响应与隐藏推理均不持久化。
- 读取必须验证 source key、输入及输出标记、原 continuation、item ID/sequence/envelope digest 和完整依赖 digest，不以 UUID 存在、JSON 自报 hash 或 trace 的 outcome 文本代替接受证据。私有参数仍按引用位置展开并复核 content hash，来源绑定不取代当前资源权限、预算、领域结果来源和协议闭合检查。
- trace 仍不存语义正文。绑定所需的最小 step 身份/归属/状态/摘要证据必须与可读 transcript 生命周期兼容；清理诊断细节不能提前删除这些证据。完整生命周期接入前保持捕获关闭；来源已缺失时拒绝读取，不自动补造标记、不从日志恢复、不重放付费动作。保留和清理边界同时遵守 `08`，不为绑定无限期保留 prompt。

**Terminal 捕获与结果来源 (2026-09-08)**

- 捕获器复用 Brain 的回答、澄清、商品事实参数 schema，以及 Compiler 的候选计划 schema。回答映射 `agent_respond@1`，澄清映射 `agent_request_clarification@1`，商品事实映射 `agent_request_product_facts@1`；planning 候选与待写作草案均为 `agent_candidate_plan@1`，真正写作调用只允许 `agent_author_prompts@1`。宿主显式传入本次 phase，禁止将缺少原始写作结果的合并计划误标成 planning。usage 独立结算，不混入工具参数。
- planning/authoring 参数按其既有 schema 完整写入对应私有 payload，envelope 只保留受控引用与内容 digest。不按字符截断、不复制到 trace，也不从合并计划重建原调用。其余小型 terminal 参数 inline；未经 schema 接受的输出不伪造成功 assistant 调用。
- 成功 terminal 的内部结果分别为：回答 `{type:message_published,message_id,content_digest}`；澄清或商品事实 `{type:confirmation_requested,confirmation_id,payload_digest}`；已有事实 `{type:facts_already_confirmed,dependency:<product_fact_set dependency>}`；草案交接 `{type:authoring_required,plan_digest}`；非最终写作批次 `{type:authoring_batch_saved,arguments_digest}`；最终计划 `{type:quote_created,quote_id,plan_digest}`；Compiler 跨上传组澄清 `{type:scope_confirmation_requested,confirmation_id,payload_digest,scope_digest}`。写作批次只配对 `agent_author_prompts@1` 且 digest 必须等于该调用参数 digest；以私有 payload 原文恢复已完成 key，完整覆盖之前不得产生报价或 workflow。范围澄清只配对已捕获的 `agent_candidate_plan@1` 或 `agent_author_prompts@1`，读取时复核同用户同 turn 的 clarification 和两个 digest；写作调用不能成功产生普通 `confirmation_requested`。报价结果仅证明 `run_quote` 已创建，不能声称 workflow/Provider 已提交。失败与未执行复用知识工具的有界 code/reason schema，不写异常原文。

2026-10-02 输出诊断扩展：失败 outcome 可携带 strict `output_diagnostic`（截断/JSON 解析/schema/协议类别、标准化 finish reason、本次 requested output）。其安全字段进入 trace 和配对 runtime policy，且计入语义 digest；可用 reasoning token 统计保留在 usage，但不重复计费或保存推理内容。既有摘要 usage 也兼容该可选计数，不改变覆盖范围、资源依赖和 CAS。

- terminal 结果必须与其真实父调用、原 continuation 或更晚 continuation、原模型 step 对齐。除结果 envelope 外，在提交结果与领域 receipt 的同一事务保留原 step 的 `output_summary.transcript_result`：strict `{schema_version:1,assistant_item_id,call_ordinal:0,result_item_id,continuation_no,sequence_no,payload_digest,arguments_digest,resource_dependencies_digest}`。该标记不包含正文，不能由恢复器从待验证结果反向补写。
- 读取先核验 owned 模型接受标记和结果标记，再按本 user/session/turn 核验真实 message/confirmation/quote 或已确认 fact set 的身份与 digest；草案交接 digest 必须对应原 planning 参数。结果继承父调用依赖，已有事实另继承其完整事实版本依赖；当前资源授权仍独立执行。标记缺失、领域 receipt 缺失、hash/归属不符均拒绝，不能以模型自己声明“已成功”代替宿主结果。
- 回答 digest 对应原 `text` 经既有公开文案策略的 NFC 规范化；澄清问题与有序选项必须对应原调用，不能只证明同 turn 内存在一个确认。商品事实成功结果的原 `source_binding_key` 必须存在于父输入依赖且为 owned product asset；新确认核对原资产/version/候选事实，已确认事实核对请求资产仍属于该 fact set 的商品。一个商品的不同合法图片可以复用同一事实版本，不能误要求所有请求图片都是该 fact set 的原始取证图。
- 开启捕获的 model step 一旦接受成功，不得被后续 ToolPolicy、公共文案、Compiler 拒绝改写为模型失败，亦不得丢失 input/output/result 绑定标记。后续拒绝属于独立工具结果/诊断；legacy 路径在排空前保留原行为。捕获构造器与只读来源验证器不等于原子提交、恢复或生产接入已经完成。

**模型结算接入约束 (2026-09-09)**

- 已捕获步骤的后续业务摘要只更新 `output_summary.downstream`，保留模型接受状态、usage 和所有来源标记；独立 guardrail/compiler/tool step 仍记录业务失败。更新必须限定 user/session/turn/trace 和模型步骤身份，不接受仅有 step ID 的跨域写入。
- 捕获模式下的 reserve/settle 使用 owned session -> turn 锁与有界事务；reserve 在外部模型调用前保存完整输入依赖摘要及实际 `transcript_phase`。settle 必须与已保留的 phase、模型快照、exposure 和依赖摘要一致，不接受调用方临时改 phase/删依赖/改费率。
- 合法输出的 item/private payload、输出标记与 usage/成本合计同事务提交。幂等重入不再次结算；不同输出、usage 或来源冲突明确拒绝。不能为修复 transcript 再调用模型或工具。严格 schema 拒绝的模型输出只结算既有 usage 并保留失败诊断，不伪造一个合法调用。
- 未传完整捕获上下文的已开启 turn 必须拒绝；普通 legacy turn 不接受捕获参数，不能由调用方越过持久化开关。宿主仍负责实际输入依赖收集和授权，以上 repository 接入不等于开启生产捕获或 P2 已完成。

### agent_transcript_payloads

保存没有合适现有业务存储的已验证 planning draft、authoring output 或工具语义数据，不是日志或任意大对象仓库。

| 字段                    | 类型        | 说明                                                                    |
| ----------------------- | ----------- | ----------------------------------------------------------------------- |
| `id/user_id/session_id` | uuid        | 私有 payload 身份及租户/会话归属                                        |
| `turn_id`               | uuid?       | native payload 必填；只有真实来源无 turn 的 legacy_message payload 可空 |
| `import_attempt_id`     | uuid?       | 导入副本必填，其他 payload 为空；与引用 item 的导入归属一致             |
| `kind/schema_version`   | string/int  | strict planning/authoring/tool/legacy_message payload 判别及版本        |
| `content_json`          | json        | 保留必要语义的已验证数据；禁止图片二进制/Provider 原始响应/隐藏推理     |
| `content_digest`        | sha256      | 共享 canonical JSON 的内容 hash                                         |
| `byte_size`             | int         | 规范化 UTF-8 实际字节数                                                 |
| `created_at`            | timestamptz | UTC                                                                     |

payload 与引用它的首条 item 同事务创建；非导入记录以 `unique(turn_id,kind,content_digest) where import_attempt_id is null` 支持同 turn 去重；导入副本以 `unique(session_id,import_attempt_id,content_digest) where import_attempt_id is not null` 去重。同 hash 不允许跨租户共用，也不能让失败导入引用已启用/native payload 后误删。依赖由引用 item 完整记录并在物化 payload 前校验。单 payload 安全上限 8 MiB，不是创意 prompt 目标长度；P1 必须用现有合法最大输出夹具验证该存储边界不缩小已有能力。超限应走已有受控资源引用或明确拒绝，禁止删字段/截断 JSON 后执行。JSON canonical/digest 统一复用 `packages/shared` 的 `canonicalSha256` 及其规范化实现，不新增第二种排序/数字/空值口径。

**P1 私有 payload 校验接口 (2026-09-07)**

- 私有引用的 strict v1 结构固定为 `{schema_version:1,type:private_payload,payload_id,kind,content_digest,byte_size}`，不携带正文、URL 或由模型声称的 owner。引用摘要必须覆盖上述全部字段；完整 item envelope 仍按自己的 schema/type 计算 `payload_digest`。
- 校验层接收宿主提供的 `user_id/session_id/turn_id/import_attempt_id`；后两项必须显式为 UUID 或 null。`legacy_message` 必须有 import attempt，可保留真实 turn 或 null；其他 kind 必须有 turn，且 import attempt 为 null。读回记录的四项归属、ID、kind/version、hash 和实际字节数必须与宿主范围及引用完全一致，不以 hash 相等允许跨 turn/导入批次复用。
- 元数据及引用中的 UUID 先严格验证标准带连字符格式，再统一为小写进行返回和身份比较，与数据库 UUID 的规范表示一致；大小写不同不代表不同身份，真正不同的 UUID 仍必须拒绝。此规范化只作用于 scope/record/reference 的身份字段，不改正文中的字符串、URL、digest 或领域参数；引用 envelope 的摘要使用规范化后的字段。
- 内容校验由宿主注入对应 kind 的既有领域 schema：planning 复用 Compiler 候选 schema，authoring 复用 Agent authoring schema，tool 复用注册工具的语义 schema，legacy_message 由导入器严格校验真实来源消息。Agent 不反向依赖 Compiler，也不接受一个通用 `record(unknown)` 代替领域校验。工具策略、编译授权和领域事实复验仍由原模块负责。
- 写入与读回复验都只接受已规范化且可存入 PostgreSQL JSONB 的 JSON object：拒绝非 JSON 值、稀疏数组、循环、二进制/类实例、accessor，以及字符串/key 中的 NUL 或未配对 UTF-16 surrogate；领域 schema 必须成功且解析前后的 shared canonical JSON 完全一致。若 schema 剥离字段、裁剪文本、补默认或强制转换，持久化层明确拒绝；宿主应在捕获之前按原有路径完成规范化。不得为了写入成功悄悄改变历史语义。
- 同一 object 中不同 key 若被现有 shared canonical 比较器判为相等，写入和读回均以 `json_invalid` 明确拒绝；检测复用 shared 的同一比较器，不另造排序或偷偷修改已有 hash 规则。不得规范化、合并或删除这些 key；此约束不限制 Unicode 正文值，也不拒绝单独出现的合法 Unicode key。现有比较器的跨运行环境兼容性及所有合法领域输出的可存储性仍是激活前验收项，不能据此宣称全局 canonical 已完成升级。
- `byte_size` 按 `Buffer.byteLength(canonicalJson(content),'utf8')` 计算，`content_digest` 复用 `canonicalSha256(content)`；写入结果与输入对象分离并冻结，防止校验后被改写。读回同时检查声明字节数、实际字节数、记录摘要与引用摘要。错误仅提供固定内部分类，不附 Zod issue、正文或底层异常原文；这些分类不是新的公网错误码。
- 本层为无 I/O 的完整性校验，不是鉴权服务。repository 必须先在一致的受控读边界核验引用 item 本身的归属、未撤销状态、真实来源和完整资源依赖，再读取私有正文；不得把传给校验器的 scope 或空依赖数组当成授权证据。真实 PostgreSQL 读端口、item 全部 envelope、工具协议配对与原子 append 仍分别验收。通过本层测试不放行 8 MiB 最大合法输出兼容门禁或 P1 捕获。

Worker 的 owned read repository 必须按 `user_id + session_id` 读取未归档 session，再按 `user_id + session_id + item_id` 读取 item；不得使用裸 UUID 查询作为授权。它必须重新验证 turn、message、trace 的复合归属，并由宿主注入真实消息语义校验器和当前资源依赖授权器；授权器缺失或返回 false 一律拒绝。私有 payload 只能在依赖授权通过后按 `payload_id + user_id + session_id` 读取，并使用 item 对应位置的既有 domain schema 校验，不能按 `kind=tool` 共享一个宽 schema。读结果只能返回 detached item 和已授权的私有语义值，不返回 DB entity、完整 trace、prompt、签名 URL 或二进制。

物化之后、返回之前再次检查 item（以及 tool_result 的父调用）的 live 依赖和 session generation/message history revision：资源撤销可能先于异步清理，generation 未变不代表仍有权限。授权器不得复用跨读取的成功缓存。固定分类 `storage_unavailable` 仅用于封装未预期的数据库读取异常，不附底层 cause、查询参数或正文；它不授予调用重试权限。单 item 读取只验证来源及父子局部关系，不证明完整窗口闭合、兄弟结果顺序或领域任务成功。

### transcript 写入、导入与摘要约束

**锁与原子性**

- 所有涉及 session/message/transcript/summary 的写入遵循同一顺序：请求幂等 advisory lock（如有）-> credit account（仅本事务原本需要资金锁时）-> `chat_sessions FOR NO KEY UPDATE` -> 涉及的 `agent_turns`（按 ID 稳定排序）-> 既有领域行锁 -> semantic payload/item -> trace -> outbox。多 outbox scope 按 `(scope_type,scope_id)` 稳定顺序锁定。普通语义写入不得为序号新增资金账户锁。
- 分配序号选择 session 行锁，不另加 transcript advisory lock。在该锁内为本批新 item 分配连续区间并推进 `transcript_next_sequence`；counter、items、对应 chat message、状态 CAS、适用的 trace/outbox 同事务。禁止未加锁 `MAX+1` 或预先分号后分事务写入。
- 不可在已经拿到 turn 或 trace/outbox 锁的 helper 内补拿 session 锁。调用者必须先用只读定位取得 session/user，再按统一顺序加锁并重验；`completeForWorkflowOutcome` 等结算调用者必须在业务子行/turn 锁之前取得该 session 锁，不能只修 Agent loop。资金仍只有 Credit 负责，原有费用幂等不变。
- owner/revision/continuation 仍是执行 fencing，session 锁不能取代它。业务终态回调按 workflow/turn 归属和允许状态 CAS，不冒充旧 processing owner。append/import 页事务禁止网络调用；默认 lock timeout 1s、整笔事务上限 5s，由 typed config 校验，不复制到 `.env.local`。
- 影子写入也可能引入锁等待、事务回滚和写放大。严格写入失败不能伪装“影子完整”；外部动作之前未提交则不得执行，外部动作之后提交失败则保留领域 receipt 并恢复原 operation，绝不为修复 transcript 重新生图。失败处理不在已超时事务内无限重试。

**Worker 原子写事务入口的实现边界 (2026-09-08)**

- 独立的 owned-turn 写事务入口只服务已经 claim 的语义写入，必须自己开启事务；不能传入已持有 turn/领域/资金行锁的事务。显式核对 user/session/turn、capture version、session mode/generation、owner/revision/continuation 和服务端 lease，先 session `FOR NO KEY UPDATE`，后 turn `FOR UPDATE`。该入口不用于 create/confirm、回填、claim、跨 turn 终态回调或资金结算，它们仍需按统一锁顺序分别接入。
- session 只接受已完成验证的 strict shadow/active v1 检查点，counter 必须大于已验证游标；不修改 mode、执行格式或捕获开关。过期租约、归档、旧 generation、错误归属、未开启捕获和终局 turn 均在宿主写回调之前拒绝。写回调结束、提交之前再次核对最初锁定租约仍有效，不能凭事务开始时有效就提交超时晚到结果。
- typed 写事务预算默认锁等待 1s、总事务 5s，测试可缩短但不能超过默认安全上限。PostgreSQL 16 的 statement/idle timeout 不能单独代表总事务 timeout；入口对每一条受控 SQL 按数据库 `transaction_timestamp/clock_timestamp` 的剩余预算设置 statement/idle timeout，同时以宿主计时器使挂起回调回滚。宿主截止点预留最多 50ms（不超过总预算 10%）处理回滚，避免正常超时路径由数据库先断开空闲连接；数据库仍保留原总预算的兜底。锁等待也不得超过本次剩余时间。
- 回调只能经事务 scope 的串行 query 入口执行单条数据库查询，不得保留原始 transaction、遗漏 await 或进行网络 I/O。一次 query 失败、并发 query、预算耗尽或 scope 关闭即污染该 scope，回调捕获异常也不能继续写入或提交；晚到回调不能复用已关闭 scope。该门槛只提供事务/执行 fencing，不证明来源授权、完整批次追加、payload 去重、消息/trace/outbox 原子捕获或全工程锁顺序已完成。

**Owned native 批次追加边界 (2026-09-08)**

- 追加原语只在上述已持有 session/turn 锁的 scope 中工作，不自行再开事务；调用者必须先完成真实来源和依赖校验，并在同一 scope 内提交对应领域投影/usage/接受标记。它不是独立的生产捕获入口，也不负责 backfill、收费提交或调用工具。
- 单批最多 16 个 item、envelope 总计不超过 1 MiB，受控私有正文总计不超过 64 MiB；单 envelope/payload 仍遵守已有 64 KiB/8 MiB 上限。这些是 typed 存储与内存边界，不是模型创意字符目标。完整模型批次不能为了通过限制拆掉或丢掉成员。
- 以锁内当前 counter 为起点，只为本批新来源分配连续序号。重复 source key 必须核验同一归属、原 continuation、来源、完整 envelope、依赖和配对；内容相同返回原 item ID/sequence/created_at，内容冲突拒绝整批。caller 新分配的临时 item/payload ID 不得制造语义重复；同批父子引用随已有 canonical item ID 对齐。
- 私有正文按本 turn/kind/content digest 去重，重用前验证完整内容和字节数；私有引用必须解析到同 owner/session/turn 的已验证正文。多余、缺失、跨作用域或被篡改的正文均拒绝；不执行无意义的孤立 payload 写入。更新后的 canonical 引用进入返回 item，调用者以实际返回 item 创建来源标记，不使用分配前的临时 digest。
- 追加前从最近一个真实 assistant 起检查其连续尾部和新批次的配对，最多检查 200 条历史尾部；超界明确拒绝，不跳过 pending 调用。新 assistant 不能越过未闭合调用，结果不能重复或指向更早已闭合批次。完整历史窗口与撤销组投影仍由生命周期/读取层负责。
- 任何追加错误均使 scope 失效，调用者捕获异常也不能提交已写 payload/消息。scope 提供显式 `abort()`，以固定 `scope_rejected` 原因污染并结束事务。已撤销 source key 不接受旧正文重新追加；保留原 tombstone，不重置 generation/mode 或执行格式。

**旧历史导入与切换**

- backfill 只构建尚未启用的 transcript，读路径继续 legacy；每页最多 200 条且 envelope 合计不超过 1 MiB，独立短事务写入 item 与游标。来源按真实 `(created_at,id)` 排序，记录 message ID/role/内容 digest/归属，旧 tool 摘要只标为 legacy observation，不臆造 tool call 或执行参数。
- 导入前冻结 source revision/截止点；message 写入和资源撤销推进对应 revision 或使导入失效。导入期间用户仍可继续走 legacy，不能为回填占用整段长事务。来源变化时该 import attempt 不得激活，待无活跃任务后重建尚未启用的派生副本；清理仅限该未启用 import attempt 的复制行，不改源 message、业务证据或 migration 历史。
- 导入验证在事务外分页计算有序来源内容 digest；最终短事务锁 session，核对 source revision 未变、数量/digest 一致、无未终局 turn/workflow，再进入 shadow。校验期间来源改变就重试验证/导入，不能跳过旧消息让用户进入一个看似完整的历史。未完成导入的 session 保持 legacy 并在切换报告列出，不算 P2 已覆盖。
- shadow 只记录新 turn 的完整语义，不用其驱动模型。由 compatible API/Worker 同时写入且验证完整后，才能对无旧执行任务的 session 切 active。历史 legacy_message 明示缺失的原生工具细节；不得因有摘要就宣称旧工具历史可精确恢复。
- 新 session 同样默认 off；受控部署/本地验收命令在短事务内验证空历史或完整导入后才进入 shadow，mode 不由公网请求指定。切换后发现完整性缺口则进入 invalid，停止新格式创建并告警；已冻结的新格式 turn 必须由兼容恢复处理或明确失败，不能降级成 legacy 重新执行。撤销后的可用视图只有重新验证通过才可使用，mode/generation 变化不得修改 turn execution_format。
- 普通语义数据启用后追加不可改；撤销/删除遵循 `08` 的受控生命周期并使 generation/checkpoint 失效。源消息投影更新不能悄悄改旧 transcript，需追加带来源的更正或执行隐私清理。
- 隐私清理将 `payload_json` 替换为 strict `redacted` envelope，只保留 `schema_version=1/type=redacted/reason/original_payload_digest/redacted_at`；reason 只允许 `resource_revoked | privacy_erased | retention_expired`。保留 item 身份、sequence、source key 和协议关联，不伪造原调用/结果正文；`payload_digest` 重算为 tombstone 的 canonical digest。命中已撤销 source key 的旧 append 必须拒绝，即使提交原 digest 也不得复活内容。所有引用该私有 payload 的 item 先在同一受控清理事务撤销，才可删除 payload；有效视图拒绝将 tombstone 当作成功结果，P2 仅将已闭合且整体不可用的协议组投影为带来源的不可用事件。
- 撤销后的读门禁先检查资源当前权限与生命周期，再读取/物化依赖正文；不能等待异步 sweeper 清理完才拒绝。清理同事务推进 generation、使 summary/checkpoint 和未启用导入失效。若旧数据没有足够来源证明依赖仍有效，不能用空依赖数组冒充验证通过。

**summary v2**

原生窗口读取采用 session 内 `sequence_no` keyset，不使用 offset。读取开始冻结 generation、message revision 和 next sequence；每页最多 200 项，单窗口最多 2048 项、私有正文与 envelope 合计最多 128 MiB，均为 Worker typed defaults，不新增部署环境变量。超限明确失败，不截断 JSON 或跳过 active turn。非首窗口先验证起点以前最近调用批次已经闭合；整段读取后重新授权全部依赖并核对冻结边界，尾部追加也要求重新读取，以免遗漏刚完成的结果。这是读取资源预算，不扩大模型 token/成本预算。

复用 `chat_sessions.summary_json/summary_version`，新增 strict v2 内容：`history_generation/covered_from_sequence/covered_through_sequence/source_content_digest/source_turn_ids/resource_dependencies/model_snapshot/usage` 和安全摘要。CAS 同时检查 user/session、expected summary version、expected generation 和覆盖来源；内容 digest 包括 item 顺序、payload hash 与实际投影版本。压缩发布使 generation 递增并记录新值，普通追加不改变它。legacy v1 summary 可继续服务 legacy turn，但不能直接冒充 transcript v2 checkpoint；新格式首次压缩须从真实已导入范围重新建立检查点。`summary_through_turn_id` 保留兼容投影，不取代 sequence 覆盖范围。资源撤销导致来源不可用时旧 summary 不得进入模型。

### skills

| 字段                | 类型      | 说明                                                               |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `id`                | string    | `slug@version`                                                     |
| `slug`              | string    | 技能标识                                                           |
| `name`              | string    | 用户安全展示名称                                                   |
| `category`          | string    | catalog 分类                                                       |
| `domain`            | enum      | creative/commerce                                                  |
| `kind`              | enum?     | primary/auxiliary；null 仅兼容 S08 前 legacy row                   |
| `visibility`        | enum?     | public/internal；null 仅兼容 S08 前 legacy row                     |
| `stage`             | string    | 启用阶段                                                           |
| `version`           | string    | 精确 semver                                                        |
| `package_record_id` | uuid?     | 来源 `skill_packages.id`；仅 S08 前 legacy row 可空                |
| `skill_digest`      | sha256?   | definition 与该 Skill 全部资源的 canonical digest；S08 新 row 必填 |
| `definition_json`   | json      | strict 不可变知识、Preset、依赖和 catalog 定义快照                 |
| `definition_hash`   | sha256?   | canonical definition hash；S08 新发布 row 必填                     |
| `sort_order`        | int       | 公开 catalog 稳定排序；默认 0                                      |
| `price`             | json      | 旧 schema 兼容展示元数据；不是费用真相                             |
| `status`            | enum      | draft/published/disabled/archived                                  |
| `published_at`      | datetime? | 发布时间                                                           |

约束：

- `unique(slug, version)`。
- S08 新 row 必须具有 `kind/visibility/package_record_id/skill_digest/definition_hash`；`kind=primary` 才允许 `visibility=public`，`kind=auxiliary` 必须 `visibility=internal`。legacy null row 不进入 catalog 或 S08 runtime，受控补齐只能通过新版本发布，禁止猜测回填。
- 一个精确 `slug@version` 只能由一个 package record 拥有。另一个 package 即使声明相同正文也必须引用已安装精确 dependency 或使用新的 Skill version，不能复制占用同一 ID；同 ID 不同 skill digest 返回版本冲突。
- 已发布版本不得更新 `name/category/domain/kind/visibility/stage/version/definition_json/definition_hash/sort_order/price`，只能新建版本；`disabled/archived` 只影响新选择，不改变历史 turn snapshot 回放。
- `definition_json` 只保存 strict 知识定义：安全 catalog 元数据、planning view 索引、Preset slots、精确一跳 dependencies、required facts/capabilities 和 references；不得保存 Key、可执行授权、价格真相或任意 Provider endpoint/header。
- primary 可声明 Preset 和精确一跳 required/optional auxiliary；auxiliary 不得声明 Preset 或 dependency。Preset resource 必须属于同一 primary 发布包，不能跨 Skill 引用。
- `definition_hash = sha256(canonical_json(definition_json))`；发布服务写入前重算，运行时不信任客户端 hash。公开 catalog version 由返回 primary 的 `id + definition_hash + sort_order` 派生。
- `required_capabilities` 只声明知识依赖，不能注册/授权工具；`price` 不得被 Compiler 或 Credit 直接用于报价，费用真相来自 S04/S09 的不可变 model/pricing/plan snapshot。

### models

保存 Provider PoC 形成的能力契约：

| 字段                       | 类型      | 说明                                          |
| -------------------------- | --------- | --------------------------------------------- |
| `id`                       | uuid      | 主键                                          |
| `provider`                 | string    | Provider                                      |
| `provider_channel_id`      | uuid?     | S14 精确通道；S14 前 legacy/fake row 可空     |
| `protocol_family`          | enum?     | `openai                                       | anthropic        | google`；与 API 变体严格匹配；S16 前仅建档的 video draft 可空 |
| `api_variant`              | enum?     | `openai_chat_completions                      | openai_responses | anthropic_messages                                            | google_generate_content | openai_images`；S16 前仅建档的 video draft 可空 |
| `model_id`                 | string    | 模型标识                                      |
| `version`                  | string    | 版本                                          |
| `capability_contract_json` | json      | 能力契约                                      |
| `pricing_json`             | json      | 计价契约                                      |
| `quota_json`               | json      | 配额契约                                      |
| `status`                   | enum      | poc_passed/poc_failed/disabled/free_test_only |
| `status_evidence_digest`   | string?   | 最近一次受控状态裁决证据 SHA-256              |
| `status_operator_id`       | string?   | 最近一次受控状态裁决操作者标识                |
| `status_reason`            | string?   | 最近一次受控状态裁决原因                      |
| `status_changed_at`        | datetime? | 最近一次受控状态裁决时间                      |
| `created_at`               | datetime  | 创建                                          |

约束：

- `unique(provider, model_id, version)`。
- S14 新建并准备进入 catalog 的 row 必须绑定 active `provider_channel_id`；legacy/fake row 可空但不能因此进入 production catalog。credential 轮换只切换 channel 的 active credential，不改历史 model snapshot。
- `capability_contract_json/pricing_json/quota_json` 必须由 `packages/provider` 的版本化 strict discriminated union 从 `unknown` 校验；金额和比率使用 decimal string，不用 JSON number 表达金额。
- S07 已存在的媒体/审核模型快照使用 `media@v1` capability/pricing/quota 三件套。S12 新建的内部审核模型继续使用该 strict schema，但 capability 必须是 `moderation.text`、`moderation.image` 或两者的非空子集，禁止混入生成/编辑能力，也禁止创建用户 catalog entry 或积分 SKU。S14 新建并准备进入用户 catalog 的媒体生成模型必须使用 `media@v2 + media_rate_card@v2` 三件套。Agent Brain 使用 `agent_brain@v1 + agent_brain_tokens@v1 + agent_brain@v1` 三件套。三者必须按各自 schema 成套校验，不能拼成全部字段可选的宽松对象，也不能让 media Gateway 接受 Agent Brain row 或反向接受。
- Agent Brain capability 至少固定 `capabilities=['agent.brain']`、input modalities、原生 tool protocol、strict terminal protocol、usage token 支持、context/output/tool-call 上限；pricing 至少固定 request base 与 input/cached-input/output 每百万 token CNY 单价；quota 至少固定 RPM/concurrency、小时/日预算、turn rounds/input/output/cost 上限、timeout 和 circuit 参数。精确 strict schema 以 `03` Agent 大脑补充契约为正文。
- `provider/model_id/version/protocol_family/api_variant/capability_contract_json/pricing_json/quota_json` 创建后不可变；能力、价格、配额、channel/base URL、endpoint/region 或模型版本变化必须创建新 row，禁止原地覆盖历史 workflow/task 引用。
- status 只允许通过领域 Service + expected current status CAS 转换：`free_test_only -> poc_passed | poc_failed | disabled`、`poc_passed -> disabled`；`poc_failed/disabled` 为终态，需要恢复时创建新的精确模型版本。运行时可恢复熔断使用 `provider_circuit_states`，不反复修改 model status。
- status CAS 与 `status_evidence_digest/status_operator_id/status_reason/status_changed_at` 必须在同一条领域写入中持久化；S14 前 CLI 输出日志不替代数据库审计真相。
- `free_test_only` 只允许显式 PoC；收费 route 只接受 `poc_passed`，且仍需检查持久化 circuit state。

### model_poc_runs

S14 的模型验证不能只在前端显示一次请求结果，也不能让管理员直接把模型改成 `poc_passed`。每次固定能力探测保存不可变运行证据：

| 字段                        | 类型         | 说明                                                     |
| --------------------------- | ------------ | -------------------------------------------------------- |
| `id`                        | uuid         | PoC run                                                  |
| `model_snapshot_id`         | uuid         | 精确不可变模型                                           |
| `provider_channel_id`       | uuid         | 使用的通道                                               |
| `credential_version_id`     | uuid         | 探测时 active Key 版本，仅保存 ID                        |
| `probe_suite_version`       | string       | 编译期固定夹具/断言版本                                  |
| `requested_spec_keys_json`  | json         | 要验证的 capability spec keys                            |
| `status`                    | enum         | queued/running/passed/failed/outcome_unknown/cancelled   |
| `queue_dispatch_intent_id`  | uuid?        | 可靠入队                                                 |
| `result_summary_json`       | json         | 脱敏断言、延迟、usage/cost 摘要；无 prompt/原文/签名 URL |
| `evidence_digest`           | string?      | canonical 证据摘要                                       |
| `revision`                  | int          | Worker CAS                                               |
| `requested_by_admin_id`     | uuid         | 发起人                                                   |
| `created_at/started_at/...` | timestamptz? | 生命周期；created_at 必填                                |

约束：PoC Producer 只接受 ID、编译期 `probe_suite_version` 和 `expected_model_status=free_test_only`，不接受管理员自定义 prompt/URL/header。Provider 调用在数据库事务外；结果通过 revision CAS 落库。每个 model 同时最多一个 queued/running run，显式重验使用递增 `attempt_no`；`revision > 0`，processing owner/lease 必须成对且只允许出现在 running。`outcome_unknown` 不得自动重投，也不得作为通过。model 转 `poc_passed` 必须引用同一 model/channel 的最近 passed run，且其 suite 覆盖全部待发布 spec；S16 前 video run 创建 fail closed。

### moderation_runtime_states

保存 S12 内部内容审核路由的数据库真相，不借用用户 catalog、进程环境变量或“最新模型”查询：

| 字段                       | 类型        | 说明                                          |
| -------------------------- | ----------- | --------------------------------------------- |
| `capability`               | string/enum | 主键；`moderation.text` 或 `moderation.image` |
| `active_model_snapshot_id` | uuid?       | 当前精确 `models.id`；为空即 fail closed      |
| `runtime_revision`         | int         | expected revision CAS，从 1 开始              |
| `updated_by_admin_id`      | uuid?       | 最近切换管理员                                |
| `updated_at`               | timestamptz | 更新时间                                      |

约束：前向迁移预置两个 capability row，`runtime_revision > 0`。activate 必须在同一事务锁定 runtime row 和 model，验证 model 为对应 moderation strict snapshot、`status=poc_passed`、绑定 active channel/credential，并引用覆盖该 capability 的 passed `moderation-poc@1` run/evidence；若另一 capability 已激活，还必须用 prospective pair 重算 active 图片 SKU closure 的审核 exposure 与毛利，任一规格低于门槛即拒绝。校验通过后切换精确 pointer、递增 revision并写审计。disable 只清空 pointer、递增 revision并写审计，不修改历史 task snapshot。每次生成前和恢复时都要重新读取 pointer 并校验 model/channel/credential/circuit；row 缺失或不可用时返回内容安全不可用并停止收费生成，不自动创建状态或选择其他 model。quote/task/attempt 必须固定实际审核 model ID、capability/pricing/quota/evidence digest、credential version、runtime revision 和策略版本，历史任务不跟随 pointer 漂移。

### provider_channels / provider_credential_versions / provider_credential_validation_runs

S14 管理 Provider 账号/region 与 write-only credential。adapter 和 endpoint 仍来自编译期 allowlist，数据库不得变成任意 HTTP 配置器。

`provider_channels`：

| 字段                    | 类型        | 说明                                                                  |
| ----------------------- | ----------- | --------------------------------------------------------------------- |
| `id`                    | uuid        | 主键                                                                  |
| `provider`              | string      | 与 Provider registry 一致的稳定 key                                   |
| `adapter_key`           | string      | 编译期 adapter key                                                    |
| `display_name`          | string      | 管理端名称                                                            |
| `endpoint_profile_key`  | string      | 编译期 endpoint/region profile key；path/headers 仍由 adapter 固定    |
| `base_url`              | string      | 服务端 allowlist 内规范化 HTTPS relay base URL，不对用户 catalog 暴露 |
| `region`                | string?     | 受 schema 约束的 region 标识                                          |
| `region_key`            | string      | `region ?? ''` 的规范化唯一键，不对 API 暴露                          |
| `status`                | enum        | draft/active/disabled                                                 |
| `active_credential_id`  | uuid?       | 当前 active credential；切换必须与 credential 状态同事务              |
| `revision`              | int         | 条件更新版本                                                          |
| `created_at/updated_at` | timestamptz | 时间                                                                  |

`provider_credential_versions`：

| 字段                                  | 类型         | 说明                                                               |
| ------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `id`                                  | uuid         | 主键                                                               |
| `provider_channel_id`                 | uuid         | 所属通道                                                           |
| `version_no`                          | int          | 通道内递增版本                                                     |
| `secret_ciphertext`                   | bytes/text   | envelope encryption 密文                                           |
| `secret_key_id`                       | string       | 主密钥版本                                                         |
| `key_hint`                            | string       | 不可复原提示                                                       |
| `status`                              | enum         | pending_validation/valid/validation_unknown/active/invalid/revoked |
| `validation_evidence_digest`          | string?      | 固定 capability 验证的脱敏证据                                     |
| `verified_at/activated_at/revoked_at` | timestamptz? | 生命周期时间                                                       |
| `revision`                            | int          | 条件更新版本                                                       |
| `created_at`                          | timestamptz  | 创建                                                               |

`provider_credential_validation_runs`：`id/provider_channel_id/credential_version_id/probe_contract_version/status/queue_dispatch_intent_id?/result_summary_json?/evidence_digest?/processing_owner?/processing_lease_expires_at?/revision/requested_by_admin_id/created_at/started_at?/completed_at?`。status 固定 `queued | running | passed | failed | outcome_unknown | cancelled`；只保存固定 capability 验证的脱敏证据，不保存 secret、请求 header 或 Provider 原文。

约束：channel 身份 `(provider,adapter_key,endpoint_profile_key,region,base_url)` 通过规范化 `base_url` 与非空 `region_key = region ?? ''` 建立唯一索引，保证同一 relay 不重复创建且不同 relay 可以并存。`base_url` 一旦被模型或 credential snapshot 引用不可原地修改；relay 地址变化必须创建新 channel，旧 channel 只可按状态机停用。另有 `unique(provider_channel_id,version_no)`，每个 channel 最多一个 `status=active` credential。密文、nonce/tag 等加密材料按选定 envelope library 的完整格式保存，但任何读取 DTO、审计、日志、队列和异常都不得返回这些字段。validation run 与 queue intent 同事务创建，Provider 调用在事务外，queued/running 使用 owner lease/revision CAS；每个 credential 同时最多一个 queued/running run，failed/unknown 后可由管理员显式发起递增 `attempt_no` 的新 run，禁止队列自动重投。run 的 `revision > 0`，processing owner/lease 必须成对且只允许出现在 running。timeout/连接复位/响应不可解析进入 `outcome_unknown`。新 credential 的 passed/failed/unknown 分别 CAS 为 valid/invalid/validation_unknown；验证 active credential只记录 run，不覆盖 active。credential 激活必须引用同 credential/channel 的 passed run/evidence digest，并与 channel active pointer、旧 credential 状态和审计同事务切换。

### storage_channels / storage_credential_versions / storage_validation_runs / storage_runtime_state

S14 把 S10 的生产私有对象存储从进程环境密钥提升为已审批控制面配置；local/test 的 `LocalPrivateStorage` 仍只使用隔离临时根，不写这些生产表：

- `storage_channels`：`id/purpose/adapter_key/endpoint_profile_key/region/region_key/bucket/root_prefix/status/active_credential_id?/revision/created_by_admin_id/created_at/updated_at/disabled_at?`。`region_key = region ?? ''` 只用于数据库唯一性，不对 API 暴露；purpose 首版固定 `private_assets`；status 固定 `draft | active | disabled`，disabled 终局。adapter/endpoint profile/region 来自 `packages/storage` 编译期 registry，bucket/root prefix 通过 strict schema 规范化；不允许任意 URL、header、公共读策略或对象 key 模板。
- `storage_credential_versions`：`id/storage_channel_id/version_no/secret_bundle_ciphertext/secret_key_id/key_hint/status/validation_evidence_digest?/revision/created_at/verified_at?/activated_at?/revoked_at?`。status 固定 `pending_validation | valid | validation_unknown | active | invalid | revoked`；credential bundle 按 adapter strict schema 在受控内存中 envelope encrypt，读取 DTO 永不解密回显。
- `storage_validation_runs`：`id/storage_channel_id/credential_version_id/probe_contract_version/status/queue_dispatch_intent_id?/probe_prefix_digest/result_summary_json?/evidence_digest?/processing_owner?/processing_lease_expires_at?/revision/requested_by_admin_id/created_at/started_at?/completed_at?`。status 固定 `queued | running | passed | failed | outcome_unknown | cancelled`。固定 probe 只在由 run ID 派生的专用私有 prefix 做 put/head/range-read/delete，数据库、队列、日志和审计不保存 probe object key、签名 URL 或字节。
- `storage_runtime_state`：每个 purpose 一行 `purpose/active_storage_channel_id?/runtime_revision/updated_at`。activate 只原子切换 pointer/revision 并写成功审计，不改历史 asset/artifact；无 active pointer 或其 channel/credential 被禁用时 staging/beta/production 上传 readiness fail closed。

约束：`unique(purpose,adapter_key,endpoint_profile_key,region_key,bucket,root_prefix)` 使用非空 `region_key = region ?? ''` 规范化 nullable region；`unique(storage_channel_id,version_no)`；每 channel 最多一个 active credential；`unique(storage_runtime_state.purpose)`。channel 与 validation run 的 `revision > 0`；validation run 的 processing owner/lease 必须成对且只允许出现在 running。validation run 与 evaluation v3 intent 同事务创建，事务外访问存储，queued/running 以 owner lease/revision CAS 恢复；每个 credential 同时最多一个 queued/running run，failed/unknown 后可由管理员显式发起递增 `attempt_no` 的新 run。timeout/连接复位/清理结果不可判定进入 outcome_unknown，不自动重跑、不切 active；残留 probe 只由按 run ID 精确限定的 sweeper 清理，禁止扫描/删除用户 prefix。credential/channel 激活必须引用 passed run/evidence digest，并验证 bucket 为私有、所需 put/head/range-read/delete/sign 能力完整。

### model_catalog_entries

`models` 是不可变 Provider 快照；`model_catalog_entries` 是可发布给用户选择的产品化模型元数据：

| 字段                       | 类型         | 说明                             |
| -------------------------- | ------------ | -------------------------------- |
| `id`                       | uuid         | catalog entry                    |
| `model_snapshot_id`        | uuid         | 精确 `models.id`                 |
| `public_slug`              | string       | 稳定产品 key，不含 Provider 名称 |
| `version_no`               | int          | 同 public slug 递增版本          |
| `category`                 | enum         | brain/image/video                |
| `display_name`             | string       | 用户名称                         |
| `description`              | string       | 用户可读摘要                     |
| `public_capabilities_json` | json         | 严格白名单操作/规格/质量速度标签 |
| `status`                   | enum         | draft/approved/disabled          |
| `user_selectable`          | boolean      | 是否允许用户主动选择             |
| `sort_order`               | int          | catalog 排序                     |
| `rollout_policy_json`      | json         | 环境/人群门禁，不含任意表达式    |
| `revision`                 | int          | expected revision                |
| `approved_at/disabled_at`  | timestamptz? | 生命周期时间                     |
| `created_at/updated_at`    | timestamptz  | 时间                             |

约束：`unique(public_slug,version_no)`、`unique(model_snapshot_id,category)`。同一 release 不能包含同一 public slug 的多个版本。`approved` 只表示可被价格 release 引用，不等于已经对用户可见；公开 catalog 只读取 active `pricing_catalog_releases` closure 中的 approved entry。`disabled` 为终局，模型能力、展示或底层 snapshot 变化必须创建新 entry version；public slug 保持稳定，历史 turn 仍引用原 entry ID/version。S16 前，category=video 即使 approved 也不得进入 production 可执行 closure。

### billable_skus / pricing_catalog_releases / pricing_catalog_state

`billable_skus` 保存用户积分售价的不可变规格版本，不替代 `models.pricing_json` 的 Provider CNY 成本：

| 字段                          | 类型          | 说明                                                           |
| ----------------------------- | ------------- | -------------------------------------------------------------- |
| `id`                          | uuid          | SKU version                                                    |
| `logical_sku_key`             | string        | 稳定业务 key                                                   |
| `version_no`                  | int           | 同 key 递增版本                                                |
| `model_catalog_entry_id`      | uuid          | 产品化模型                                                     |
| `operation`                   | enum/string   | brain/image.generate/image.edit/upscale/video.generate 等      |
| `matcher_json`                | json          | strict 规格：mode/resolution/duration/fps/audio/reference tier |
| `matcher_hash`                | string        | canonical matcher SHA-256                                      |
| `unit_kind`                   | enum          | included/request/token/image/second/segment/megapixel          |
| `unit_rule_json`              | json          | strict 数量/秒数/segment/token 档位与 min/max/step             |
| `credits_per_unit`            | numeric(18,2) | 用户积分单价，string 读写                                      |
| `provider_rate_card_key`      | string        | 对应 model pricing v2 的精确 rate key                          |
| `provider_cost_snapshot_json` | json          | risk-adjusted CNY 成本、汇率/费率和来源 digest                 |
| `margin_snapshot_json`        | json          | 积分锚定值、目标/实际毛利和校验版本                            |
| `status`                      | enum          | draft/approved/disabled                                        |
| `revision`                    | int           | draft 条件更新版本                                             |
| `created_at/approved_at`      | timestamptz   | 时间                                                           |

`unit_rule_json` 按 `unit_kind` 使用 strict discriminated union：`image` 定义 quantity min/max/step；`second` 定义 duration min/max/step；`segment` 定义精确 segment seconds 和 segment count 上限；`megapixel` 定义明确输入/输出 pixel band 与计费步长；`request` 定义 request count；`token` 定义 input/output token 计费档位；`included` 不允许正数用户扣费。S14/S11 内测首版 Brain 费用包含在生成服务中，由 Brain catalog entry 表达且不创建 `billable_skus` 行；`included` SKU 保留给后续显式套餐能力。图片使用 `image | megapixel`，视频仅允许 `second | segment`。

`pricing_catalog_releases` 保存完整 closure：`id/release_no/status/base_release_id?/manifest_json/release_digest/revision/reason/created_by_admin_id/created_at/published_at?`。manifest 必须包含公开 model entry、每个操作/规格对应的精确 SKU version、每个类别默认 entry、rollout 和 schema version，禁止保存 Provider Key。无图片 entry 的历史/Brain-only closure 保持 `schema_version=1`；S12 起任何含图片 entry 的新 closure 必须使用 `schema_version=2`，并包含内部 `moderation` 快照：文本/图片 capability 各自固定 runtime revision、model snapshot ID、credential version ID、evidence/pricing digest 与风险调整后单次成本。该内部快照只供 quote/submit/恢复与发布漂移校验，不得投影到普通 model catalog 响应。

`pricing_catalog_state` 是 singleton：`id=true/active_release_id?/catalog_revision/updated_at`。publish/rollback 新 release 与 active pointer/revision 在同一事务切换；rollback 创建新的 release row，不修改历史 release。

约束：`unique(logical_sku_key,version_no)`、`unique(model_catalog_entry_id,operation,matcher_hash,version_no)`、`unique(pricing_catalog_releases.release_no)`。`release_digest` 是完整 manifest 的内容摘要，不是发布记录的唯一键；回滚或删除模型后重新发布历史上出现过的相同 closure 时，应创建新的 release_no/release ID，允许 digest 重复。SKU 被任何 release 引用或 status=approved 后，matcher/公开积分不得更新；调价创建新 version。`provider_rate_card_key` 和 `provider_cost_per_unit_cny` 是可选内部观测绑定，客户端不得提交；没有真实来源时两者为 null，不得填入估算常量。closure 校验必须证明：每个公开规格恰好一个 SKU、每类别最多一个默认、entry/model/channel/credential 均可用、模型 capability spec 与 SKU matcher/计费单位一致、视频符合阶段门禁、公开 credits 为 decimal string。用户结算只读取 SKU credits，不读取 Provider 成本。

### agent_traces

记录每个 Agent turn 的 LLM、工具、编译器和护栏执行总览，用于成本、排障、回放和死循环定位。

| 字段                        | 类型      | 说明                                                       |
| --------------------------- | --------- | ---------------------------------------------------------- |
| `id`                        | uuid      | 主键                                                       |
| `turn_id`                   | uuid      | Agent turn                                                 |
| `session_id`                | uuid      | 会话                                                       |
| `user_id`                   | uuid      | 用户                                                       |
| `brain_model_id`            | string    | legacy/display 模型标识；保留兼容，不作为真实调用准入真相  |
| `brain_model_snapshot_id`   | uuid?     | primary `models.id`；真实 S08 trace 必填，legacy/fake 可空 |
| `brain_model_snapshot_json` | json?     | primary strict 快照；S08 新 trace 在首次 LLM 前一次性固定  |
| `skill_ids`                 | json      | 本 turn 加载的 Skill                                       |
| `status`                    | enum      | running/succeeded/failed/blocked/cancelled/superseded      |
| `input_token_total`         | int       | 输入 token                                                 |
| `output_token_total`        | int       | 输出 token                                                 |
| `estimated_cost`            | decimal   | 已取得可信 usage 的累计实际估算成本                        |
| `reserved_cost`             | decimal   | 尚未取得可信 usage 的累计保守成本暴露；崩溃后仍计预算      |
| `loop_guardrail_hit`        | string?   | 循环保护原因                                               |
| `created_at`                | datetime  | 创建                                                       |
| `ended_at`                  | datetime? | 结束                                                       |

### agent_trace_steps

| 字段                  | 类型     | 说明                                                                 |
| --------------------- | -------- | -------------------------------------------------------------------- |
| `id`                  | uuid     | 主键                                                                 |
| `trace_id`            | uuid     | 所属 trace                                                           |
| `step_no`             | int      | turn 内递增                                                          |
| `step_type`           | enum     | llm_call/tool_call/compiler_check/guardrail/observation/interrupt    |
| `actor`               | enum     | agent/compiler/tool/system/user                                      |
| `skill_id`            | string?  | 关联 Skill                                                           |
| `tool_name`           | string?  | 精确含版本的工具名                                                   |
| `call_position_key`   | sha256?  | 模型 outcome 中 `turn/continuation/llm step/call index` 的审计位置键 |
| `tool_fingerprint`    | sha256?  | tool contract + canonical args + binding/resource versions；循环判定 |
| `operation_key`       | sha256?  | idempotent_write 的稳定领域操作键；none/read 必须为空                |
| `args_hash`           | string?  | legacy 兼容 canonical args hash；S08 新 tool step 同时写 fingerprint |
| `input_summary`       | json     | 输入摘要                                                             |
| `output_summary`      | json     | 输出摘要                                                             |
| `status`              | enum     | started/succeeded/failed/blocked                                     |
| `error_code`          | string?  | 错误码                                                               |
| `latency_ms`          | int?     | 耗时                                                                 |
| `token_usage_json`    | json?    | token 用量                                                           |
| `estimated_cost`      | decimal? | started 时为本次保守暴露；usage 可信后原子收敛为本次实际估算         |
| `model_snapshot_id`   | uuid?    | 本次调用的精确 `models.id`；真实 llm_call 必填                       |
| `model_snapshot_json` | json?    | 本次调用 strict 快照；llm_call 必填，fake 可无 FK                    |
| `created_at`          | datetime | 创建                                                                 |

约束：

- `unique(trace_id, step_no)`。
- 查询索引：`(turn_id)`、`(user_id, created_at)`、`(tool_name, tool_fingerprint, created_at)`、`(operation_key)` where not null。
- `input_summary/output_summary` 不保存完整私有 prompt、密钥和敏感素材 URL。
- `call_position_key` 只证明模型在某个位置提出调用，不得作为副作用幂等真相；`unique(trace_id, call_position_key)` where not null 防止同一位置重复落 step。
- `operation_key` 只用于 `side_effect=idempotent_write`，由服务端 ToolContract 的 `deriveOperationKey` 从用户/租户、领域聚合、工具版本、canonical args 和绑定输入版本派生。相同业务动作跨 llm step/Worker retry 必须稳定；同 key 不同 fingerprint 返回幂等冲突。receipt 由具体领域表/工具执行表保存，不能只靠 trace 声称已执行。
- `llm_call` step 必须在 started/保守成本写入时同时固化 `model_snapshot_json`；真实调用同时要求 `model_snapshot_id`。非 llm step 两字段为空。该 turn 内不允许 fallback 或切换模型；失败/unknown 由用户新建 turn 后重新选择。
- `agent_traces(turn_id)` 必须唯一；一个 turn 的多个 continuation 共用 trace、累计 token/成本/预算。
- 新 trace 的 `brain_model_snapshot_json` 必须在首次 LLM 前一次性固定；真实 route 的 `brain_model_snapshot_id` 同时引用已通过 strict schema 验证的精确 model row。不得按 `brain_model_id` 文本猜测版本或价格，legacy null 只可诊断读取，不得恢复真实模型执行。
- LLM 网络调用前在同一短事务新增 started step，并执行 `agent_traces.reserved_cost += step_exposure`；预算占用固定为 `estimated_cost + reserved_cost`，任何 preflight 都以该和与 turn 上限比较，不能只看其中一个字段。
- 收到可验证 usage 后，在同一 owner/revision CAS 事务执行 `reserved_cost -= step_exposure`、`estimated_cost += actual_step_cost`、累计 token，并把 step `estimated_cost` 从 exposure 改为 actual。三项必须原子，且 `reserved_cost` 不得为负；重复回执只能命中已收敛 step 后 no-op。
- 只有 transport 明确证明未发出请求时才可原子释放该 exposure 且本次实际成本为 0。超时、连接复位、响应截断/非法、usage 缺失或进程崩溃都属于调用结果未知：step 收敛为 failed + 内部 `AGENT_CALL_OUTCOME_UNKNOWN`，保留 step exposure 与 trace reserved cost；恢复重试必须新建 step 并再预留，不得复用旧输出或清零旧暴露。
- 若可信 actual 超过 exposure 或令总预算越界，仍按实际成本入账并立即阻断后续模型、工具、Compiler 和收费动作，同时告警模型/pricing 契约漂移；不能为了守住预算报表而截断实际成本。

### skill_resource_snapshots

记录 Skill 渐进式加载中被实际使用的不可变文档、引用和 KV 快照。

| 字段                  | 类型     | 说明                                                       |
| --------------------- | -------- | ---------------------------------------------------------- |
| `id`                  | uuid     | 主键                                                       |
| `skill_id`            | string   | `slug@version`                                             |
| `resource_path`       | string   | `SKILL.md` 或 `references/*.md`                            |
| `resource_type`       | enum     | catalog/planning_view/preset/reference/eval_dataset        |
| `content_hash`        | string   | 内容 hash                                                  |
| `package_resource_id` | uuid?    | 来源 `skill_package_resources.id`；S08 新 snapshot 必填    |
| `content_text`        | text?    | UTF-8/LF 规范化后的不可变正文；null 仅兼容 S08 前 snapshot |
| `kv_key`              | string   | KV 缓存键                                                  |
| `summary_json`        | json     | 可进入上下文的摘要                                         |
| `created_at`          | datetime | 创建                                                       |

约束：

- `unique(skill_id, resource_path)`；同一精确 `slug@version` 的同一路径只允许一个 hash。
- 已发布 Skill 的 resource snapshot 不得原地覆盖。
- 若已存在 `(skill_id,resource_path)` 与发布包 hash 不同，返回 `SKILL_VERSION_DRIFT` 并 fail closed；合法内容变化必须发布新的 Skill version。
- `content_text` 不进入公网 API、SSE、日志或普通审计；Redis 只缓存 DB snapshot 的只读副本，不能成为真相。
- `resource_type=preset` 只允许同一 primary definition 声明的精确 `presets/[a-z0-9][a-z0-9-]*.md`；auxiliary 不得拥有 preset snapshot。reference 继续只允许一跳 strict index。
- S08 后新 snapshot 必须写非空 `content_text` 与 `package_resource_id`，且 FK 所指 resource 的 skill/path/hash 必须完全一致。legacy null snapshot 必须由受控 hydration 以 `id + content_hash + content_text is null` CAS 回填；发布包缺失或 hash 不一致时不可执行，禁止从 hash 反推正文、静默覆盖或删除历史行。

### skill_packages / skill_package_resources / skill_package_validation_reports / skill_catalog_releases

`skill_packages` 记录安装候选和审批真相：`id/package_id?/package_version?/package_digest?/archive_sha256?/manifest_json?/status/risk_status/revision/source_type/source_locator_digest?/source_commit?/license_summary_json?/quarantine_storage_key/upload_expires_at/uploaded_by?/latest_validation_report_id?/approved_validation_report_id?/approved_by?/approved_at?/risk_review_due_at?/risk_blocked_at?/disabled_by?/disabled_reason?/disabled_at?/created_at`。`quarantined` 行先由平台 UUID、受控对象键和上传者识别；只有上传完成后服务端读取对象、核对实际大小/hash 并解析 strict manifest，才允许固化不可信的 `package_id/version/digest`。包状态不包含 `published`：一个已审批包可以同时被多个历史 release 引用，是否对新 turn 生效只由 active catalog release 决定。

`skill_package_resources` 记录 manifest 清单：`id/package_record_id/resource_path/resource_type/media_type/byte_size/content_hash/storage_key/skill_id?/rights_metadata_json/created_at`。`package_record_id` 外键指向 `skill_packages.id`，不能误用业务 `package_id`。资源对象在 validation 前写入 quarantine/content-addressed storage；审批事务只按已验证 ID/hash 物化 Markdown/JSON 到 `skill_resource_snapshots.content_text`。图片等 catalog 资产只保存受控对象键和权利元数据，不保存签名 URL。

`skill_package_validation_reports` 为追加写的验证 attempt：`id/package_record_id/package_revision/package_digest/attempt_no/status/revision/validator_contract_version/platform_eval_suite_digest/report_json?/report_digest?/queue_intent_id/processing_owner?/processing_lease_expires_at?/last_heartbeat_at?/started_at?/completed_at?/created_at`。`package_revision/package_digest` 在创建 attempt 时固定，终态写入前必须再次与 package 当前值核对。`report_json` 只保存规则 ID、pass/fail、计数和脱敏摘要，不复制完整私有正文；同一 package 可因 validator/eval suite 升级产生新 attempt，旧报告不得覆盖。

`skill_catalog_releases` 记录完整原子 catalog 快照：`id/release_no/status/revision/base_release_id?/rollback_of_release_id?/release_digest/manifest_json/reason/created_by?/approved_by?/published_at?/retired_at?/created_at`。`manifest_json` 只列精确 package record/validation report/skill/resource ID 与 hash，不复制正文；它必须是依赖闭包完整快照，不是增量 patch。全局 active release 由单行 `skill_catalog_state(id='global',active_release_id,revision,updated_at)` 以 expected revision CAS 切换。

约束：

- `unique(package_id,package_version)` where both not null；同版本相同 package digest 为幂等，同版本不同 digest 为安装冲突，禁止覆盖。`archive_sha256` 只证明上传 transport，相同 package digest 可接受不同无语义 ZIP 压缩字节，但官方 pack 必须可复现。
- `unique(package_record_id,resource_path)`、`unique(package_record_id,attempt_no)`、`unique(package_record_id,report_digest) where report_digest is not null`、`unique(queue_intent_id)`、`unique(release_no)`、`unique(release_digest)`；路径采用 NFC + case-fold 冲突检查，数据库唯一约束作兜底。
- package 合法转换为 `quarantined -> uploaded -> validating -> validation_failed | ready_for_review -> approved -> disabled`，`uploaded/validation_failed/ready_for_review` 可通过创建新 validation attempt 再进入 `validating`；上传过期、对象缺失/hash 不符、manifest 非法可从 `quarantined` 进入 `rejected`。`rejected` 和 `disabled` 为终局。状态迁移使用 revision/条件更新，不能 last-write-wins。
- validation report 合法转换为 `queued -> running -> passed | failed | cancelled`。`queued` 不得有 processing owner/lease；`running` 必须同时有 owner/lease，续约和终态写入使用 `id + owner + revision` CAS；终态清空 owner/lease并固定非空 `report_json/report_digest/completed_at`，之后不可改写。过期 running attempt 只能接管同一 report/attempt，不能另建重复 eval。`ready_for_review` 必须引用最新 completed passed report；审批必须固定该 report ID/digest、validator contract 与平台 eval suite，审批后不能替换。
- 初次 validation 完成后更新 package 主状态；`approved` package 的 revalidation 不把主状态倒退到 `validating`，只更新 `latest_validation_report_id/risk_status/risk_review_due_at/risk_blocked_at`。passed 清为 `clear` 并清空 due/blocked；非 critical failed 为 `needs_review`，以服务端时间写 `risk_review_due_at=now()+24h`；critical failed 必须在同一裁决事务转 `disabled + critical`。`approved_validation_report_id` 永远保留当次审批证据，不被后续 report 替换。
- package 进入 `approved` 前必须有通过的 validation report、审批人、全部资源 hash 和对应不可变 snapshot；validation failed/rejected/disabled 不得进入新 release。审批不自动创建或发布 release。
- release draft 创建时固定 `base_release_id` 并生成完整依赖闭包；发布事务必须一次性验证所有 primary、Preset、required/optional auxiliary 与资源均为已审批精确版本，并原子 CAS active release；不能逐行启用造成半套 catalog。并发发布仅一个 expected revision 成功，失败 draft 保持 draft。
- 回滚不是把旧 release 的状态改回 published，而是创建新的单调 `release_no`，复用目标旧 release 的已审批完整 manifest 并记录 `rollback_of_release_id`，然后按同一 CAS 切换 active release。
- package disabled 后，catalog query 与 turn create 必须立即拒绝直接或间接依赖它的 primary，即使旧 active release pointer 尚未被替代；运营随后发布不含该包的新 release。disabled/retired 不改变历史 selection snapshot。仍被 turn/workflow/eval/release/audit 引用的 package/skill/resource/report 禁止物理删除。
- `risk_status=needs_review` 禁止新 release 引用；在 `risk_review_due_at` 前，当前 active release 可按 `09` 的非 critical SLA 继续服务。达到服务端 due 时间后，catalog/turn create 必须直接按时间 fail closed，不依赖扫描任务是否及时运行；风险 deadline sweeper 再以 CAS 写 `risk_blocked_at` 和审计/outbox 作为持久化运营裁决。`risk_status=critical` 与 disabled 等价，任何新 catalog/turn 都不得使用。
- `skill-package.json` 是 package inventory 与宿主 profile 的真相；可复制 Skill 的创作语义来自 `SKILL.md` 的 `name/description/body`。manifest 的 `skills[].skill_id/definition_path/definition_hash` 必须与 profile 的 `slug/version`、Markdown 的 `name` 和规范化文件 hash 一致；`skills.definition_json` 只能由 validator 确定性编译，禁止在 Markdown 与 manifest 中维护两套可独立编辑的宿主字段。
- source locator 只保存来源类型、仓库/上传记录的摘要和受控 commit；不得保存访问 token、私有仓库凭据或可执行下载指令。

索引至少包含：`skill_packages(status,created_at)`、`skill_packages(risk_status,risk_review_due_at)`、`skill_package_validation_reports(status,processing_lease_expires_at)`、`skill_package_validation_reports(package_record_id,created_at)`、`skill_catalog_releases(status,created_at)`，以及 `skill_package_resources(content_hash)` 用于内容寻址核验。quarantine storage key、完整 manifest/report 正文和 source locator 不进入普通查询响应或高基数指标。

### asset_embeddings

阶段 0 预留，不启用自动检索闭环，但保留表结构占位。

| 字段              | 类型     | 说明                 |
| ----------------- | -------- | -------------------- |
| `id`              | uuid     | 主键                 |
| `asset_id`        | uuid     | 资产                 |
| `embedding_model` | string   | 模型                 |
| `vector`          | json     | 向量                 |
| `status`          | enum     | draft/ready/disabled |
| `created_at`      | datetime | 创建                 |

### user_preferences

阶段 0 预留，为用户偏好和长期记忆占位。

| 字段               | 类型     | 说明     |
| ------------------ | -------- | -------- |
| `id`               | uuid     | 主键     |
| `user_id`          | uuid     | 用户     |
| `preference_key`   | string   | 偏好键   |
| `preference_value` | json     | 偏好值   |
| `source`           | string   | 来源     |
| `updated_at`       | datetime | 更新时间 |

## 12. 查询模式驱动索引

阶段 0 必须按高频查询设计索引，不能只靠 ORM 默认外键。

| 高频查询                    | 必需索引                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 用户任务日志按状态/时间分页 | `workflow_runs(user_id, status, created_at)`、`tasks(workflow_run_id, status)`                                                        |
| 某个 workflow 的完整任务树  | `tasks(workflow_run_id, dag_node_id)`、`task_attempts(task_id, attempt_no)`                                                           |
| Provider 回调定位 attempt   | `task_attempts(provider, provider_request_id)`                                                                                        |
| Provider unknown 扫描       | `task_attempts(dispatch_state, started_at)`、`task_attempts(status, ended_at)`                                                        |
| Provider polling 恢复       | `task_attempts(status,next_poll_at)` where `status in ('accepted','polling')`                                                         |
| Provider callback 恢复      | `provider_callback_events(status,next_process_at)`、`provider_callback_events(provider,provider_request_id)`                          |
| Provider 熔断探针           | `provider_circuit_states(status,probe_after)`、`provider_circuit_states(provider,status)`                                             |
| 用户作品列表按商品/时间筛选 | `artifacts(user_id, product_id, created_at)`、`artifacts(user_id, created_at)`                                                        |
| 对象存储 key 反查产物       | `artifacts(storage_key)`、`assets(storage_key)`                                                                                       |
| 用户资产库按商品/文件夹查询 | `assets(user_id, product_id, created_at)`、`assets(user_id, folder_id, created_at)`                                                   |
| 积分流水按用户/月份查询     | `credit_ledger(user_id, created_at)`、`credit_ledger(workflow_run_id)`                                                                |
| 商品详情页聚合              | `products(user_id, updated_at)`、`products(user_id, sku_code)`、`product_fact_sets(product_id, created_at)`                           |
| SSE 断线恢复                | `event_outbox(scope_type, scope_id, event_seq)`                                                                                       |
| Agent trace 排障            | `agent_trace_steps(trace_id, step_no)`、`agent_trace_steps(tool_name, args_hash, created_at)`                                         |
| 邀请核销防刷                | `invite_code_redemptions(invite_code_id, user_id)`、`referrals(invitee_id)`                                                           |
| 注册 claim 与 ticket 查验   | `registration_claims(email_hash,status)`、`registration_claims(ticket_hash)`、`registration_claims(invite_code_id,status,expires_at)` |
| 注册奖励防重                | `registration_reward_claims(campaign_key,user_id)`、`registration_reward_claims(campaign_key,mailbox_fingerprint)`                    |
| 队列恢复扫描                | `queue_dispatch_intents(status,next_attempt_at)`、`queue_dispatch_intents(aggregate_type,aggregate_id)`                               |
| 邮件恢复与告警              | `mail_deliveries(status,updated_at)`、`mail_deliveries(provider,status,created_at)`                                                   |
| 用户画布列表与软删除过滤    | `canvases(user_id, updated_at)` where `deleted_at is null`；由 S24 的 3a 前向迁移增加                                                 |

索引验收：

- 阶段 0 已存在字段的索引由阶段 0 migration 创建；标记 3a 的画布索引由 S24 前向 migration 创建。
- 所有用户数据查询必须带 `user_id` 或通过已校验父资源间接过滤。
- 账本、产物、任务、事件查询必须能解释其主索引，不允许上线后再补救。

## 13. 运营与事件

### queue_dispatch_intents

记录数据库事务已提交但 BullMQ 尚未确认写入的队列投递意图；它是控制面恢复记录，不承载 SSE 用户事件。

| 字段               | 类型         | 说明                                     |
| ------------------ | ------------ | ---------------------------------------- |
| `id`               | uuid         | 主键                                     |
| `queue_name`       | string       | `packages/queue` 裁决的队列名            |
| `job_id`           | string       | 稳定 BullMQ job ID                       |
| `aggregate_type`   | string       | workflow/task/agent 等                   |
| `aggregate_id`     | uuid         | 业务聚合 ID                              |
| `payload_version`  | int          | payload schema 版本                      |
| `payload`          | json         | 仅持久化 ID，不含密钥、二进制或签名 URL  |
| `status`           | enum         | pending/dispatching/dispatched/cancelled |
| `revision`         | int          | 状态与 lease 的 CAS 版本，初始为 1       |
| `attempt_count`    | int          | 本地队列写入尝试次数                     |
| `next_attempt_at`  | timestamptz  | 下次 dispatcher 扫描时间                 |
| `lease_owner`      | string?      | dispatcher owner token                   |
| `lease_expires_at` | timestamptz? | 可接管 lease 过期时间                    |
| `last_error_code`  | string?      | 脱敏错误码                               |
| `created_at`       | timestamptz  | 创建                                     |
| `updated_at`       | timestamptz  | 更新                                     |

约束：

- `unique(queue_name, job_id)`、`index(status, next_attempt_at)`、`index(aggregate_type, aggregate_id)`。
- 每次 claim、lease 续约、释放、恢复、取消或 dispatched 标记都必须在同一条件更新中令 `revision + 1`；管理恢复必须提交 `expected_intent_revision`，禁止以 `updated_at` 代替 CAS 版本。
- `aggregate_id` 永远是 intent 主持久化聚合的 UUID，与 `job_id` 分离；复合 job ID 可由操作参数 canonical hash 得到，但 hash 禁止写入 `aggregate_id`。无主聚合 UUID 的动作必须先创建持久化 operation 记录。
- workflow/task 事务与 intent 同事务写入；用户可见状态另写 `event_outbox`，两表不能互相替代。
- 本表已由 S03 的前向 migration 创建；S05 优先复用既有字段和约束，不重复建表，不修改历史 migration。确需调整时须先回写本文件，再由 Drizzle 生成新的向前 migration。
- dispatcher 只能在事务提交后入 BullMQ；使用 `FOR UPDATE SKIP LOCKED` 分页 claim，事务内写 owner token/lease 并将 `next_attempt_at` 设为 lease 到期时间，事务外调用 Redis，完成后按 `id + lease_owner` CAS 更新。sweeper 由此复用 `(status,next_attempt_at)` 索引领取过期 lease。
- sweeper 分页恢复 pending/过期 lease；Redis add 成功但 DB 标记失败时使用同一 job ID 重放，Worker 消费前重新检查 DB 状态。
- 永久非法的 payload/version/job type 转 `cancelled` 并告警，不得形成无限 poison 重试。
- Redis recovery sentinel 缺失时，由数据库 session advisory lock 选出唯一 reconciler，分页核对已 `dispatched` intent；session lock 使用专用 ops 连接但不持有跨 Redis 调用的数据库事务。完成全部分页后才写 sentinel，中途崩溃必须允许其他实例接管。
- `accepted/polling/outcome_unknown` 只恢复查询、回调等待或人工核验，禁止重新投递 Provider。

### event_outbox

参考旧工程：

- `id`
- `scope_type`
- `scope_id`
- `event_seq`
- `event_type`
- `payload`
- `retention_tier`: critical/normal/debug
- `created_at`

约束：

- `unique(scope_type, scope_id, event_seq)`。
- 业务状态与对应 outbox 事件必须在同一事务写入。
- advisory lock canonical 输入固定为 UTF-8 `${scope_type}:${lowercase_uuid}`，取 SHA-256 digest 前 8 字节并按 big-endian two's-complement 解释为 signed int64；所有调用方必须复用同一参数化数据库 helper。
- 持锁后读取 `max(event_seq)` 并写 `max + 1`，首个事件为 `1`。hash 碰撞只允许造成额外串行，唯一约束仍是正确性兜底。
- 不得在无 scope 锁的条件下先查 max 再写；唯一约束只作为最终并发兜底。
- SSE 使用 outbox 恢复，不使用内存事件作为真相。
- `critical` 事件至少保留 30 天，`normal` 至少 7 天，`debug` 至少 1 天。
- 当前序号分配依赖 scope 内 `max(event_seq)`，因此自动清理落地前保留全部事件。后续归档/删除必须先提供独立 scope 高水位或永久保留每个 scope 的最新锚点，确保清理后继续写入不会从 `1` 重用序号；禁止直接删空 scope 后继续使用现有 `max + 1` 算法。

### mail_deliveries

记录认证邮件投递结果，不保存邮件内容：

| 字段                    | 类型        | 说明                                                            |
| ----------------------- | ----------- | --------------------------------------------------------------- |
| `id`                    | uuid        | delivery ID                                                     |
| `user_id`               | uuid?       | 可空用户 ID                                                     |
| `recipient_hash`        | string      | 收件人独立 HMAC                                                 |
| `recipient_hash_key_id` | string      | 非敏感 HMAC key 版本                                            |
| `purpose`               | enum        | email_verification/password_reset                               |
| `provider`              | enum        | fake/console/smtp/tencent_ses                                   |
| `provider_message_id`   | string?     | 服务商消息 ID                                                   |
| `status`                | enum        | queued/sent/delivered/bounced/complained/failed/outcome_unknown |
| `attempt_count`         | int         | 明确未投递时的短重试次数                                        |
| `last_error_code`       | string?     | 脱敏错误码                                                      |
| `idempotency_key`       | string      | 投递幂等键                                                      |
| `created_at`            | timestamptz | 创建                                                            |
| `updated_at`            | timestamptz | 更新                                                            |

约束：

- `unique(idempotency_key)`、`index(status, updated_at)`、`index(provider, status, created_at)`。
- 网络调用前必须先提交 `queued` 记录；超时且不能证明未送达时转 `outcome_unknown`，禁止自动重投。
- 禁止保存 OTP、完整邮箱、subject、正文、HTML、SDK 原始响应或错误。

### worker_heartbeats

- `id`
- `worker_type`
- `status`: healthy/draining/stopped
- `last_seen_at`
- `metadata`

语义：

- 每次 Worker 进程启动生成一个生命周期内稳定的 UUID 作为 `id`，按该 id 周期 upsert；进程重启必须生成新 id，不能把不同生命周期伪装成同一实例。
- 默认每 15 秒更新 heartbeat，45 秒未更新视为 stale；实际值由 `10` 的 typed config 校验。
- SIGTERM/SIGINT 时先停止领取新 job，再写 `draining`；active job 在时限内完成后写 `stopped`，超时退出由队列/数据库恢复机制接管。
- metadata 只保存实例版本、队列和并发等非敏感摘要，不得保存环境变量、完整 payload 或用户内容。

### appeals

| 字段                 | 类型      | 说明                                             |
| -------------------- | --------- | ------------------------------------------------ |
| `id`                 | uuid      | 主键                                             |
| `ledger_id`          | uuid      | 关联本人 consume 流水                            |
| `user_id`            | uuid      | 申诉用户                                         |
| `reason`             | text      | 理由                                             |
| `screenshots`        | json      | 受控 asset binding，不保存签名 URL/二进制        |
| `status`             | enum      | pending/refunded/rejected                        |
| `refund_amount`      | decimal   | 退款额，string 读写                              |
| `reviewer_id`        | uuid?     | legacy users reviewer；S14 新写入必须为空        |
| `reviewer_admin_id`  | uuid?     | 独立管理员                                       |
| `decision_reason`    | text?     | 管理裁决原因                                     |
| `decision_ledger_id` | uuid?     | refund/correction ledger，确保裁决与资金证据闭环 |
| `revision`           | int       | expected revision                                |
| `created_at`         | datetime  | 创建                                             |
| `reviewed_at`        | datetime? | 审核时间                                         |

约束：同一 `ledger_id` 最多一个 active appeal；创建时校验 ledger 所有权、consume 类型和 72 小时服务端窗口，并按 `(user_id,created_at)` 执行月限额。S14 裁决必须写 `reviewer_admin_id`，`reviewer_id` 仅历史兼容。`refunded` 必须同时具有 `decision_ledger_id/refund_amount>0/reviewed_at`，`rejected` 必须 `refund_amount=0`；状态只允许 pending 经 revision CAS 进入终态。

### admin_audit_logs

| 字段                   | 类型      | 说明                                                     |
| ---------------------- | --------- | -------------------------------------------------------- |
| `id`                   | uuid      | 主键                                                     |
| `actor_user_id`        | uuid?     | S02-S07 legacy actor；只读兼容，不参与授权               |
| `actor_admin_id`       | uuid?     | 独立管理员主体；bootstrap CLI/system 可空                |
| `actor_type`           | enum?     | admin_session/bootstrap_cli/system；仅 legacy 行可空     |
| `admin_session_id`     | uuid?     | 管理 Session；非浏览器 actor 可空                        |
| `permission_snapshot`  | json?     | 当次角色/permission/scope/version 摘要；仅 legacy 行可空 |
| `action`               | string    | 动作                                                     |
| `target_type`          | string    | 目标类型                                                 |
| `target_id`            | uuid?     | 目标 ID                                                  |
| `reason`               | string?   | 管理员提交的受限原因                                     |
| `before_json`          | json?     | strict 脱敏变更前                                        |
| `after_json`           | json?     | strict 脱敏变更后                                        |
| `request_id`           | string    | 请求关联                                                 |
| `trace_id`             | string?   | 链路关联                                                 |
| `idempotency_key_hash` | sha256?   | 幂等键摘要，不保存原 key                                 |
| `source_ip_hash`       | string?   | 可信来源 IP 的独立 HMAC                                  |
| `user_agent_hash`      | string?   | User-Agent 摘要                                          |
| `ip`                   | string?   | S02-S07 legacy 原始值；只读兼容，新写入必须为空          |
| `user_agent`           | string?   | S02-S07 legacy 原始值；只读兼容，新写入必须为空          |
| `mfa_level`            | string?   | 当次认证强度                                             |
| `step_up_at`           | datetime? | 最近升级认证时间                                         |
| `result`               | enum      | succeeded/failed/blocked                                 |
| `error_code`           | string?   | 稳定脱敏错误码                                           |
| `created_at`           | datetime  | 创建                                                     |

审计为追加写，业务代码不得更新或删除；高风险业务事务与成功审计必须同事务，无法写审计则 fail closed。邀请码明文、Provider Key、OTP、ticket、Cookie、完整 prompt、Skill 私有正文、quarantine/storage key、签名 URL 和图片二进制禁止进入 before/after/reason。

前向兼容顺序固定：

1. S08 通过新的 Drizzle migration 保留 `actor_user_id/ip/user_agent` 及 legacy FK，但把 `actor_user_id` 改为 nullable，并新增 nullable `actor_admin_id/actor_type/admin_session_id/permission_snapshot/source_ip_hash/user_agent_hash` 等审计字段；不得删除、重命名或回填伪造旧 actor/来源。S08 后新写入必须令 legacy `ip/user_agent` 为空，只写独立 key 的 hash。
2. S08 的 bootstrap/local-test CLI 与 system job 只能写 `actor_type=bootstrap_cli|system`、`actor_admin_id=null`、`actor_user_id=null`，并携带显式受控 actor context 和权限摘要；旧 `actor_user_id` 只可用于历史展示，不能签发 Admin Session、通过 permission guard 或作为审批/发布授权真相。
3. S14 创建 `admin_principals/admin_sessions` 等独立管理身份表后，再以新的前向 migration 为 `actor_admin_id/admin_session_id` 增加 FK，并令所有 Admin API 新行强制 `actor_type=admin_session`、`actor_admin_id/admin_session_id/permission_snapshot` 非空。S14 不能重建 `admin_audit_logs`，也不能把 legacy user 映射为管理员。
4. 新行必须满足 actor 形态互斥：`admin_session` 只允许独立 Admin actor；`bootstrap_cli/system` 不得携带普通 user 或 Admin Session；legacy 全空扩展字段仅供 S08 前历史行读取。

### admin_idempotency_records

所有浏览器管理写接口使用持久化幂等记录，不能只依赖 Redis：`id/actor_admin_id/operation/idempotency_key_hash/request_hash/status/target_type?/target_id?/response_status?/response_json?/expires_at/created_at/completed_at?`。`actor_admin_id` 对 Admin API 必填并引用独立 `admin_principals`；bootstrap/local test CLI 不能伪装成管理员记录，使用领域 operation key 与 `admin_audit_logs.actor_type` 单独审计。

- `unique(actor_admin_id,operation,idempotency_key_hash)`；request hash 必须包含 HTTP method、规范化路由模板与 path ID、strict body，避免同 key/body 改打另一资源时错误重放。
- 处理顺序与 Agent create 相同：任何目标状态校验、锁、step-up 消费或副作用前先查记录；同 hash 且 completed 重放原 response，不同 hash 返回 `IDEMPOTENCY_CONFLICT`。首次请求在业务短事务中完成状态变更、成功审计和 immutable response；失败是否持久化按错误是否可重试分类，但绝不能产生半副作用。
- `response_json` 只保存可返回的脱敏稳定响应，不得保存一次性邀请码、Provider Key、上传签名 URL、完整 Skill/eval 正文或其他 secret。邀请码生成、恢复码和 Key 的幂等重放只返回稳定“已创建但不可再次展示”状态；邀请码后续复制必须重新经过 S14A 单码受控 reveal，不能从幂等记录恢复。
- 上传签名 URL 是可再签发的短期 capability，不等同于一次性 secret：upload-intent 的持久化幂等响应只保存同一 `package_record_id`、目标摘要、上传窗口和限制；同 key/同 request 在不可变上传窗口内重放时，为同一 quarantine object key 重新签发新的短 TTL URL，URL 本身不落库、不进审计且不创建第二个 package。窗口已过、package 已 complete/rejected/disabled 时不再签发，返回当前稳定状态；同 key 不同 request 仍为 `IDEMPOTENCY_CONFLICT`。

### user_activity_logs

记录用户侧安全与运营活动，默认保留 180 天。

| 字段            | 类型     | 说明                                                                                                                                               |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | uuid     | 主键                                                                                                                                               |
| `user_id`       | uuid?    | 用户                                                                                                                                               |
| `activity_type` | enum     | login/logout/register/email_verify/password_reset/registration_reward/risk_block/download/share_view/fact_confirm/asset_upload/asset_delete/export |
| `target_type`   | string?  | 目标类型                                                                                                                                           |
| `target_id`     | uuid?    | 目标 ID                                                                                                                                            |
| `metadata`      | json     | 摘要                                                                                                                                               |
| `ip`            | string?  | IP                                                                                                                                                 |
| `user_agent`    | string?  | UA                                                                                                                                                 |
| `created_at`    | datetime | 创建                                                                                                                                               |

索引：`index(user_id, activity_type, created_at)`。

### notifications

阶段 1B 起用于站内通知，阶段 0 建占位契约。

| 字段         | 类型      | 说明     |
| ------------ | --------- | -------- |
| `id`         | uuid      | 主键     |
| `user_id`    | uuid      | 用户     |
| `type`       | string    | 通知类型 |
| `payload`    | json      | 内容     |
| `read_at`    | datetime? | 已读     |
| `created_at` | datetime  | 创建     |

## 14. 迁移策略

阶段 0 只允许做可向前兼容的迁移：

- 枚举新增必须有默认处理。
- 账本表上线后不得手工改余额。
- Provider 能力契约可以新增字段，不得删除已审计字段。
- 产物归属字段 1A 必须随首个产物写入，不能后补猜测。
- 迁移执行 SOP、dry-run、备份和发布顺序由 `10` 裁决；本文只裁决数据结构原则。
- S08 schema 只由 Drizzle 生成新 migration。create 幂等字段与 Skill 正文先以 legacy-compatible nullable 列上线；Service 对新行强制非空，不能为追求数据库 `not null` 删除或伪造旧数据。
- 加唯一约束前必须只读检查重复 trace、session active turn 与 `(skill_id,resource_path)` 多 hash；发现冲突即停止发布并输出脱敏 ID 摘要，不自动删除、合并或选赢家。

## 15. 必须验证的 SQL/查询

- 用户余额和 ledger 重放一致性。
- 某个 `workflow_run` 的全部 task、attempt、artifact 和 ledger。
- 某个 Provider 的 `outcome_unknown` 比率。
- 某邀请码的 `used_count + active registration_claims` 是否超过容量。
- 某用户邮箱验证、邀请码正式核销与注册奖励 ledger 是否恰好一次。
- 悬挂 `mail_deliveries.queued` 是否在恢复阈值后收敛且没有重复发信。
- 某个用户 72 小时内可申诉消费流水。
- 某个分享页是否暴露了禁止字段。

# Final model relay addendum (2026-08)

The following rules are authoritative for the first real model integration and
supersede any earlier OpenAI-official fixed-endpoint wording:

- `provider_channels` identifies a relay connection: display name, normalized
  server-approved base URL, adapter/profile, region, status, and credential pointer.
  It does not identify one model.
- Every executable model row and immutable execution snapshot carries
  `protocol_family` and `api_variant`. A pre-S16 video draft may keep both null,
  but cannot enter PoC, catalog, quote, or execution until S16 assigns its exact
  protocol contract. The strict executable values are `openai | anthropic | google` and
  `openai_chat_completions | openai_responses | anthropic_messages | google_generate_content | openai_images`.
- `google_generate_content` is valid only for an Agent Brain model; it never enables
  image generation, video, or moderation. Missing or null `contract_kind` is rejected,
  not accepted via SQL three-valued CHECK semantics. This additive check-constraint change
  requires a new migration and preserves all existing rows and snapshots.
- A transcript call may carry optional `provider_metadata={google:{thoughtSignature}}`.
  This opaque protocol field is stored only in the owned transcript envelope, covered
  by its canonical digest and existing envelope byte limit. It is not a tool argument,
  authorization, public trace field, summary fact, or raw reasoning response.
- `openai_images` is valid only for media image models and maps to the adapter-owned
  `/v1/images/generations` and `/v1/images/edits` operations. Anthropic is not an
  image protocol in the first release.
- `openai_responses` is valid for an Agent Brain snapshot and for an S12 internal
  moderation snapshot. The latter must use the strict `media@v1` moderation-only
  capability branch, is never catalog/billable, and cannot expose Agent tools or
  accept a request-supplied prompt/schema. No Anthropic moderation route is active
  in 1A.
- A single relay channel may have multiple models, but each turn/attempt resolves
  one exact model snapshot and one credential snapshot. No in-turn model switch,
  provider fallback, or silent retry is allowed.
- Public catalog entries expose only product name, category, supported specs, and
  credits. Protocol, base URL, credential, internal model ID, and provider cost
  remain private.
