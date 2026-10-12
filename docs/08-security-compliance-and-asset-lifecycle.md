# 08 安全合规与资产生命周期

| 项       | 内容                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 状态     | v0.5 首版人像/第三方素材授权与 Skill 包供应链边界回写后待复审                      |
| 基准     | PRD v1.7、参考工程 `D:\agent\image` 的 Provider Key 加密、资产文件 API、软删除模式 |
| 完成节点 | 内测前                                                                             |
| 裁决范围 | 签名 URL、删除策略、分享隐私、密钥、权限、协议/法务门禁                            |
| 不裁决   | 任务状态细节、Provider 成本、UI 视觉稿                                             |

## 1. 目标

1A 面向真实用户上传商品图片，必须在内测前明确：

- 用户素材如何访问。
- 分享和做同款是否暴露隐私。
- 删除后文件、缩略图、派生物和备份怎么处理。
- Provider Key 和 Webhook Secret 如何存储。
- 积分、会员、商用授权和用户上传素材授权的法务门禁。

## 2. 资产访问策略

对象存储只保存私有对象，不暴露长期原始 URL。

访问方式：

| 场景             | 策略                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 前端预览私有资产 | 同源应用内预览走会话鉴权直接读 `/content`（无需逐张签发）；脱离会话的下载/分享仍由 `access-url` 签发短期 capability |
| 下载产物         | 服务端鉴权，记录下载事件                                                                                            |
| Worker 读取资产  | 服务端内部凭证或短期 URL                                                                                            |
| 分享页访问       | 仅公开产物副本或受控代理 URL                                                                                        |
| 管理员查看       | 需要权限，写审计日志                                                                                                |

签名 URL 要求：

- 默认有效期不超过 10 分钟。
- 不包含可枚举路径。
- 不在日志中打印完整 URL。
- 过期后必须重新鉴权获取。

## 3. 上传安全

上传限制：

- 图片 20MB。
- 视频 200MB，1A 不开放视频生成但可作为后续资产预留。
- MIME 和文件头双重校验。
- 禁止可执行文件和 HTML。

处理：

- 上传前先创建持久化 upload intent 与 `assets(uploading)`；对象 key 由服务端随机生成，不含邮箱、文件名、SKU 或可枚举用户路径。
- 上传签名 URL/token 是短期 capability，不落库、不进日志/审计；同一幂等上传窗口只能对应一个 asset/object key。
- complete 只声明“客户端已结束上传”，不证明对象可信。API 不接受客户端 hash、尺寸作为真相；异步 Worker 必须读取对象实际字节，核对存在性、大小、SHA-256、magic byte、声明 MIME 相容性、解码与像素上限。
- 只有 JPEG/PNG/WebP 且检查通过可进入 ready。伪 MIME、HTML/SVG/可执行内容、损坏图片、像素炸弹、对象缺失或超限一律 rejected，不生成可访问 URL。
- 缩略图必须自动旋转、去除 EXIF/ICC/XMP 等非必要元数据并重新编码；不能直接复制原图 metadata。缩略图失败保留私有原对象，状态 `processing_failed`，只能显式重试。
- 原图与缩略图都只存私有对象。`ready` 前不得作为 Agent 引用、商品主图或 Provider 输入。
- staging/beta/production 必须使用 S14 已审批的存储 adapter/secret handle；缺配置 readiness fail closed，禁止降级到本地目录或公开 bucket。

## 4. 删除生命周期

删除分为逻辑删除、访问关闭、物理清理。

```text
用户删除
  -> 标记 deleted_at
  -> 停止新访问
  -> 撤回分享引用
  -> 进入清理队列
  -> 物理删除对象和缩略图
  -> 备份过期后不可恢复
```

默认参数：

| 对象           | 逻辑删除               | 物理清理 | 备份过期 |
| -------------- | ---------------------- | -------- | -------- |
| 上传素材       | 立即                   | 30 天    | 90 天    |
| 生成产物       | 立即                   | 30 天    | 90 天    |
| 缩略图         | 立即                   | 30 天    | 90 天    |
| 分享页公开副本 | 撤回后立即停止访问     | 30 天    | 90 天    |
| 审计快照       | 不随素材删除立即物理删 | 180 天   | 365 天   |

注意：

