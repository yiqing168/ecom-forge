# S12 图片执行、安全审核与发布公共管线

| 项     | 内容                                                                                    |
| ------ | --------------------------------------------------------------------------------------- |
| 状态   | v0.8 图片 Provider 600 秒专用超时与最小请求字段收口后可复审                             |
| 阶段   | 1A / D4-D5                                                                              |
| 优先级 | P0                                                                                      |
| 依赖   | S01-S11、S14A 已验收                                                                    |
| 目标   | 建立图片生成/编辑共用的执行、计价、审核、隔离和发布管线，并以白底精修完成首个端到端闭环 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` 阶段 1A 验收标准
- `docs/01-architecture-and-transaction-contract.md`
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/spec/S14-user-center-and-minimal-admin-console.md`
- `docs/spec/S13-creative-generation-and-chat-edit-e2e.md`
- `docs/spec/S13B-first-release-specialized-creative-skills-e2e.md`

## 当前模块范围

包含所有图片生成/编辑能力共用的确定性执行入口：消费 S14A 已发布的用户模型与规格积分目录、生成前文本/图片审核、Provider 调用、生成后图片审核、quarantine、artifact 发布、下载/存库、结算/释放和人工审核挂载点。1A 明确不生成产品水印，也不写入 AI 标识；两者不属于 S12 实现或验收范围。S12 必须交付编译期注册并完成真实 PoC 的 `openai_images` adapter，同时证明 `/v1/images/generations` 与 `/v1/images/edits` 两条固定协议路径，以及文本/图片审核 adapter；不能只把管理台模型建档或 fake Provider 作为真实执行证据。商品白底精修是本 SPEC 的首个 vertical slice，负责事实确认、7 个热门类目 auxiliary 的受控动态加载和保真 warning/unknown；S13A/S13B 的创意生图与本会话改图必须复用同一公共管线。

不包含套图、详情页、平台规范完整引擎。

## 交付面

| 交付面          | 要求                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端/UI         | A04 解析/商品事实/积分核对状态/结果；不显示费用卡；在 S14A O07 中增加内部审核模型建档、PoC、审批和 runtime 切换                                          |
| 后端/API        | 公共图片执行入口、Skill 执行链路、quote、workflow、artifact、evaluation；内容安全人工处置 API                                                            |
| Worker/Provider | 真实图片生成/编辑与文本/图片审核 adapter、PoC；先审核，再按 S14A 固定快照调用图片模型；产物经图片审核和发布处理后开放                                    |
| 数据库          | 前向迁移 moderation runtime/preflight/review、artifact publication 字段与 `artifact_input_bindings`；复用 product facts/workflow/task/attempt/evaluation |
| 测试            | 1A 核心 E2E、资金闭环、保真结果                                                                                                                          |

### 内部审核模型控制面

