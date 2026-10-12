# S10 商品/SKU、事实集与资产/产物组织

| 项     | 内容                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 状态   | v0.3 实现完成待验收                                                                      |
| 阶段   | 1A / D4                                                                                  |
| 优先级 | P0                                                                                       |
| 目标   | 建立商品、事实、上传资产、生成产物和 Agent 引用的真实数据底座，替换 A05-A08 的 mock 数据 |

## 开工前必读

- `docs/01-architecture-and-transaction-contract.md`
- `docs/05-data-model-and-constraints.md` §8、§12
- `docs/06-api-queue-and-event-contract.md` §2、§4、§9
- `docs/07-1a-user-flow-and-ui.md` §2、§5、§10
- `docs/08-security-compliance-and-asset-lifecycle.md` §2-4、§7-8
- `docs/spec/S08-agent-turn-skill-runtime-and-loop-guard.md` §4、§6、§8
- `docs/spec/S09-deterministic-compiler-r1-r5-and-plan-validation.md` §5-7
- `docs/research/01-full-site-product-interaction-benchmark.md` §4.4、§4.7

S03-S09 已完成。S10 不改变 Agent、Compiler、Credit、Provider 或内容安全的既有裁决；字段、状态、payload 和错误码先回写 `05/06/08` 后再编码。

## 1. 当前范围与边界

### 1.1 本轮包含

- 1A 最小商品档案：商品名、可选 SKU/货号、主素材、归档状态。
- 不可变商品事实版本和 latest pointer 的并发更新。
- 私有图片上传意图、受控上传、异步 magic-byte/大小/hash/尺寸检查和去元数据缩略图。
- 资产、作品的当前用户查询、商品筛选、短期访问 capability 和“作品存入资产库”。
- Agent turn 的真实 attachment/mention binding source，以及 Compiler R1-R5 的数据库快照。
- A05-A08 已有页面接真实 API；保留既有壳、路由、布局和组件，不新增页面或导航。

### 1.2 本轮不包含

- 真实图片生成、生成后内容审核和发布处理；由 S12/S13A/S13B 交付。1A 不实现产品水印或 AI 标识。
- Provider/模型/Key/对象存储云配置管理；由独立 `apps/admin` 的 S14 交付。
- 公共分享、批量、ERP/店铺同步、视频资产、画布和物理清理 Cron。
- 管理员查看隔离产物。S14 前无管理 HTTP 绕行入口。

### 1.3 环境门禁

- S10 的 `local/test` 使用编译期注册的本地私有存储 adapter，测试只能访问独立临时根目录。
- `staging/beta/production` 在 S14 尚未提供已审批存储 adapter/secret handle 前，上传和文件访问 readiness fail closed；禁止临时把云 Key 放入代码、前端或普通环境响应。
- S14 以新前向 migration 为 upload intent/asset/artifact 固定 nullable `storage_channel_id`：legacy/local 行可空，新生产行必须固定当时 active channel。后续 channel 切换只影响新写；历史对象始终按行上的 channel 路由，不批量改写 key，也不去当前 bucket 猜测查找。
- 本地文件路由只接受服务端签发的短期 capability，不能把服务器路径或 `storage_key` 暴露给客户端。

## 2. 复用现有前端

现有 A05-A08 页面已经完成，S10 只接入真实数据与状态：

| 页面         | 路由             | 保留内容                           | 本轮接入                                 |
| ------------ | ---------------- | ---------------------------------- | ---------------------------------------- |
| A05 商品     | `/products`      | 商品网格、搜索、新建弹窗           | 列表、创建、重复 SKU、加载/空/错误       |
| A06 商品详情 | `/products/{id}` | 主图、事实、概览、作品区、创作入口 | 详情、事实版本、素材/作品/任务/成本摘要  |
| A07 资产     | `/assets`        | 网格、搜索、上传入口、选择态       | 上传进度、处理中、失败重试、ready 缩略图 |
| A08 作品     | `/artifacts`     | 网格、筛选、下载/选择动作          | 商品/SKU/来源筛选、隔离占位、存资产/下载 |

实现不得重新设计这些页面，不新增卡片体系或管理入口。现有 `const products/const media` 和附件 `FileReader` data URL 只是 mock，必须替换为独立 API client/hooks；data URL、文件二进制和对象 key 不得进入 turn API、数据库、日志或 localStorage。

必须覆盖 loading、empty、success、error、permission denied、uploading/processing、thumbnail failed/retrying 和 quarantined。桌面/移动布局沿用既有实现并复跑截图检查。