- 账本、申诉、风险确认和必要审计快照不能因用户删除而失去审计能力。
- 对外分享撤回后必须立即停止新访问。
- 上述默认值为阶段 0 建议参数，评审可调整；实现不得自行选择区间。

### 4.1 Agent 语义历史与私有 payload (2026-09-07)

- `agent_transcript_items/agent_transcript_payloads` 是私有业务数据，不是普通日志；append-only 不豁免隐私、撤销和物理清理。服务端运行时读取显式关联 user/session/turn，不能依赖不可枚举 ID 或 hash 去重代替鉴权。不得新增任意用户/运营可读原始 prompt 的查询入口。
- 会话归档仍遵循 `05`：有未终局 turn/workflow 时拒绝，归档后关闭用户访问，不恢复、不取消已提交费用，也不立即删除账本/申诉证据。新 transcript 与私有 payload 在归档后按审计快照窗口清理，物理保留 180 天、备份 365 天；关联法定/申诉保全时按已批准保全规则保留最少证据并记录原因，不把全部 prompt 无限期保留。
- 素材删除、隔离、风险冻结或版本漂移后立即阻止新物化。依赖该资源的历史 inspection/派生语义 payload 与 summary 不得绕过撤销进入后续模型；受控引用需包含依赖索引以定位失效范围，无法精确证明摘要不含已撤销内容时使整个 checkpoint 不可用。原始用户自己输入的文本不因此伪造改写；其资源权限仍重新裁决。
- 清理/撤销作业使对应 transcript generation 与任何模型投影缓存失效，禁止回填任务从旧 message/trace 再导入已删除内容。普通对话更正通过追加来源明确的 item；真正的隐私清理允许移除正文/私有 payload 并保留最小 tombstone/关联审计，不通过伪造工具成功来修补配对。
- 未启用的失败 backfill 只允许清理其 import attempt 产生的派生副本；不得删除源 chat message、用户数据、资金流水或 migration 记录。生效后的历史不走该清理捷径。摘要、payload 副本和后续缓存均纳入同一撤销/到期测试。
- 日志、trace、队列、outbox、SSE、报错对象和验证报告只记录 ID、版本、digest、字节数、token 数、状态和延迟，不记录完整创意 prompt、私有正文、图片字节、Key 或签名 URL。审计 payload 可由受限服务读取不意味着可以 `console.log` 整个对象。
- 新格式的必要语义参数允许在私有存储中保持完整，不得用日志脱敏函数删掉执行所需字段后当作可恢复数据。legacy trace 中已有的草稿仅供原格式受限恢复；排空兼容期结束后按同样生命周期清理，不继续向新格式 trace 写正文。
- `05` 的模型来源绑定只在 trace 保留最小 step 归属、状态和输入/输出摘要，不增加 prompt 副本。可读 transcript 仍依赖这些证据时，诊断清理不得先删除它们；语义正文被撤销时立即停止物化，不因来源摘要还在而继续读取。归档到期按同一受控清理计划移除来源摘要与语义数据，依法保全只保留批准的最小证据。完整生命周期测试通过前不得启用生产捕获。
- P1/P2 不开启额外 Provider 内容存储；P3 续传必须先明确实际 relay/Provider 的地域、访问范围、保留和删除行为并通过准入，不因技术可用就默认获得数据留存授权。

## 5. 分享隐私

阶段 2A 前默认不开放公开分享页。开放时遵守：

- 只展示用户明确公开的创意产物。
- 默认关闭“允许做同款”。
- 不暴露完整提示词。
- 不暴露原始上传素材。
- 不暴露商品事实。
- 不暴露资产 URL。
- 不暴露任务完整快照。

允许做同款时仅复用：

- Skill 版本。
- 公开的风格/配方参数。
- 安全占位输入。

## 6. Provider Key 和密钥

参考旧工程 Provider Key 加密模式，新项目要求：

| 密钥             | 存储                     |
| ---------------- | ------------------------ |
| Provider API Key | 加密后入库或环境密钥管理 |
| Webhook Secret   | 环境变量或密钥管理       |
| 对象存储 Key     | 环境变量或密钥管理       |
| 加密主密钥       | 不入库，不进入日志       |

规则：

- 保存 `key_hint`，不展示完整密钥。
- 保存 `key_version`，支持轮换。
- 保存 `last_verified_at` 和 `validation_error`。
- 任何密钥验证接口不得返回原始密钥。
- 日志和 Provider 请求摘要必须脱敏。