- 文本/图片审核模型是平台内部执行模型，不是用户可选产品模型，不创建 `model_catalog_entries` 或积分 SKU，也不进入 `/api/v1/model-catalog`。
- S12 复用底层 Provider channel、credential、`models`、PoC run、状态 CAS、熔断和审计链路，但不恢复独立 `/api/v1/admin/models` 或 `moderation-runtime` 管理接口。管理员仍只配置一个 OpenAI 多模态 Brain；保存前服务端用固定安全文本、违规文本和安全图片执行受限审核探针，通过后在同一 Key/endpoint/model 下生成不可见的 `protocol_family=openai + api_variant=openai_responses` 审核快照，并原子绑定 `moderation.text` 与 `moderation.image` runtime。Anthropic Brain 不冒充审核模型；仅 local/test 可在尚未配置真实 OpenAI Brain 时使用隔离 fake fixture，fake 不得进入 development/beta/production runtime 或上线证据。
- 审核快照是统一模型配置的内部派生记录，不进入管理列表/详情。固定 probe 只允许编译期声明的审核 capability、system policy、样本和输出 schema，不接受管理员自定义 prompt、URL、header 或样本。
- 只有绑定 active channel/credential、固定审核 PoC 通过且状态为 `poc_passed` 的精确 model snapshot 才能写入 `moderation_runtime_states`；文本和图片 capability 各有独立 active pointer/revision，同一模型可在证据覆盖两项时被两个 pointer 引用。Worker 不得从环境变量、model 名称、创建时间或任意 catalog 默认值猜审核模型。
- 每次执行把实际审核 model、capability、credential 与策略版本固定到 task/attempt 快照；审核路由缺失、失效、circuit open、调用 unknown 或恢复时快照不可验证均返回 `CONTENT_SAFETY_UNAVAILABLE` 并 fail closed，不得自动换模、回退 fake 或绕过审核。
- moderation adapter 复用 Vercel AI SDK 的 OpenAI Responses provider，固定无工具 system policy 与版本化 strict 判别 schema：pass 为 `{decision:'pass',policy_version,confidence}`，blocked 为 `{decision:'blocked',policy_version,confidence,reason_codes}`，unknown 为 `{decision:'unknown',policy_version,error_code}` 且不允许 confidence。`confidence` 必须是可信 `[0,1]` decimal，reason code 来自编译期 registry，不保存自由文本解释。SDK retry 关闭且每个 operation 最多一次网络请求；adapter 不得进入 Agent 工具循环，不得接受管理员/用户 prompt、URL、header、response schema 或工具定义。图片审核模型的固定 PoC 必须证明所选 Responses model 与 relay 确实支持受控图片输入，否则不能激活 `moderation.image`。
- moderation runtime 激活只校验真实能力、证据和运行状态，不把未知 Provider 成本伪造成 `0` 或估算常量。图片公开积分由 S14A SKU 独立提供并在 Provider 前冻结；成功交付按该 SKU 积分结算，失败按对应输出释放。Provider/审核真实成本若可获得只进入独立内部观测，不参与用户结算，也不得在结算后补扣。
- quote 固定两条 moderation runtime revision、精确模型/价格/配额/证据 digest 和按输入图数/输出数计算的保守 exposure；submit 时 revision/digest 漂移必须重新报价。审核实际成本进入 Provider 成本与预算指标，用户积分仍只按已确认 billable SKU 结算。
- 该扩展复用 `models` 表和统一模型配置 API，不新增第二套审核模型表、菜单或密钥入口；修改/删除当前 OpenAI Brain 时，审核快照与 runtime 必须在同一事务内切换或失效，不得静默回退另一模型。S14A 已验收的 `brain/image/video` 用户目录语义保持不变，S14B 只补运营查询和处置页面。
- S12 同步扩展固定 Admin role registry：`operations`、`security_admin` 和 `super_admin` 获得 `moderation.read`，其中 `operations`、`security_admin` 和 `super_admin` 也可在 step-up 后使用 `moderation.decide`；`support`、`finance` 不获得内容证据访问权。权限集合变化必须通过前向迁移/受控升级更新受影响 binding 的 permission snapshot hash、递增 principal `authz_version` 并使旧 Session 下一请求失效，不能让运行中的旧 Session 因代码热更新静默提权。

### 图片模型协议与路由