## 3. 数据模型与状态机

### 3.1 商品

- `products.revision` 从 1 开始，编辑使用 `id + user_id + revision` CAS；影响行数不为 1 返回 `PRODUCT_REVISION_CONFLICT`。
- `sku_code` 入库前 trim、Unicode NFKC、转大写；空串归一为 null。唯一约束仍是当前用户内非空 SKU 唯一。
- `primary_asset_id/latest_fact_set_id` 必须指向同一用户且未删除的资源；主素材还必须是 `ready`。
- 归档商品仍可读历史，但不能用于新事实确认或新生成；恢复归档不在 S10。

### 3.2 商品事实

- `product_fact_sets` 只追加，不 update/delete。`version_no` 在商品行锁内由 latest + 1 分配，并由 `unique(product_id, version_no)` 兜底。
- 创建请求带 `expected_latest_fact_set_id`（首版为 null）。锁定商品后不匹配返回 `PRODUCT_FACT_VERSION_CONFLICT`，不能 last-write-wins。
- `source_asset_id` 必须属于当前用户、状态为 `ready`，且 product 为空或等于目标 product。`source_version` 固定为服务端读取的 asset `content_hash`，不信任客户端。
- `facts_json` 使用 strict v1 schema：`product_name`、`primary_colors[]`、`logos[]`、`visible_text[]`、`materials[]`、`must_preserve[]`、`unknown_fields[]`。数组元素 trim、去重并限制数量/长度；未知字段拒绝。
- fact row 与 `products.latest_fact_set_id/revision` 在同一事务写入；事务内无网络调用。

### 3.3 上传与资产

新增 `asset_upload_intents` 保存上传窗口和幂等真相；`assets` 保存资源生命周期。状态如下：

```text
upload intent: pending -> completed | expired | rejected
asset: uploading -> processing -> ready
                         |       -> processing_failed -> processing (显式重试)
                         -> rejected
ready/processing_failed -> deleted（删除实现按 08，物理清理由后续任务执行）
```

- `POST upload-url` 在短事务内创建 intent + `assets(uploading)`；只保存稳定响应、对象 key、限制和过期时间，签名 URL 不落库。
- 其余 S10 写接口使用 `resource_write_requests` 持久化同用户/operation/idempotency-key 摘要、request hash 和稳定响应；领域写入与 completed response 同事务提交。
- 同 `user + Idempotency-Key + canonical request` 在上传窗口内返回同一 intent/asset，并重新签发短 TTL URL；同 key 不同请求 409。窗口过期或 intent 已终局不创建第二个对象。
- 对象 key 由服务端随机生成，不含原始文件名、邮箱、SKU 或可枚举用户路径。原始文件名只保存经过路径剥离、控制字符拒绝和长度限制的显示名。
- `POST complete` 不信任客户端 MIME、大小、hash、尺寸或对象存在性。它只在锁内把 pending intent 标为 completed、asset 标为 processing，并同事务创建第一个 `asset.process/inspect_metadata` intent；重复 complete 重放同一响应，不重复入队。
- `inspect_metadata` 在事务外读取对象并执行有界检查：对象存在、实际大小不超过 20MB、SHA-256、magic byte 仅 JPEG/PNG/WebP、声明 MIME 与真实 MIME 相容、像素数/宽高在配置上限内、解码成功。成功后短事务 CAS 写实际 metadata/content hash，并创建同 revision 的 `generate_thumbnail` intent；不合法转 `rejected` 且不生成缩略图。
- `generate_thumbnail` 在事务外从已验证原图解码，自动旋转、去除 EXIF/ICC/XMP 等非必要元数据，以固定像素上限重新编码 WebP 到独立对象 key。成功 CAS 写 `thumbnail_key/meta_json/status=ready`；基础设施或编码失败写 `processing_failed + safe error code`，原对象保留。
- 用户显式重试只允许本人 `processing_failed` 资产。事务内 revision + 1、状态转 processing，并创建新 job；同一重试幂等键并发只推进一次。BullMQ `attempts` 不是业务重试真相。
- 每个 operation payload 带 `operation_no=asset.processing_revision`。payload 的业务幂等键固定为 `asset:{asset_id}:{operation}:{operation_no}`；BullMQ `jobId` 统一使用 `compositeJobId({job_type:'asset.process',asset_id,operation,operation_no})` 生成仅含安全字符的稳定摘要。旧 operation、重复消费或 owner 变化必须按 DB revision/status no-op。
- 资产只有 `ready` 才可作为 Agent binding 或商品主图。列表可以返回 uploading/processing/processing_failed/rejected 的安全状态，但这些行没有原图/缩略图访问 capability。

