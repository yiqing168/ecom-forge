# S13A 创意生图公共闭环与本会话改图

| 项     | 内容                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| 状态   | v0.5 意象重绘修订：参考图参与全量重构，结构化艺术指导直达图片 Provider                 |
| 阶段   | 1A / D4-D5                                                                             |
| 优先级 | P0                                                                                     |
| 依赖   | S11、S12、S14A 已验收                                                                  |
| 目标   | 实现 1A 创意域公共闭环：自由创作、人像焕新、照片意象重绘、自然语言张数和本会话产物迭代 |

## 开工前必读

2026-09-30 历史素材补充：按 `02` 的有界候选契约，恢复最早组及最近最多 9 个上传组，覆盖其中的中间组；并集仍最多 9 张源图，超限不截断。部分失效只移除校验失败的成员，最近组全部失效不以旧组替代。窗口外素材由分页资产选择器显式加入本轮，不要求重传，也不承诺无限历史自然语言定位。真实 SQL 回归须覆盖中间组、租户隔离、hash 漂移与候选超限后的纯文本继续。

- `docs/PRD-AI创作平台需求文档.md` §2.4
- `docs/01-architecture-and-transaction-contract.md`
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/research/02-agent-skill-content-adoption.md` §10-§13
- `docs/spec/S11-agent-workbench-ui-loop.md`
- `docs/spec/S12-commerce-white-background-refine-e2e.md`
- `docs/spec/S14-user-center-and-minimal-admin-console.md`

## 当前模块范围

多轮选图遵循 `02` 的“会话素材范围决策”：候选保留上传组来源，规划与 Compiler 双重核对 `scope_decision`，不能把候选数量当作本轮生成数量。自动候选跨上传组、且用户没有显式把目标图作为本轮附件/`@` 引用时，须先通过现有澄清入口确认本次绑定集合及总张数，确认不匹配不得报价。验收覆盖新图讨论后的简短确认、明确返回旧图、明确跨组创作及其澄清、确认后改动范围、总数不符、重复引用、旧快照恢复和新快照来源往返；不改变既有报价、预留和 Provider 三态语义。

包含 S11 已交付正式内容包的三个用户必选 primary Skill：“自由创作”“人像焕新”和“照片意象重绘”；包含 Brain 从自然语言解析图片张数、Compiler 报价、Credit 核对/预留后直接执行，以及调用 S12 已实现的本会话指令编辑管线继续改图；同时复用生成前后内容安全审核和发布处理，不另建一套实现。1A 不显示费用卡、执行模式或当次积分上限，不生成产品水印或 AI 标识。连续改图是共享 Tool/lineage 能力，不作为第四个 primary；首发同时允许继续修改本会话由 `commerce-white-background@1.0.0` 生成的已发布产物，但不得借此绕过商品事实保真约束。

不包含视频、头像/壁纸工坊、商品创意大片。

## 交付面

| 交付面          | 要求                                                            |
| --------------- | --------------------------------------------------------------- |
| 前端/UI         | 创意输入、参考图、轻量追问、无数量控件、结果继续改图            |
| 后端/API        | creative Skill route、quote、artifact lineage、内容安全结果处理 |
| Worker/Provider | 文本审核、图片生成、图片审核和发布处理                          |
| Compiler        | R1-R5 校验本会话修改权                                          |
| 测试            | 会话内允许、跨会话拒绝、自然语言张数与积分前置核对              |

## Skill 激活与能力映射

| primary      | intent / capability                    | 输入与硬约束                                                                                                                                                                    |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自由创作     | `creative_generate + image.generate@1` | 允许纯文本或 0-10 张已授权参考图；参考维度必须来自用户明确指令，不继承身份/像素保持语义                                                                                         |
| 人像焕新     | `raw_asset_generate + image.edit@1`    | 至少 1 张人物主图；固定 identity anchor、允许变化清单和禁止变化清单；模型必须支持所选规格与参考图数                                                                             |
| 照片意象重绘 | `raw_asset_generate + image.edit@1`    | 至少 1 张授权照片；参考图进入图片 Provider 但只作语义与视觉证据；固定结构化艺术指导并明确 `preserve_original_pixels=false`，成品必须全量重构                                    |
| 本会话继续改 | `chat_artifact_edit + image.edit@1`    | 三个 S13A primary 或 `commerce-white-background@1.0.0`；恰好一个当前 session 可修改的 primary source，可附加授权参考；固定改变项、保持项和 parent artifact publication revision |

四条映射是编译期 profile，不由 Skill 正文或 Brain 动态注册。primary、intent、capability、binding role、generation preferences、Brain 解析的图片张数或模型能力不匹配时返回安全切换/补素材动作，不静默换 Skill、换模型、降规格、减少张数或把 edit 改成 generate。内置 Skill 的内容随工程部署，修改后重启 API/Worker 即生效，不走 package/release/审批；外部 Skill 才携带 S11 的 package/release/definition/resource digest 与该 profile version 一并进入 plan/quote/task/artifact snapshot。

附件职责沿用 `06` 的公共 role，并为本任务冻结三个新增值：`identity_anchor` 表示人像焕新的唯一人物身份主图；`semantic_reference` 表示照片意象重绘的源照片，Brain 与图片 Provider 均可读取，但只能提取语义核心、关系、动作、空间、光色和材料证据，禁止保留摄影像素、描摹原构图或冒充身份保真；`edit_source` 表示本会话继续改的唯一直接父产物。自由创作只接受 `style_reference | composition_reference | other`，且每张参考图的用途必须由用户在附件区明确选择；切换 primary 后旧职责立即失效并要求重新确认。客户端不得提交 intent、capability、profile version、profile digest 或艺术指导对象。

同一会话的后续 turn 不要求用户重新上传图片。没有本轮显式附件时，Worker 必须在 Brain 调用前由服务端解析并冻结 `session_image_candidates`：最新一个已完成生成组中的已发布产物作为 `edit_source` 候选，沿 `source_artifact_id` 与 `artifact_input_bindings` 回溯得到的原始授权图片作为对应 primary 的源图候选，并携带稳定的组内序号、候选类别和 lineage 关系。该候选快照写入 turn 的 `context_snapshot`，Worker 接管或重试必须恢复同一快照；会话消息压缩不得替代、删除或重写它。候选图片不是用户本轮新附件，也不是默认 Provider 输入，客户端不得提交或篡改候选 ID、版本、顺序或 lineage。

若本会话尚无任何已发布产物（包括首次生成在 Brain 阶段失败），Worker 从同一用户、同一会话、当前 turn 之前最近的一条含适用源图职责的用户消息恢复原始图片候选；按该消息中的原顺序冻结至多 9 张，并逐张核验当前资产归属、可读状态、内容 hash 与版本。失效源图不得静默换成更早一组图片。此时候选只有 `original_source`，Brain 可以依据用户要求直接重新生成，不得虚构 `latest_output` 或 `source_decision`；下面要求 `source_decision` 的规则仅适用于候选池确实存在 `latest_output` 的情况。确认卡或旧 context snapshot 不得在新 turn 中被静默改写，历史消息压缩也不得替代图片授权检查。

Brain 是创作与选图决策者：它根据用户当前表达、会话历史、候选图片及 lineage 决定继续修改某张最新成图，还是回到其原始源图重新生成；多张成图时由 Brain 解析“第一张/第二张/右边”等指代并只选择目标图片。每个使用会话候选的 candidate 必须由 Brain 输出结构化 `source_decision`：`refine_latest` 选择一个最新成图作为直接父产物，`restart_original` 同时声明被否定或被重新定向的成图和与它存在 lineage 关系的原始源图。Brain 的判断依据不是关键词，而是完成用户当前要求所需的视觉证据是否仍存在于最新成图：颜色、留白、局部排版等仍可从当前像素完成的细调形成 `A2 -> A2-v2 -> A2-v3`；地点、人物、商品或构图辨识所需证据已被删除、扭曲或替换时，从对应源图建立新分支。安全 `reason_summary` 只记录来源选择结论和可观察依据，不记录 chain-of-thought。存在多个同等合理候选且用户表达不足以唯一确定时，Brain 只澄清一次。Runtime 只提供候选与工具能力，不用关键词、固定路由或前端状态替 Brain 决策；Compiler 只校验 `source_decision`、intent、选中 binding 子集及其 lineage、同会话修改权、精确版本、publication revision、模型能力、积分和并发，未选候选不得进入 Provider。

部分成功恢复补充（2026-09-27）：最近的同会话源图组与最新产物 lineage 相交时，候选池必须保留整组有效原图，包括尚无产物的失败输入；源图序号以原始消息顺序为准。更晚上传的源图组尚无产物时，不回退到更早成功组。只对没有任何候选产物后代的原图发起新的生成计划，是上述 `source_decision` 必填规则的例外；不能为了补生成失败图而虚构它与另一张成功图的 lineage。计划涉及已有成图或其关联原图时仍要求原有 `refine_latest/restart_original` 决策。所有查询限定当前用户且早于当前 turn，原图必须匹配持久化 binding 的 hash/version；源图组有失效项时不静默缩减为部分组。自动化覆盖部分成功、新组全失败、版本漂移、跨用户、未来消息及既有合法/非法来源选择。
长会话回源补充（2026-09-27）：即使较新 workflow 已有产物，最早一组仍有效的用户原图也须在 9 张源图候选上限内保留，供模型处理“用最早上传的原图”之类的明确请求。最新一组已发布成图最多保留 16 张，与原图分别编号和计数；最早组与最近组原图按时间顺序稳定编号并去重，最新成图只关联真实 lineage。最近目标组失效不能静默用最早组顶替；成图超过 16 张或去重后原图超过 9 张不能静默截断。无附件 turn 在自动候选超限时冻结空候选及明确的不可用标记：讨论不被阻断，生成/改图须请用户从已有资产库明确选取目标源图；该入口必须分页以覆盖中间上传组，不要求重传。当前 turn 有显式附件时按附件执行，不合并不可用历史池。自动化覆盖旧组 A/B/C、后续新组 D 与新产物并存时回指 A，以及 10–16 张成图、成图/原图各自超限和纯聊天的情况。

编译期 `skill_execution_profile` 为服务端常量闭包，最小结构固定为 `{ schema_version: 1, profile_id, profile_version, primary_skill_id, intent, capability, capability_version, allowed_binding_roles, provider_binding_roles, constraints, profile_digest }`。`profile_digest` 是除自身外完整对象的 canonical SHA-256；Compiler 必须重新解析并复算，随后把同一闭包写入 plan snapshots 与每个图片 task 的 `params_snapshot`，产物的 `params_snapshot` 继承相同 profile/version/digest。`allowed_binding_roles` 是 Brain 可读上下文，`provider_binding_roles` 才能进入图片 Provider：自由创作为空；照片意象重绘为 `semantic_reference`；人像焕新为 `identity_anchor` 加用户明确选择的风格/构图参考；继续改图为 `edit_source` 加用户明确选择的附加参考职责。Worker 只能从上述冻结闭包、结构化变化项、保持项、结构化艺术指导和商品事实构造图片 Provider 指令；不得只发送 Brain 的 `goal_summary`，也不得把硬约束或 Skill 方法论仅作审计记录。

照片意象重绘 candidate 只携带一条 source-specific 的最终 `creative_prompt`，以及用于审计和上下文压缩的简短 `semantic_summary`。Brain 在内部依据已加载的 Skill/reference 完成观察、证据取舍、叙事焦点、构图、色彩、材料、边缘和反向审查；这些是创作知识，不是 Provider 或 Compiler 的几十个必填字段。Brain 必须先形成至少三个在空间密度、视觉重量、正负形和观看路径上真正不同的内部缩略构图，再以源图特异性、命题可见度、意外但必然的转化、媒介适配和生成可执行性选出一个；不得把固定留白比例、固定色块面积、固定撕边或固定标题位置当成 Skill 默认。最终 Prompt 必须先锁定一种由源图证据选择的非摄影成像系统、明确抽象层级和一个源生结构转化，再给出最终选中的可见构图、形色、材料与删减。语义锚点只允许保留“是什么、彼此怎样作用以及为何重要”，不得把它们在原照片中的坐标、相对面积、透视深度、地平线、消失点和轮廓拓扑一起保留；若以上关系大体不变，即使全部像素已重画也属于 `photographic_substitute` 失败。选择透明水彩、油画、细腻插画等容易保留摄影空间的具象媒介时，Prompt 必须同时执行至少两类会改变最终轮廓与空间阅读的结构动作，例如压平透视、尺度颠倒、正负形反转、色域重写深度、空间断裂/重接或将实体转为运动/材料场；换滤镜、换光线、加强色彩、增加纸纹和普通裁切不计入。仅改变机位、景别、光线或重新排列真实建筑而仍可渲染成合理照片，属于 `photographic_reconstruction` 失败。Compiler 只校验最终 Prompt、源图职责、数量和权限，Worker 只把 Prompt 与已授权参考图交给图片 Provider，并为该 profile 添加稳定的“不得回落为另一张写实照片或原构图的绘画替身”执行约束，不替 Brain 选择具体媒介或构图。

Prompt 必须体现源图关系、一个中心张力、新空间骨架、明确的观看入口、结构性色彩/材料和全量重构，不得退化为滤镜、原构图复刻或无来源装饰；不得出现艺术家姓名或仿制具体作者的要求。Prompt 不使用固定五段模板，只按当前画面的视觉优先级编写一条紧凑指令；系统硬约束保持稳定，创作决定由 Brain 依据 Skill 与当前源图完成。Skill/Preset 负责方法和知识，不能绕过服务端对来源、数量、权限和 Provider 输入的硬约束。

通用 Brain adapter 只冻结 candidate schema、工具互斥、能力映射和“按已加载 Skill 编译最终 Prompt”等协议，不得平行硬编码某一 Skill 的命题竞选、构图、色彩、材料或边缘方法。创作方法的唯一版本化真相是选中 Skill 的 planning/reference 快照；Worker 只能追加不保留摄影像素等稳定执行硬约束，不能另选风格或覆盖 Skill 决策。

最小用户输入是授权照片加“重绘/做成有创意的作品”等短请求。Brain 必须自主完成叙事焦点、保留/舍弃、构图、色彩、材料与边缘决策；用户补充的创意想法作为更高优先级的表达约束吸收，但不得要求用户撰写长提示词、选择风格套餐或填写固定留白比例。只有权利/素材职责不确定，或两个同样有证据且会导致本质不同结果的解释存在时，才允许一次简短澄清。

S11 图片比例下拉提供 `智能比例 | 1:1 | 3:4 | 4:3 | 9:16 | 16:9`。用户选择固定比例时，该比例是本 turn 所有图片节点的硬约束，Brain 不得覆盖。用户选择“智能比例”时，Brain 在完成命题与缩略构图竞选后，从所选图片模型当前规格支持的比例中为每个 candidate 节点选择最能承载该构图的具体比例；多张源图的一图一节点可以采用不同画幅。比例判断服务于主体尺度、方向张力、正负形和观看路径，不按源图横竖方向机械复制。Compiler 对每个节点重验并冻结具体比例，图片 Provider 永远只接收具体 `W:H`，不接收 `auto`。

四个 profile 的固定约束如下：自由创作允许 0-10 个上下文参考且生成节点不得携带 binding；人像焕新恰好一个 `identity_anchor`、总参考数受模型规格约束，`changed_items` 必填且只能使用 `lighting | composition | background_cleanup | color_balance | detail_restoration` 规范值，命中 `identity | unconfirmed_age | unconfirmed_body_shape | ethnicity | unconfirmed_clothing | relationship | key_action | face_swap` 或任何未列入允许集合的值都必须在 Compiler 阶段拒绝；照片意象重绘接受 1-9 个由 Brain 选中的 `semantic_reference`，每张选中源图必须一一对应一个独立 `image.edit` candidate node，每个节点只绑定该源图、`output_count=1`，并携带 source-specific 的 `creative_prompt`，不得多图混合、漏掉已选源图或重复使用同一源图；继续改图恰好选择一个已发布 `edit_source`，固定其 `object_id/object_version/publication_revision`，改变项和保持项均为非空安全摘要，其他附加参考不得成为 parent。Compiler 不得要求 candidate 使用候选池中的全部 binding，只能对 candidate 明确选择的 binding 做闭包校验；候选池中未被选择的图片必须保持不可计费、不可投递。继续改图只对上述三个 S13A primary 与 `commerce-white-background@1.0.0` 开放，未知或尚未实现的 primary fail closed；白底精修继续改必须从父产物不可变 `params_snapshot` 继承并校验原 `product_facts_snapshot`，不能丢失、改用最新事实或要求用户重复确认。每个图片 candidate node 还必须填写 `output_count` 与 `output_count_source=user_explicit|skill_default`：用户明确说“两张/三张”等数量时 Brain 必须按原意解析；未明确时必须原样复制 Runtime 随精确 primary Skill 版本提供的权威 `default_output_count`，不得自行猜测。照片意象重绘的批量张数由 Brain 选中的源图节点数决定，每个 Provider 请求固定 `n=1`，总报价为全部节点之和。前端不得解析数量，候选计划不得超过 profile、模型规格或平台单 turn 上限。

人像焕新和照片意象重绘虽然都读取照片，但素材职责互斥：前者必须保留身份锚点，后者默认不保留原像素；用户切换 primary 时必须重新确认职责，不能沿用上一 Skill 的隐藏约束。继续改图只读取 S12 发布后的对象和 `artifact_input_bindings`，quarantined/blocked/deleted/其他会话产物统一在 Compiler 阶段拒绝。

## 执行与恢复

- 1A 创意 turn 只有直接执行路径，不存在低价/高价两套 UI。用户点击“生成”后，Brain 先输出包含最终图片张数的 strict candidate；Compiler 按 profile、模型规格和平台上限校验并生成 quote；Credit application 随后核对余额、并发、quote/authorization digest，并原子创建 reservation + workflow。只有 reservation 成功后才允许图片 Provider 投递。
- 前端不显示费用卡，不提供执行模式、图片数量控件或当次积分上限。Compiler 完成后可在运行进度展示预计积分，结算后在结果和积分流水展示实际积分。余额不足、价格未知、catalog/pricing 漂移、数量越界或并发已满时停在图片 Provider 之前并保留用户输入；不得改为费用卡、静默减少张数或更换模型。
- 每次继续改图创建新的 turn、quote、workflow、task 和 artifact，`source_artifact_id` 指向直接父产物，全部输入写 `artifact_input_bindings`；原图、父产物和历史价格不覆盖。电商父产物的已确认商品事实按其冻结版本向后继承，Provider 指令继续强制产品身份、颜色、Logo、可见文字和 `must_preserve`，不得仅依赖自然语言目标。
- 重复点击生成/继续改、Worker 接管和 SSE 恢复必须复用稳定 turn/operation/quote/task key；Provider accepted/outcome_unknown 不新建生成或编辑 attempt。页面刷新只恢复快照，不重新发 turn。
- 三个 primary 和继续改全部复用 S12 preflight、generation、post-moderation、publication、partial settlement 与人工复核。任何链路不得直接把 Provider output URL 或 quarantine 原图交给前端。
- 多输出 turn 若至少一张产物已发布，用户侧以 `turn.completed` 收口并在同一条 assistant 消息中附上已发布产物、明确说明未完成部分及退款；workflow 仍按真实 task 终态记录失败。只有零产物交付时才发 `turn.failed`，不得在已交付部分成果后再显示“创作助手不可用”。最终消息、实时槽位和后续会话候选必须使用同一稳定顺序：task 创建顺序、task ID、`output_index`，历史缺序号时才按 artifact 创建顺序降级。
- 对人物身份、关系、年龄/体型允许变化和参考图职责写结构化 snapshot/digest；日志、SSE 和普通 API 只返回安全摘要，不返回完整 prompt、私有 Skill 正文或人脸特征向量。

## 日志、指标与验收命令

- 指标按 `primary_skill_id + version + model catalog entry + capability profile version` 聚合成功、澄清、错配、内容拒绝、unknown、继续改完成率、成本和延迟；用户/会话/素材 ID 脱敏。
- 新增 `pnpm validate:creative-chat`，使用真实 PG/Redis/私有测试对象根与 fake provider 锁定三条 profile、自然语言张数、积分核对、R1-R5、lineage、结算和恢复；新增 `pnpm test:e2e:s13a-live` 在显式真实 Provider 成本门禁下验证三条真实浏览器成功链路和一条本会话改图。
- 建议测试归属：`packages/compiler/src/capabilities/image-*.spec.ts`、`apps/worker/test/s13a-creative.integration-spec.ts`、`apps/api/test/s13a-creative.e2e-spec.ts`、`apps/web/e2e-live/s13a-creative-live.spec.ts`。CI 不调用公网，真实输出和报告进入 Git 忽略目录并按 run ID 清理。

## 业务规则

- 创意任务不强制商品事实确认。自由创作接受纯文本和可选参考图，只提取用户明确授权的参考维度；当请求明显属于人物保真、保留原像素或其他专门 primary 时提示切换，不能用通用 Skill 降级执行。
- 人像焕新只允许在用户授权照片上改善光线、构图、现场感和表现质量；身份、年龄、体型、族裔、服装与关键动作的允许变化必须显式固定。它不开放换脸、未经确认的换装或从公众人物参考复刻身份。
- 照片意象重绘允许图片 Provider 读取授权源照片以获得源图特异性，但只把照片作为证据与创作起点；成品必须重新生成全部像素并重建空间骨架，不能同时沿用源图主体坐标、相对面积、透视深度、地平线/消失点和主要轮廓拓扑，也不能退化为滤镜、描边、近似临摹、写实复刻或原构图的绘画替身。具象媒介至少绑定两类结构重构动作；不能与 S13B 的“实景拼贴”在运行中自动切换素材职责。
- 引用商品图且要求电商用途时切换电商路径。
- 本会话产物可继续改，其他会话产物不可直接改。
- 内容安全拦截、产物隔离和发布规则与 S12 完全一致，不得为创意链路另建例外；不增加产品水印或 AI 标识。
- 生成后审核拒绝或 24 小时内未复核通过时，复用 S12 的释放 reservation 规则，不得结算未交付产物。

## 测试标准

- Playwright 覆盖创意生成和继续改图。
- 集成测试覆盖“生成两张/生成三张/未写数量使用 Skill 默认”的 Brain 输出、Compiler 张数校验、quote 金额和 Provider 实际调用数量一致；断言前端不解析数量且全链路不产生费用卡。
- R1-R5 拒绝提示必须测试。
- 集成测试覆盖文本拦截、图片审核隔离和发布对象一致性，并断言不增加产品水印或 AI 标识。
- 三个 primary 分别覆盖素材职责、身份/关系保真、主 Skill 不匹配提示和至少一组负向 golden eval；照片意象重绘必须覆盖参考图确实进入 Provider、艺术指导缺字段拒绝、多个张力堆叠拒绝、无来源象征拒绝、装饰性颜色/材质拒绝和像素保留漂移拒绝；人像焕新必须覆盖缺失变化项、禁改项和未知变化项拒绝；继续改图必须覆盖白底精修父产物事实继承以及未知 primary 拒绝。测试夹具不得使用公开参考仓库的图片、正文或示例。
- 照片意象重绘另覆盖 1 张和 9 张源图的一一对应编译、漏图、重复绑定、单节点混入多图拒绝，以及 9 个 Provider 请求均固定 `n=1`；单张失败只影响对应节点，不能吞掉其他已发布结果或重复结算。
- 三个 primary 分别建立至少一组真实 `source/request -> 决策摘要 -> quarantined result -> 审核后 result` 案例档案，记录 Skill/Preset、Brain、图片模型、prompt digest、输入授权、artifact lineage 与逐维评分。自由创作重点评命题与反模板，人像焕新重点评身份/关系与自然度，照片意象重绘重点评语义关系与新构图，并逐项对比源图与成图的主体坐标、相对面积、透视/地平线和主要轮廓拓扑；“像素已重画但空间骨架基本重合”不得判为通过。mock 图和仅有文本计划不得作为成图质量证据。
- 创意评测必须区分用户明确情绪、画面可观察证据和模型推测；固定色温、饱和度、天气或道具映射，或无事实依据的经历与象征，均作为失败而不是“拟人化”加分。
- 真并发覆盖重复生成/继续改只有一个 quote/run/Provider submit；生成中刷新、SSE 断线、Redis 丢失和 Worker 接管不增加收费动作。余额不足、价格未知、数量越界和 catalog 漂移均断言 Provider submit 为零。

## 验收清单

- [ ] 自由创作、人像焕新与照片意象重绘三个 primary 可用，且用户选择、素材职责与版本快照可审计。
- [ ] 本会话改图闭环可用。
- [ ] “生成两张/生成三张”等数量由 Brain 解析，Compiler 校验后先完成 quote、余额核对和 reservation，再调用图片 Provider；无数量控件、费用卡或当次积分上限设置。
- [ ] 不把跨会话/画布产物误放行。
- [ ] 创意结果可下载/存库。
- [ ] 三个 primary 各有真实浏览器成功证据、错误素材职责反例和可追溯 profile/Skill/model/pricing snapshot；fake 不作上线证据。