- 首个图片 adapter 固定为 `protocol_family=openai + api_variant=openai_images`，通过配置通道调用 OpenAI Images 兼容的 `/v1/images/generations` 与 `/v1/images/edits`；Anthropic Messages 不承载本阶段图片模型，Vercel AI Gateway 不在链路中。
- relay API origin 必须来自服务端 `PROVIDER_RELAY_ORIGINS` allowlist，可以是经批准的合规中转站或厂商官方直连 origin。Provider 返回图片 URL 时，其 origin 必须独立命中 Worker 的 `PROVIDER_IMAGE_OUTPUT_ORIGINS` 精确 HTTPS allowlist；输出 allowlist 不授予 API endpoint 权限。管理员和用户均不能提交任意 URL、header 或 Provider request body；adapter 负责固定路径、鉴权头、请求 schema、超时和响应解析。图片生成/编辑使用独立的 `IMAGE_PROVIDER_REQUEST_TIMEOUT_MS`，默认且硬上限均为 600000ms，以覆盖 4K 等慢速图片任务；不复用 Brain/审核等通用请求超时。超时仍按 Provider 三态收敛，若请求可能已送达则为 `outcome_unknown` 且禁止自动重投。
- 管理台可以发布多个图片 catalog entry，用户在 S11 页面选择其中一个；每个 task 只解析并冻结一个精确 model/channel/credential/spec/SKU snapshot。投递后、失败后或 `outcome_unknown` 后都不得自动换到其他模型。
- 分辨率、比例、数量、参考图角色、输出格式、价格和 Provider 参数全部来自不可变 capability/spec/SKU 与 task snapshot。客户端只提交已冻结的产品化选择和 `generation_preferences`，不能直接提交 Provider model 名、endpoint、header、request body 或价格。
- 1A 图片 adapter 对 OpenAI Images 兼容请求显式发送 `response_format=url`，优先接收短期 HTTPS URL，并兼容 relay 实际返回的 bounded base64。URL 必须无凭据、命中独立精确 origin allowlist、禁止重定向，并由 Worker 以有界响应体和有界并发下载；data URL、未批准 origin、重定向及任意其他二次抓取一律拒绝。响应 JSON、base64 和下载字节都按已冻结输出数与单图上限约束，随后校验 magic byte、MIME、维度、输出数和 hash；完整 URL、签名、响应体和图片二进制不得进入日志、数据库或队列。
- 解码字节只存在于 Provider adapter 到 Worker 隔离写入器的非序列化进程内结果中，不进入通用 output DTO、数据库、队列、日志或错误。Worker 成功写入固定 quarantine 对象并记录 hash 后才允许 task 收敛为 succeeded；收到 Provider 成功结果后、隔离对象落稳前崩溃视为 `outcome_unknown`，保留成本 exposure 且不自动重投。

### 商品档案与事实确认入口