### 3.4 产物和存资产

- S10 不创建 Provider 产物，只查询已有 `artifacts`。列表按当前用户过滤，并可按 product/SKU、type、origin、created cursor 筛选。
- `quarantined/deleted` 产物列表只返回安全占位和状态，不返回对象 key、缩略图 URL、meta/params；详情、文件、下载、存资产统一拒绝。
- “存入资产库”是幂等写：锁定 artifact 并重校验当前用户与 visibility，创建 `assets(kind=generated, origin=creative_artifact|commerce_artifact, source_artifact_id=...)`。同 artifact + user 只创建一个未删除资产；对象与缩略图可复用不可变 key，但后续物理删除必须按引用计数/证据保留规则处理。
- 资产/产物查询响应使用显式 DTO，不返回 `storage_key`、内部错误、完整 params/prompt、Provider 回执或审核证据。

## 4. 对象访问

- 原图、缩略图和产物均为私有对象。客户端先请求访问 capability，服务端每次重新校验 session、`user_id`、lifecycle/visibility 和 purpose。
- capability 默认 5 分钟、上限 10 分钟，绑定 object key digest、variant、purpose、user 和 expiry；完整 URL/token 不入库、不进日志/审计。
- `preview` 只读；`download` 额外写 `user_activity_logs(download)` 的安全摘要。已删除、处理中或隔离对象即使持有旧业务 ID 也不能获得新 capability。
- local adapter 的 capability endpoint 必须 canonical-path 校验并确保 resolved path 位于配置根目录；拒绝 `..`、绝对路径、反斜杠混淆、NUL 和 symlink 越界。

## 5. API 契约摘要

完整 strict payload/响应和错误码以 `06` 为准：

- `GET/POST /api/v1/products`
- `GET/PATCH /api/v1/products/{id}`
- `POST /api/v1/products/{id}/fact-sets`
- `POST /api/v1/assets/upload-url`
- `PUT /api/v1/assets/uploads/{upload_id}/content`（仅 local/test capability）
- `POST /api/v1/assets/complete`
- `POST /api/v1/assets/{id}/retry-processing`
- `GET /api/v1/assets`
- `POST /api/v1/assets/{id}/access-url`
- `GET /api/v1/artifacts`
- `POST /api/v1/artifacts/{id}/access-url`
- `POST /api/v1/artifacts/{id}/save-to-assets`

所有写接口要求已验证 session、Origin/CSRF、`Idempotency-Key` 和 `Cache-Control: no-store`。资源不存在或跨用户统一 404；不得用错误差异枚举对象。

列表使用 signed keyset cursor，不接受 offset：默认 20、最大 100，排序 `(created_at desc, id desc)`；cursor 绑定 user、筛选条件和版本，同 cursor 改筛选返回参数错误。

## 6. Agent attachment 与 Compiler binding

- S10 激活后，`POST /api/v1/agent/turns` 允许 message 为空但至少一个 attachment；附件仍最多 12、mention 最多 24、position 连续且 binding ID 唯一。
- 正式前端只发送 `resource_type=asset|artifact`。兼容的 `upload` 只接受当前用户已 completed 且目标 asset 已 ready 的 upload intent，并在服务端归一为 asset；处理中返回 `AGENT_CONTEXT_UNAVAILABLE`。
- create turn 的同一事务内重新读取所有资源，并构造不可变 attachment snapshot：`binding_id/kind/object_id/object_version/content_hash/owner/readable/mutable/producer fields/media_type/lifecycle/visibility/role/position`。客户端的 `resource_version` 只作乐观一致性检查，必须等于服务端 content hash；不一致返回 `REFERENCE_NOT_AVAILABLE`。
- artifact 只有当前用户且 `private/shared/public` 可读；`mutable=true` 仅限 `producer_mode=chat + producer_session_id=current session + mutation_owner=chat_session`。asset 永远 `mutable=false`。
- snapshot 写入 user `chat_messages.attachments` 并进入 turn create request hash；CompilerContext 只从该不可变 snapshot 构造 bindings，同时在 compile 前按真实 ID 重新读取 lifecycle/ownership/content hash。资源漂移、删除、隔离或跨用户统一 fail closed。
- mention 只能绑定当前 attachment 的 binding ID。没有 attachment 的模糊 `@` 不搜索全库。
- `mention_bindings` 非空时，只有被引用的附件进入 turn 绑定快照；上传但未引用的附件不参与本轮生成。没有引用时维持全量附件语义。
- S10 补真实数据库 R1-R5 集成测试：当前会话 artifact 可改、跨会话只可参考、canvas/suite 不可在 chat 修改、asset 只可输入、跨用户/隔离/删除统一不可用。