## 7. 权限模型

| 角色     | 权限                                             |
| -------- | ------------------------------------------------ |
| 游客     | 浏览公开页面和模板示例，不可生成                 |
| 免费用户 | 生成、上传、查看自己资产和任务，受积分和并发限制 |
| 会员     | 更高并发和权益，支付前只展示或内测手动开通       |
| 运营     | 任务查询、申诉处理、风险账户处理                 |
| 管理员   | 模型配置、熔断、账本对账、系统配置               |

所有用户资源必须按 `user_id` 过滤。

## 8. 内容安全与保真边界

内容安全：

- 判断违法、违规、平台禁用项、敏感内容。
- 可以硬拦截。
- 不由保真校验器替代。
- 生成前文本审核失败或审核服务不可用时 fail-closed，不得投递生成任务。
- 生成后图片审核未通过或结果未知时，产物以 `artifact_visibility=quarantined` 入库；用户不可查看、下载或分享，运营复核通过后才转为正常可见状态。
- 隔离产物默认保留 30 天，人工复核目标 SLA 为 24 小时；到期仍未处置的隔离对象进入删除队列并保留审计记录。

商品保真：

- 判断商品事实、SKU、包装文字、Logo、结构等与用户确认事实是否冲突。
- 1A 只提示 `warning/unknown`。
- 2B 校准后可对确定事实冲突 `hard_block`。

平台规范：

- 判断尺寸、白底、主体占比、文字占比、平台规则。
- 不判断商品真伪。

## 9. 法务门禁

封闭免费内测前：

- 用户协议内测版。
- 隐私政策内测版。
- 用户上传素材授权说明。
- 人像、合照、第三方照片和可能涉及未成年人的素材政策：必须由产品/法务明确适用年龄、授权主体、监护人路径、允许用途、Provider 处理地域、保存/删除和申诉规则；未形成已批准版本前，对应首版人像 Skill 不得在 beta 激活。
- AI 生成内容风险提示。
- 内测积分不具现金价值说明。
- 申诉和人工裁决规则。

工程只负责展示并固定用户同意的已发布版本、保存素材授权声明和安全审计，不自行推断肖像或第三方授权已经成立。首版不开放换脸、公众人物身份复刻或未确认换装；除非未来独立契约和法务门禁批准，不保存人脸特征向量或建立身份识别库。

公开/付费上线前：

- 积分购买、退款、过期、服务终止规则。
- 会员权益和赠送积分生命周期。
- 商用授权范围。
- 模型供应商条款确认。
- 模板投稿和做同款许可。
- 内容违规处理和账号封禁规则。
- 适用地区法律审查。

面向中国大陆服务器、大陆 CDN 或大陆公开经营链路前：

- 域名 ICP 备案完成，服务器绑定已备案域名。
- HTTPS 证书配置完成。
- 对象存储访问域名、CDN 域名和分享页域名符合备案要求。
- AI 生成内容提示、深度合成/生成式 AI 相关合规要求完成法务复核。
- 确认是否触发等保 2.0、算法备案、深度合成服务备案或其他地区性合规要求。
- 未完成大陆备案门禁前，不使用大陆服务器和大陆 CDN 做公开/付费上线。

香港 Beta 说明：

- 使用中国香港服务器可作为封闭内测/Beta 的快速上线方案，通常不需要大陆 ICP 备案。
- 香港 Beta 仍必须完成用户协议、隐私政策、素材授权、AI 生成内容风险提示、模型供应商条款和内容安全策略。
- 香港 Beta 不得被表述为“规避合规”；它只是部署地域选择，不改变平台对用户内容和 AI 生成内容的责任边界。

## 10. 产品水印与 AI 生成标识

1A 决策：不生成产品水印，也不向导出文件写入 AI 标识。S12/S13A/S13B
不得按免费/会员权益修改最终像素，不把水印或 AI 标识作为发布、计价或上线验收门禁。

平台仍保存内部任务、模型、生成时间、lineage 和审核记录，用于权限、账务、审计与问题排查；
这些内部元数据不得被当作面向用户文件的 AI 标识，也不得依赖 EXIF、隐写内容或图像相似度
反向判断产物修改权。对外法律文本和页面只陈述已实际实现并经审查的能力。

## 11. 审计日志

必须记录：