- S12 的 Brain 输入必须真正携带当前 turn 已授权图片的二进制内容，不允许用文件名、空字段、客户端 OCR、公开 URL 或服务端固定规则冒充识图。Worker 在每次 continuation 首次 Brain 调用前按 `user_id + binding_key + object_id + object_version + content_hash` 重读数据库与私有存储，复算 hash、MIME、尺寸和总字节上限；模型只看到稳定 `binding_key/role` 与图片字节，不看到 asset ID、storage key、签名 URL 或任意 header。所选 Brain snapshot 未声明 `input_modalities=image` 时在网络前 fail closed。
- Agent terminal protocol 增加固定 `agent_request_product_facts@1`：模型从一个 `role=product` 的授权图片返回 `source_binding_key`、strict `candidate_facts` 与有界可观察 evidence。服务端重新绑定真实 asset/version，忽略模型对内部资源身份的任何推断，再创建确认卡；模型不能提交 product ID、asset ID、必需字段规则或确认结果。禁止从 `display_name`、扩展名、路径或历史默认值生成候选事实。
- 用户确认后，latest fact set 的结构化安全投影进入后续 Brain 动态上下文；Compiler 仍重新查库并冻结 fact set/version/digest，不能信任模型记忆。多轮对话不得重新识别并覆盖已确认事实；源图或 latest fact revision 漂移时要求重新确认。
- S12 在既有 `POST /api/v1/agent/turns/{turn_id}/confirm` 上注册唯一的 `product_facts@v1` handler，不新增第二套公开确认接口。确认卡由服务端固定 `mode=create_product|link_product`、当前用户的 `product_id?`、`expected_latest_fact_set_id?`、`source_asset_id/source_version`、候选事实、必需字段和 payload digest；客户端不能替换资源 ID、版本或所属商品。
- `answers` 按服务端 payload mode 使用 strict v1 判别：`create_product` 只接受 `{sku_code?,facts}`，`link_product` 只接受 `{facts}`。`facts` 完全复用 S10 `productFactsSchema`，`facts.product_name` 是商品身份和新档案名称的唯一真相；未知项写 `unknown_fields`，不能用空字符串、模型猜测或前端隐藏默认值冒充确认。`sku_code` 只允许 create 模式提交并沿用 S10 可选规范化规则，link 模式修改 SKU 必须走既有商品编辑 API。
- `create_product` 在一次短事务内按固定顺序锁 turn/confirmation，创建当前用户的最小商品档案、关联已验证 ready 原图、追加首个 `product_fact_set`、更新 latest fact/revision、回答 confirmation 并写 continuation intent/outbox；`link_product` 锁定并重校验当前用户已有 active 商品、source asset 归属和 `expected_latest_fact_set_id` 后追加新 fact set。两种模式都复用 S10 领域 Service，不发内部 HTTP、不在事务内调用 Brain、审核、Provider 或存储。
- 同一用户幂等键和相同确认 payload 重放首次响应；不同 payload 冲突。CAS 落后、源图版本漂移、商品归档、跨用户或 source asset 非 ready 均 fail closed，且不留下半个商品、事实集或已回答 confirmation。
- 白底精修的阻断最小事实是已确认的 `product_identity` 与 `visible_text` 处置结果；“当前无可见文字”是显式确认结果，无法辨认则保持 unknown 并按任务需要澄清。主色/关键颜色、Logo/包装标识在可观察时进入确认卡；材质、结构、尺寸等只有 Skill 当前计划需要或用户提供时才升级为必需事实，不为填满字段强行追问。
- S11 已提交的 `commerce-white-background-first-release@1.0.0` 把 `material` 误列为通用必需事实。S12 激活前必须发布不可变修正版 `1.0.1`，将 primary 的 `required_facts` 对齐本节，重算全部受影响 definition/resource/package hash 并走正常验证、审批和 catalog release；不得原地覆盖 `1.0.0`。

## 确定性执行契约

S12 在 S09 静态 capability registry 中注册 `image.generate@1` 与 `image.edit@1`。Candidate 只能提交用户目标摘要和 opaque input binding；比例、分辨率、数量必须与 turn 的 `generation_preferences` 完全一致，模型/spec/SKU、Provider 参数、价格、prompt、对象 key、URL/header 均由服务端 context 解析，出现在 candidate params 时拒绝。白底精修固定走 `commerce_generate + image.edit@1`，至少一个当前用户可读的商品原图 binding 和已确认 fact set；纯文本、跨用户、隔离、已删除或无 hash/version 的输入不编译。白底产物在本会话继续改时走 S13A 的共享 `chat_artifact_edit` profile，必须从唯一父产物的不可变 `params_snapshot` 继承并校验原 `product_facts_snapshot`，再由服务端把原商品事实与本轮变化/保持项合入 Provider 指令；不得丢失事实、改取 latest fact set 或重复要求用户确认。激活 closure 固定包含 `commerce-white-background@1.0.0`、required `commerce-visual-guidance@1.0.0`、按真人条件加载的 `commerce-human-photography@1.0.0`，以及按事实最多加载一个的 7 个类目 auxiliary：`commerce-fashion@1.0.0`、`commerce-beauty@1.0.0`、`commerce-food-beverage@1.0.0`、`commerce-home-lifestyle@1.0.0`、`commerce-pet-supplies@1.0.0`、`commerce-sports-outdoor@1.0.0`、`commerce-digital-accessories@1.0.0`；实现不得按中文名称或目录扫描猜依赖。

固定时序：