## 7. Worker、恢复与可观测性

- 新增 asset processor，只消费 strict `asset.process`。处理前按 `asset_id + user_id + operation_no + status` claim；网络/文件 I/O 在事务外，结果按 revision CAS。
- 进程在对象读取/缩略图写入后崩溃，重放可以重新计算同一确定性派生物；thumbnail key 由 `asset_id + content_hash + processor_version` 确定，重复写必须同内容，不生成无限对象。
- Redis 全丢时，reconciler 只重建 DB 中 processing 且当前 revision 缺失/未完成的 asset intent；ready/rejected/deleted/processing_failed 不自动重跑。
- 指标至少包括 upload intent 创建/完成/过期、inspect result、thumbnail latency/failure、processing backlog、binding rejection reason。label 不含 user ID、文件名、对象 key 或 URL。
- 日志只写 request/trace/asset/upload ID、operation/revision 和稳定错误码；不写文件二进制、完整 hash、原始文件名、对象 key、签名 URL、prompt 或 EXIF。

## 8. 测试标准

### 8.1 API/数据库集成

- 商品创建/编辑/归档、SKU 归一与并发重复、revision CAS。
- 事实版本并发提交只有一个 latest 胜者；历史版本不可变；跨用户 source asset 拒绝。
- upload-url/complete/retry 三条写路径的同 key 重放、不同 payload 冲突和并发恰好一次 intent。
- 所有商品/asset/artifact 查询显式 user 过滤；跨用户和随机 UUID 返回相同 404。
- quarantined/deleted/processing 资源不能签 access URL、存资产或进入 binding。

### 8.2 Worker 真实集成

- 使用独立 `_test` 数据库、唯一 Redis prefix 和测试临时存储根；只按 `test_run_id` 精确清理，禁止 drop/recreate/reset、`FLUSHALL/FLUSHDB` 或清开发上传目录。
- 上传 JPEG/PNG/WebP -> inspect -> thumbnail -> ready，实际 hash/MIME/尺寸来自服务端探测。
- 伪 MIME、超限、损坏图片、像素炸弹和对象缺失转 rejected。
- thumbnail 失败保留原对象并转 processing_failed；并发重试只创建一个新 revision，旧 job 晚到 no-op。
- 模拟缩略图写入后崩溃，重放收敛同一 thumbnail key，不重复副作用。

### 8.3 Web 与真实联调

- 组件测试覆盖列表 loading/empty/error、上传 processing/failed/retry、隔离作品和重复 SKU 表单错误。
- Playwright 使用现有 A05-A08 页面完成：创建商品 -> 上传真实图片 -> 等待 ready -> 设主图/确认事实 -> 商品详情查看 -> 资产加入 Agent 输入 -> 按商品筛选作品。
- 桌面和 390px 移动 viewport 截图检查；不得因状态文案、缩略图加载或错误提示产生重叠/布局跳动。

## 9. 正向与反向审查

正向：新建商品 -> 创建上传 intent -> 上传私有对象 -> complete -> inspect -> thumbnail -> ready -> 确认事实 -> attachment snapshot -> Compiler binding。

反向必须证明：伪造 MIME/大小不能 ready；跨用户 ID 无法枚举；complete/retry 并发不重复入队；旧 revision 不能覆盖新状态；隔离/删除对象不能预览或引用；签名 capability 过期/改 variant/改 user 失败；Processor 崩溃后可收敛且不丢原图。

## 10. 验收清单

- [ ] A05-A08 保持现有视觉与路由，mock 已替换为真实 API 和完整状态。
- [ ] 卖家能按商品/SKU 找到素材、作品、任务和积分摘要。
- [ ] 商品事实可追溯且并发更新不会覆盖历史。
- [ ] 上传对象经服务端实际检查后才成为 ready，缩略图异步且失败可重试。
- [ ] 资产/作品跨用户、删除和隔离权限正确，响应不泄露对象 key/内部快照。
- [ ] Agent attachment 与 Compiler 真实 binding 已激活，R1-R5 数据库反例通过。
- [ ] local/test 存储可真实联调；S14 前 staging/beta/production 存储入口保持 fail closed。