- 管理员查看用户资产。
- 管理员冲正积分。
- 申诉裁决。
- 用户风险确认。
- 分享创建和撤回。
- 用户删除资产。
- 模型熔断和恢复。
- 密钥验证和更新。

审计日志至少包含：

- actor。
- action。
- target。
- before/after 摘要。
- ip/user agent。
- created_at。

## 12. 认证、邮件与来源身份安全

### 12.1 Session、Cookie 与 CSRF

- Better Auth session 使用 `HttpOnly`、`Secure`（local HTTP 例外）、明确 `SameSite` 和最小作用域 Cookie；禁止把 session token 放入 URL 或普通日志。
- 登录、注册、OTP 重发/校验、找回和密码重置统一校验 `Origin`/`Host`；Cookie 认证的写接口必须启用 CSRF 防护，不能只依赖前端隐藏按钮。
- 密码重置成功后撤销该用户全部旧 session；注册 OTP 通过前只存在待注册 claim，不创建未验证用户或 Session，也不得发起生成、上传或收费动作。
- `verification_ticket` 只存在于 HTTPS 响应体及前端内存，确有刷新恢复需要时可进入 `sessionStorage`；禁止进入 URL、浏览器历史、日志、队列、埋点和 `localStorage`。
- 注册 verification ticket 明文不入库，服务端只保存独立 HMAC；成功重发后轮换，验证成功、第 5 次错误、claim 过期或风险封禁时立即作废。找回密码不复用注册 ticket，使用 `password_reset` purpose 绑定的 OTP + email 一次性完成重置。

### 12.2 可信代理与 IP 身份

- 客户端传入的 `X-Forwarded-For`、`X-Real-IP` 和 `Forwarded` 默认不可信。只有 socket peer 位于 `TRUSTED_PROXY_CIDRS` 时，API 才按已配置 hop 解析由反向代理覆盖写入的 header。
- 非受信直连请求忽略所有转发 header，只使用 socket remote address。staging/beta/production 的代理拓扑或 CIDR 不匹配时启动/健康门禁失败，禁止静默信任任意代理。
- IPv4 按单地址、IPv6 默认按 `/64` 前缀形成限流身份，再使用独立 HMAC；原始 IP 不进入 Redis key、指标 label 或普通应用日志。
- 安全审计确需保存原始 IP 时必须限制访问并按本节保留期删除；设备身份同样只保存不可逆摘要和必要规则版本。

### 12.3 Secret 分域与轮换

以下数据域必须使用彼此独立、服务端专用且支持 `key_id` 的 secret/keyring，禁止复用 Better Auth、Provider 或邮件密钥：

- OTP HMAC：`AUTH_OTP_HASH_SECRET`。
- 限流 identity：`AUTH_RATE_LIMIT_SECRET`。
- verification ticket：`AUTH_VERIFICATION_TICKET_SECRET`。
- 邀请码注册校验 HMAC：`AUTH_INVITE_CODE_KEYRING`。
- 注册奖励邮箱族：`AUTH_REWARD_FINGERPRINT_KEYRING`。
- 邮件收件人摘要：`MAIL_RECIPIENT_HASH_KEYRING`。
- Provider callback body/dedup 摘要：`PROVIDER_CALLBACK_DIGEST_KEYRING`。

Provider webhook 验签密钥/公钥按厂商 adapter 独立配置，不得与 API Key、callback digest keyring 或其他 Provider 共用。验签 key 轮换期间只允许显式 key ID 对应的受信版本；callback dedup 使用独立 keyed digest，防止数据库中的 body digest 被离线枚举或跨域关联。

active key 只负责新写入；旧 key 在有效数据保留期内继续用于候选查验。轮换不得让有效邀请码永久失效，也不得让历史奖励指纹或 callback dedup 失去去重能力。邀请码注册校验只使用 HMAC、key ID 和可选非敏感前缀；完整明文使用独立 envelope keyring 加密保存，只允许出现在首次创建响应或管理员对单个可用邀请码执行的受控 reveal 响应。批量列表、日志、审计和事件永不返回明文、密文或 digest；reveal 必须 step-up、`no-store` 并写不含明文的审计。

### 12.4 日志脱敏与数据保留