1. Agent 产出 candidate plan 后，服务端按 turn/continuation/input digest 创建 `content_safety_preflights`；通过现有 `agent.continue` 的 DB 恢复链执行真实文本和每个输入图片分片审核。全部 pass 前不调用 Compiler、不创建 quote/reservation/workflow。
2. preflight pass 后，Compiler 重新读取 Skill、facts、bindings、用户选择的 image catalog closure、两个 moderation runtime 和 pricing policy，生成唯一 plan/quote；1A 电商路径使用当前 turn 的 `generate_action@v2`，不创建费用卡。
3. 内部 quote submit intent 仍走 S04 八步同事务：重新验证生成动作证据并冻结当时 active 的精确 storage channel ID，核对余额和并发，冻结积分、创建 workflow、generation task、按预期输出槽位确定的 `moderation.image` task、后续发布/结算 intent 与 outbox。数据库事务内不调用审核、图片 Provider 或对象存储；审核 task 只保存输出槽位和固定模型/策略快照，运行时按 generation task + output index 解析唯一 artifact。后续全局 storage runtime 切换不改历史 task；固定 channel/credential 不可用时 fail closed，不改用新的 active channel。
4. generation task 只从不可变 task snapshot 重建服务端 prompt：用户消息/确认事实/Skill resource/绑定版本/template version 必须与 plan digest 一致；queue payload 继续只带 task/run/attempt/user ID，不携带 prompt、Key、URL 或图片。
5. Provider 返回可信成功回执以及 allowlisted URL 或 bounded base64 结果后，adapter 在进程内解析为有界字节，只把 provider output ID、字节、媒体摘要与 hash 交给同进程隔离写入器。Worker 按 task 冻结的 storage channel 写入确定性 quarantine key，head/read 校验 hash 后在同一短事务创建 `visibility=quarantined` artifact 与全部 `artifact_input_bindings`；未批准 URL、重定向、大小或输出数越界、magic byte/MIME 冲突、维度异常、解码失败和 hash 不符都 fail closed。
6. 固定 profile 若要求区域合成等确定性媒体处理，必须在 Provider 输出隔离入库后、生成后审核前执行。处理器只消费已授权 binding 和服务端快照，以稳定 operation/key 写最终 quarantined 候选，并把输入/输出 hash、处理器版本和 lineage receipt 固定到最终 artifact 的处理快照；中间层不对用户可见、不结算。处理失败、hash 漂移或对象结果 unknown 保持隔离，不能跳过处理或用 Provider 中间层冒充最终结果。
7. 每个最终可交付候选 artifact 激活对应的 `moderation.image` task，通过独立 `moderation` 队列的 `moderation.execute@v4` 创建 task attempt，并按固定 snapshot 对最终像素审核。旧 `task.execute@v1` 只兼容升级前已持久化的审核 intent。attempt 遵循 S07 三态与成本记账；结论、不可变 `artifact_evaluations`、moderation task 终态及 publication/review intent 同事务写入。pass 才执行发布处理并立即发出该张 `artifact.created`，不等待 sibling generation；blocked 保持隔离并释放对应未结算金额；unknown 创建唯一 `content_review_cases`，task/workflow 进入 `waiting_manual_review`。
8. 发布处理先去除非必要元数据，再写确定性 published key；1A 不叠加产品水印、不嵌入 AI 标识。head/hash 校验后以短事务 CAS 固定 publication snapshot、开放 artifact，并写 `artifact.created` 与 settlement intent/outbox。事务提交后由现有结算 Consumer 调用 S04 Credit application service；发布 Worker 不跨事务同步结算，也不直接写 ledger。用户永远不能下载 quarantine 原图或内部处理层。

多输出按 artifact 独立审核和发布，用户只对最终可交付输出按已确认 SKU 结算；blocked/expired 输出不结算，Provider 已发生成本进入内部成本指标。workflow 只有全部输出进入 published 或不可交付终态后才能收敛；部分成功使用已有 partial settlement/release 语义，不把整单重复执行。

## 队列、恢复与安全边界

- generation 消费 `task.execute`，真实生成后审核消费独立 `moderation.execute`；发布仍由审核通过事务收口。旧 `task.execute` 审核 job 保持兼容消费，旧 `evaluation.run` 只保留无网络 evaluator/legacy 语义。新增 job type 必须使用服务端 task snapshot 分派，并完成 processor/reconciler 兼容发布步骤；不修改已提交 payload，也不让 BullMQ attempts 直接重投 Provider。
- generation 与 moderation Provider 都使用 S07 attempt/poll/callback 三态；accepted/outcome_unknown 不创建新 attempt。Redis 全丢只从 DB intent/reconciler 重建仍可处理的 generation/moderation/publication task，不重新创建 preflight、quote、reservation 或 Provider submit。
- preflight started 后崩溃按 `content_safety_preflights` 的 dispatch_state 收敛：仅明确 not_dispatched 可恢复原 operation；可能写出即 outcome_unknown 并阻断，不用新 operation key 自动重审。
- 2026-09-30 等待恢复修正：有效审核 lease 的 pending 使用同一 Agent job 延迟等待，不能将 job 完成后交给 sweeper 消耗恢复尝试。等待不消耗 attemptsMade、不重跑已捕获的模型候选、不提前报价；明确未送达且成功 queued CAS 的审核投递失败才使用有界指数退避。覆盖五次等待后恢复、等待期 sweep、进程接管、未送达预算耗尽及可能写出后异常不重审。
- 发布对象 key 确定且 content hash 匹配时可幂等收敛；不匹配、put/head unknown 或 storage channel 不可用保持 quarantined。不得通过列桶、模糊 prefix 或当前 active channel 猜历史对象。
- `content_review_cases.deadline_at` 由服务端时间计算。bounded Cron 使用 `FOR UPDATE SKIP LOCKED` 扫描到期 pending case，与人工裁决共享 revision CAS；批次上限、游标和延迟指标必须可配置，不能一次锁全表。
- 内容审核、Provider 输出读取和发布转码都在事务外；结果只通过短事务 CAS 落库。日志不记录用户正文、完整 prompt、图片、对象 key、签名 URL、Key、Provider 原始错误或人工证据原文。

## 日志、指标与验收命令

- 结构化日志至少带 `trace_id/turn_id_hash/run_id/task_id/attempt_id/artifact_id/model_snapshot_id_hash/capability/stage/result/duration_ms`；用户、模型和对象标识按各自 HMAC 域脱敏。
- 指标至少覆盖 preflight pass/blocked/unknown、generation 三态与延迟、输出 ingest 拒绝原因、post-moderation、quarantine 数量/年龄、人工复核 SLA、published/blocked 数量、发布处理失败、Provider 实际成本、审核 exposure 和 settlement/release。
- readiness 在 beta/production 必须同时验证图片 adapter、两个 moderation runtime、active storage、内容安全策略和处理器心跳；任一缺失停止新收费图片任务，不能降级 fake。
- 新增 `pnpm validate:image-pipeline`（真实 PG/Redis/私有测试对象根 + fake provider）证明 quote 到发布/结算、拒绝/unknown、并发和恢复；`pnpm poc:provider:image`、`pnpm poc:provider:edit`、`pnpm poc:provider:moderation` 只在显式真实成本门禁下运行，报告写 Git 忽略目录。

## 业务规则