- 结构化日志、审计 metadata、事件、队列和 `mail_deliveries` 禁止记录 OTP、ticket、完整邮箱、邀请码、Cookie、Authorization、邮件正文/主题、SDK 原始响应或错误。
- 唯一 OTP 明文例外是 `APP_ENV=local` 的 `ConsoleMailAdapter` 专用终端输出；该输出不得经过通用 logger、文件或日志采集 sink。
- `mail_deliveries` 仅保留收件人 HMAC、purpose、provider、状态、脱敏错误码和关联 ID；默认保留 180 天后清理或聚合。
- `registration_claims` 的 pending/expired/released 安全记录默认保留 180 天，但终局 claim 必须先清除待注册邮箱、昵称、密码哈希与 ticket；`registration_reward_claims` 和正式 invite redemption 作为奖励审计默认保留 365 天，法务或财务要求更长时走评审。
- `provider_callback_events` 的 retryable unmatched 在线归并窗口固定为收到事件后的 24 小时；到期转永久 dead letter 并停止自动归并，但不直接物理删除。脱敏处理证据默认保留 365 天；raw body/headers/signature 从不持久化。到期清理不得删除仍处于人工核销或关联资金争议的记录。
- Redis 限流、冷却和锁按各自窗口 TTL 自动过期，不作为长期审计真相。
- 指标禁止使用 email/IP/device HMAC 作为 label，避免高基数和跨表关联泄露。

### 12.5 邮件能力边界

- Web、Agent、Skill 和 Worker 不得获得“任意收件人 + 任意正文”的通用邮件能力。认证模块只提交固定 purpose、OTP、有效期和 locale 的结构化命令。
- 邮件网络调用不得位于数据库事务内；调用前先提交 `mail_deliveries.queued`。
- 明确 `not_dispatched` 才可短退避重试；`accepted` 或 `outcome_unknown` 禁止自动重发。
- staging/beta/production 禁止 console/fake 适配器，也禁止真实邮件失败后打印 OTP 降级。

### 12.6 Skill 包供应链安全

- Skill 安装只接受隔离上传后的 package artifact ID；管理 API、CLI 和 manifest 均禁止任意 URL、Git 凭据、header、命令或服务器路径注入。
- archive 解包必须同时限制压缩前后总字节、文件数、单文件大小、嵌套层级和耗时，并拒绝 zip-slip、symlink/hardlink、设备文件、绝对路径、`..`、反斜杠、NUL、Unicode/case-fold 路径冲突。
- Skill 包是数据包，不是插件代码：禁止 install hook、脚本、可执行文件、WASM、容器、migration、Provider adapter、ToolContract 和网络访问。允许类型只有规范化 Markdown、strict JSON/JSONL 与经 magic-byte 校验/去元数据重编码的 PNG/JPEG/WebP；HTML、SVG、PDF、字体、嵌套 archive 和 MIME 伪装一律拒绝。
- manifest 中 Skill/资源正文始终视为低信任知识数据，不能声明 system/developer 指令、权限升级、工具注册、费用绕过、任意外部通信或密钥读取。命中密钥、token、签名 URL、凭据格式、外部品牌受限资产、未声明许可证或越权指令模式时 fail closed；静态扫描通过不代表获得执行权，运行时 ToolPolicy/Compiler 仍是最终门禁。
- validation/eval 进程使用无网络、无生产 Key、无用户数据的隔离执行环境；包内 eval 不拥有审批权，平台强制负例与人工审批不可被 manifest 关闭。
- package archive、validation report、审批与 catalog release 全部按 digest 关联并追加审计。发布后资源不可原地覆盖；回滚只切换已审批 release，不删除证据。quarantine 原始 archive 默认在 package 终局后保留 30 天供安全复核，已审批 package 的规范化内容寻址资源和 validation/release 证据至少保留 365 天，且只要被历史 turn/release/audit 引用就不得删除。
- validator、强制 eval、许可证或安全策略升级时可对相同 package digest 重扫。critical 命中立即终局 disabled、告警并阻止新 catalog/turn；历史 turn 仅保留审计可复现性，不因此获得继续执行已停用知识的权利。停用恢复必须新版本、新审批和新 release。
- Skill 文本属于经审批的受控知识，但不获得 system/developer/admin 权限。validator/runtime 必须拒绝伪装高优先级、要求忽略平台 policy、修改 ToolPolicy/Compiler/Credit/ownership、启用未注册工具、泄露隐藏上下文或注入 Provider/Key 的指令；合法创作 persona 只能影响风格。