- 阻断最小事实集为商品身份与可见文字处置结果；颜色、主 Logo/包装标识在可观察时确认，材质、结构和尺寸按当前 Skill 需要条件升级。
- 白底精修只允许从 S11 发布包声明的一跳 allowlist 加载服饰鞋包、美妆个护、食品饮料、家居生活、宠物用品、运动户外和数码配件 auxiliary；按已确认事实裁决，事实不足时追问或保持 unknown，不猜类目、不跨类目加载，也不把 auxiliary 暴露为用户主 Skill。
- 1A 保真只输出 pass/warning/unknown。
- 内容安全独立硬拦截。
- 模型、分辨率和积分 SKU 必须来自 S14A active catalog 并固定到 quote/task snapshot；前端、Skill 和 Worker 不得按名称猜价格或替换用户选择。
- 1A 产物不生成产品水印、不写入 AI 标识；发布快照仍记录内容审核、处理器和存储版本，不引入按权益分叉的像素处理。
- 生成后图片审核未通过或结果未知时，产物隔离且不得下载；审核通过后才写可见列表和 `artifact.created` 事件。
- 多输出任务中，每个输出通过生成后审核便独立发布并经 workflow SSE 增量展示；整批 workflow/turn 仍等待全部输出终结后收口。
- 生成后审核拒绝时释放未结算积分；审核未知进入 24 小时人工复核，逾期未通过同样释放，不得对未交付产物结算。
- 失败按 Provider 三态处理并退还或保留冻结。
- 审核未知的 artifact 保持 `quarantined`，进入 24 小时人工审核队列；人工“通过”必须有权限、reason、expected revision、幂等键和审核证据，才能退出隔离并继续结算，人工不得把 unknown 直接改成 pass。审核拒绝只释放未结算资金，不删除审计证据。
- `content_review_cases` 是人工队列和裁决状态真相，原 `artifact_evaluations` 保持不可变。人工裁决的 `confirmation_summary` 固定为 `{ artifact_reviewed:true, assessment:'safe'|'unsafe', policy_version }`，release/safe、reject/unsafe 必须成对且 policy version 与原 evaluation 一致。人工裁决与 24 小时到期 Worker 使用同一 revision CAS；终态、结算/释放、outbox 和成功审计必须原子推进，竞争时恰好一个赢家。
- 1A 人工审核只交付最小可用处置面：pending 列表、单条详情与安全缩略图、通过、拒绝、必填原因和到期状态。只有自动审核 `unknown` 进入该队列；自动 `pass` 直接发布，自动 `blocked` 直接拒绝。首版不做人工预审每张图片、任务分派、多人会签、批量裁决、复杂 SLA 大盘或独立审核工作流编排。

## 测试标准

- Playwright 覆盖完整验收故事。
- Admin Playwright 覆盖审核模型建档 -> 固定 PoC -> 审批 -> 文本/图片 runtime 激活，以及 moderation 不出现在用户 catalog；Anthropic/错误 API variant/错误 capability、无 step-up、证据漂移和并发切换均被拒绝。
- 集成测试覆盖 quote -> run -> artifact -> evaluation -> settlement。
- API/集成测试覆盖 `product_facts@v1` 的 create/link、未知字段、幂等重放、不同 payload 冲突、商品/源图跨用户、资源版本漂移、商品 revision 并发单赢家，以及失败事务不留下商品/事实/confirmation 半状态。
- fake Provider 覆盖成功、失败、outcome_unknown。
- 真实 PoC 覆盖至少一个图片生成、一个图片编辑、文本审核和图片审核模型；图片生成/编辑允许在 600 秒专用上限内完成，超时后不得自动重投；结果含成本、回执三态、质量和脱敏证据，CI 不调用公网。
- 集成测试覆盖 moderation 建档只接受纯审核 capability、禁止进入用户 catalog、两个 runtime pointer 独立切换、失效指针/circuit/credential fail closed，以及并发切换单赢家。
- 资金集成测试覆盖公开 SKU 积分进入 quote/冻结/结算、route 漂移要求重新报价、审核拒绝/unknown 不补扣用户、Provider 实际成本不替代公开积分且未知成本保持 `null`。
- 集成测试覆盖文本拦截、图片审核隔离、发布对象元数据清理与 hash 校验，并断言发布处理不会叠加产品水印或写入 AI 标识字段。
- 集成测试证明每次真实 post-moderation 都有独立 task/attempt、固定 model/runtime/policy snapshot 和成本；旧 `evaluation.run` 不联网，重复/乱序审核回执只写一个不可变 evaluation。
- 队列集成与浏览器测试证明多输出按“生成一张即可并行审核一张”执行，首张 `artifact.created` 早于最后一张 generation 终结；旧 `task.execute` 审核 intent 仍可消费，Redis v4 recovery 按原队列重建且不会重投 accepted/outcome_unknown。
- moderation schema 测试覆盖 pass/blocked 的 confidence 与 registry reason code、unknown 禁止 confidence、自由文本/额外字段/非法 decision/缺失可信 usage 全部 fail closed，且不伪造 evaluation 分数或实际成本。
- 集成测试覆盖生成后审核拒绝/超时不写 consume、释放 reservation。
- 集成测试覆盖人工 release/reject/24h 到期三方并发只有一个赢家，重复裁决重放原结果且 ledger/outbox 各恰好一次。
- 7 个热门类目各有事实充分的正例；事实缺失、跨类目、声明风险和 prompt injection 反例证明只加载允许的一跳知识且不补造商品事实。
- preflight 集成测试覆盖同 turn/input digest 的并发双执行恰好一个审核 operation；started 后在明确未写出、可能写出和回执非法三个崩溃点恢复，分别证明原 operation 可恢复或 outcome_unknown 不自动重审，并且任何未 pass 路径都没有 quote/reservation/workflow。
- Provider 输出读取反例覆盖任意 URL、重定向、loopback/私网/保留地址、超大响应、magic byte/MIME 冲突、维度/输出数越界和解码失败；所有失败都不产生普通可见 artifact、签名 URL 或结算。
- storage 切换测试证明 quote/submit 固定 channel、运行中全局 pointer 切换不改变任务目标、固定 channel 不可用不回退新 channel；Provider 成功回执后到 quarantine head/hash 落库前的每个崩溃点均不自动重投。
- publication 集成测试在 put 成功、DB CAS 前模拟崩溃，恢复以确定性 key 的 head/hash 收敛；hash 冲突、put/head unknown 时保持 quarantined，且 published object、consume、release 和 outbox 各不重复。
- 确定性媒体处理测试证明中间层不可访问/结算、最终合成像素才进入 post-moderation；处理后审核 blocked/unknown 时不得发布已经通过中间层审核的旧对象。
- 多输入 lineage 测试断言 `artifact_input_bindings` 的 role/order/version/hash 完整；跨用户、已删除、quarantined、revision 漂移和伪造 source type 均在 Compiler/Service 边界拒绝。
- 建议测试归属：`packages/compiler/src/capabilities/image-*.spec.ts`、`apps/worker/test/s12-image-pipeline.integration-spec.ts`、`apps/api/test/s12-image-pipeline.e2e-spec.ts`、`apps/admin/e2e/s12-moderation-control.spec.ts`、`apps/web/e2e-live/s12-image-pipeline-live.spec.ts`；真实输出与 PoC 报告写入 Git 忽略目录并按 run ID 精确清理。

## 验收清单

- [ ] 新用户能用赠送积分完成白底精修闭环。
- [ ] 7 个热门类目 auxiliary 均能按已确认事实受控加载，实际加载版本进入 turn/run 快照；事实不足和跨类目请求 fail closed。
- [ ] 积分预估、冻结、结算准确。
- [ ] 保真 warning/unknown 可见。
- [ ] 结果可下载和存库。
- [ ] 发布结果未叠加产品水印、未写入 AI 标识，且与审核通过的最终像素 hash/发布处理快照一致。
- [ ] 文本/图片审核模型可经现有管理控制面建档、固定 PoC、审批和独立 runtime 切换；审核模型永不进入用户 catalog，路由失效时收费生成 fail closed。
- [ ] 内容安全人工处置 API 可查询隔离队列、查看脱敏证据并完成通过/拒绝；并发裁决只有一个赢家，unknown 不可伪装为 pass。
- [ ] S12 验收不依赖尚未开工的 S14B 页面；S14B 负责把已验收 API 接成 O13 页面，S15 再验收 API、页面和真实审核 Provider 的端到端闭环。
