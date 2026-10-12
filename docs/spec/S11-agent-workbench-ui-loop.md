# S11 1A Agent 工作台与首版 Skill 内容闭环

## 串行增量：首页真实静态案例（2026-10-12）

按用户要求将 A04 输入区下方占位商品图替换为已授权的真实生成结果，与根 README
共用去元数据的静态图集。没有新业务接口，不在 Web 查库，不公开来源产物/会话/用户
ID，不把图集声明为可修改产物。预览保持完整构图；仅在当前公开 catalog 存在匹配
Skill 时提供选择动作，以当前目录版本更新输入，不触发生成并保留用户附件。
沿用浅色设计、四张一批与桌面四列/移动两列，补图片失败、空图集、键盘/焦点和换批
回归；用户验收前不提交。公开图集筛选只读维护者测试账户，原私有产物状态不变。

## 串行增量：图片清晰度标准档（2026-10-09）

用户确认图片仅使用 1K/2K/4K，接口值为 `1k|2k|4k`，不再接受 3K。同步 Composer、API、Brain、Compiler、Worker、Provider 和管理台积分配置，不改视频规格。4K 的积分由管理员显式保存，不从旧 3K 价格推导。已发布快照不可原地改写；管理台保存新积分时，如内置模型规格发生变化，仅在相同模型、通道、凭据及完全一致的 1K 生图/改图基线证据下创建新模型快照和新目录版本，原历史快照保留。

正面复审：端到端统一三档，消除页面能选而宿主拒绝的差异。反面复审：不能用旧 3K 价格代替 4K，不能伪造 4K PoC，也不能把 Provider 不支持的尺寸静默降为低档。高档位可以沿用同操作的 1K 基线准入证据，实际请求仍按当前模型规格、尺寸限制、回执及输出验证 fail closed。回归覆盖 4K 选择与提交、3K 拒绝、规格更新/幂等/并发、尺寸映射及同操作基线证据；不自动执行付费探针。

尺寸计算按 `03` 的总像素预算通用公式执行，不能把 4K 当作固定短边 4096；当前公开五种比例的三个档位必须匹配用户提供的尺寸表。前端仍只提交档位和比例，不计算像素、不增加特殊比例；实际 `size`、准入限制与按像素计价由 Provider/Compiler 共用计算结果。

2026-10-08 复审修复验收：Web 失败事件与快照使用 shared 公开契约；低高度设计师菜单保持碰撞边距与滚动隔离，风格/模型菜单支持指针打开后键盘选择并把焦点归还触发器。账户选择草稿必须按用户和会话隔离，鉴权完成前不读取账户缓存；访客登录仅迁移当前访客草稿，不加载上一账户的缓存。覆盖跨用户、跨会话、鉴权延迟与无效缓存，不引入历史 Skill 兼容。

## 串行增量：主页 Skill 入口一致性（2026-10-08）

沿用已交付目录、manifest 可见性与 A04 输入区，不新增接口或 Skill 名单。“实景拼贴·写意纸境”暂时隐藏；主页快捷入口不再只显示前八项，与下拉共享公开 catalog 的全部条目及顺序。沿用紧凑换行布局和单一选择状态。回归覆盖超过八项、空目录、目录隐藏后的重载和双向选择同步，验证桌面/移动布局与服务重启后的真实公开目录，不调用付费 Provider、不提交。

长列表下拉补充：保留 Radix 自动翻转方向，按实际可用高度限制菜单并启用内部滚动，屏幕四周保留边距；相同容器的 Skill、风格、模型及参数菜单一致处理，不删减目录、不强制向下、不改变选择和锁定规则。浏览器回归使用九项 Skill、长风格/模型列表，覆盖低高度桌面与移动窗口、首末项鼠标选择、Home/End 键盘导航及菜单边界截图，避免只有单项目录的 fixture 掩盖越界。

自由创作增量：直接上游为 `02` 渐进加载与 `07` 自由创作入口。移除该 primary 的风格 Preset 及专属资源，通用 auxiliary 改为 optional；只预载其自身 L1。内容以用户指令/完整提示词为准，设计师只补未决定的表达。正面复审：去掉双重风格选择与预载改写约束，保留纯文字生成。反面复审：不能绕过主 Skill 身份、编译、权限或费用边界，不能为了“自由”在执行层按 slug 分叉。验证公开目录/服务端无 Preset 选择、前端发送 payload、实际 Worker 首轮加载与逐图 authoring、无图编译及桌面/移动状态；付费 Provider 出图效果由用户验收。

## 串行增量：声明式执行类型（2026-10-08）

开工前必读 `02` 数据驱动 Skill 边界、`06` 目录元数据及 S08/S09/S12/S13A/S13B 既有执行契约；依赖已交付。先完成正反复审，再迁移当前内置 primary 的 manifest、selection、Brain、Compiler、Worker 与附件选项。仅六类通用执行语义；艺术知识只读 Skill，宿主保留资金/身份/事实/授权/回执门。按用户决定不实现历史兼容，实测新建会话；不改数据库表、不重写或删除历史。

交付 policy 校验、陌生 slug 回归、当前与历史 prompt 分流、目录隐藏/附件角色一致性、相关包测试、全仓 lint/typecheck/build、桌面/移动 mock 截图及 PG/Redis 失败恢复回归。诊断沿用 profile/version/digest 与 turn/run/task ID，不记录完整 prompt。API/唯一 Worker 重启并确认 ready 后由用户实测艺术效果；工程回归不能声称审美已通过，不提前提交。

启动内容门禁同样不维护 slug 或专属艺术规则：与运行时共享内容包发现，按 manifest 校验资源、依赖、执行类型和 golden dataset。补陌生目录/Skill、仅改正文、重复身份、缺失评测及非法依赖回归，保持外部包严格摘要校验；现有艺术评测数据不删除。

## 串行增量：会话设计师锁定（2026-10-08）

直接上游为 `02` 锁定/自动 v3、`05` 会话快照、`06` 字段与冲突、`07` A04。依赖沿用已交付 S08/S09/S11。正面复审：会话存储解决刷新/重启和跨 turn 飘移，规划中的单枚举不增加调用。反面复审：仅禁用 UI 不足；聊天时提前选人、题材硬路由、覆写历史、缓存优先、把策略 v2 原地升级、失败规划解析、并发二次换人均拒绝。按上游修订后通过方案复审再实现，不改 Skill/交易/Provider 重投规则。

交付前后端锁定、自动原子解析与重放、向前迁移、旧会话恢复和诊断；验证相关单测、API/Worker 真实数据库失败及并发、全仓 lint/typecheck、空库迁移和桌面/移动 mock 截图。不调用付费模型；工程验证不代替艺术效果验收，用户验收前不提交。

## 串行增量：通用设计师方法 v2（2026-10-07）

直接上游为 `02` 方法层、`05` 不可变偏好快照、`06` 版本联合与 `07` 会话恢复。正面审查：在既有规划/逐图 authoring 中把方法转为有来源的视觉主张，可减少只有画法不同而构思相同的退化。反面审查：强制新奇会破坏忠实改图和商品事实，固定动作/题材/版式会产生新模板，同版本覆盖会破坏复现，多角色调用或自动重生图会增加成本。因此保留 v1，新增六种方法及自动策略 v2；仅开放创作比较不同解释，限定编辑保持请求范围。原生模式、工具结构、调用次数、费用、权限、队列与所有 Skill 内容不变。

交付与验收：共享 strict parser 接受 `1 | 2` 并拒绝未知版本/注入字段；菜单/新草稿默认 v2，历史快照不升级；规划、逐节点 authoring 和修复动态上下文保留精确版本，不改稳定工具集合。回归覆盖 v1 正文摘要、六个 v2 方法差异、自动摘要、原生不注入、版本 hash 区分、API 校验、会话/草稿恢复、菜单重选以及真实请求构造的 authoring/修复注入。运行相关单测、全仓 lint/typecheck 和桌面/移动 mock 浏览器检查；不调用付费 Provider，不把字符串测试称为审美通过。重启 API/Worker 后等待用户用相同 Skill/源图/模型实测，不提交。

## 串行增量：推理失败解释（2026-10-07）

直接上游为 `03` 脱敏诊断、`06` 固定公开摘要与 `07` A04 失败状态清单。正反复审：解释已知故障可减少误解；未经证明的超时猜测、原始异常透传、泛化 400 为容量问题、自动重投未知请求均不采用。只增补受控诊断和现有错误文本，不增加公共字段、交易权限、请求次数或页面布局。交付分类单测、Provider 流失败脱敏测试、真实数据库 unknown 不重投/exposure/事件测试及 Web SSE/快照/组件恢复测试；执行相关测试、lint/typecheck 和桌面/移动 mock 审查，用户验收前不提交。

## 串行增量：通用设计师选择（2026-10-04）

直接上游为 `02` 通用创作方向层、`05` 偏好快照、`06` strict API 联合与 `07` A04 状态清单。复用已交付 S08/S09/S11 的模型、工具、编译和恢复链路，不扩展交易权限。正反复审结论：可选方法层有价值；前端装饰、六个 Agent、题材路由、固定配色/动作和混合六份全文均不采用。

交付：六个版本化档案、自动/原生模式、会话隔离菜单、偏好 hash 冻结、规划与逐节点 authoring 动态注入、旧请求兼容、非法版本拒绝、诊断摘要和恢复测试。自动保存策略版本，不声称已持久化实际档案；不新增模型调用。验收执行相关单测、全仓 lint/typecheck、桌面/移动 Playwright 与截图审查；用户以同 Skill/模型/照片分别测试原生和不同设计师的实际效果。通过工程检查后等待用户艺术效果验收，不提前提交。

| 项     | 内容                                                                                        |
| ------ | ------------------------------------------------------------------------------------------- |
| 状态   | v1.0 生图运行反馈修订：Brain 解析张数、无费用卡、紧凑进度与稳定占位                         |
| 阶段   | 1A / D4-D5                                                                                  |
| 优先级 | P0                                                                                          |
| 依赖   | S01-S10、S14A 已验收                                                                        |
| 目标   | 实现 1A 主入口对话 Agent 工作台、正式 Skill 内容包，以及 API/SSE/模型快照与任务状态完整联动 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` §2.4
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/03-provider-poc-and-cost-model.md`
- `docs/04-state-machine-and-exception-matrix.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/07-1a-user-flow-and-ui.md`
- `docs/spec/S08-agent-turn-skill-runtime-and-loop-guard.md`
- `docs/spec/S09-deterministic-compiler-r1-r5-and-plan-validation.md`
- `docs/spec/S10-product-sku-facts-assets-and-artifacts.md`
- `docs/spec/S07-provider-gateway-poc-and-cost.md` §11
- `docs/spec/S14-user-center-and-minimal-admin-console.md` §5-6
- `docs/design/01-full-site-screen-flow-spec.md`
- `docs/design/03-v0-full-site-ui-interaction-prompt.md`
- `docs/spec/00-master-development-plan.md` §8
- 本地 `imgage/` 参考图（仅参考、不提交）

## UI 设计前置门禁

正式 UI 代码必须在以下步骤完成并通过产品评审后开始：

1. 核对本项目页面规格、交互状态和本地 `imgage/` 的设计证据；正式 UI 以已评审设计为准，1A 保持对话创作入口。
2. 第一组 A01-A10 共 10 个普通用户页面族、9 个 overlay 族及全局状态矩阵完成评审；独立管理台不作为 A11 混入普通站。
3. 使用 Stitch MCP 建立统一设计系统，并产出 A04 Agent 工作台桌面/移动主流程、异常和刷新恢复设计。
4. 设计稿标注页面族 ID、路由、组件状态及 API/SSE 映射；产品评审冻结后才开始编码。

Stitch 不可用或设计未冻结时，S11 保持阻塞。`imgage/`、`.playwright-cli/` 和 Stitch 临时导出不得进入 Git。

本轮复核确认已有 `docs/design/stitch-design-system.md`、`docs/design/00-stitch-full-site-ui-design-plan.md`、A04 桌面/移动与状态 prompts，以及按该基线实现的工作台原型。S11 不重新设计页面、不增加页面族或把 1A 改成画布；本次复审只确认冻结基线继续有效，并审查 mock 切换真实 API 后的状态变化。

## 当前模块范围

包含 A04：新会话/历史会话、会话列表、对话流、输入区、当前输入附件、`@`、`/` Skill、Agent 可见步骤、澄清/事实确认、任务/产物面板、结果预览、同会话继续改、SSE/刷新恢复。1A 工作台不显示费用卡、执行模式开关或当次积分上限设置。

同时包含 1A 正式 Skill 内容包。S11 必须交付创作目标明确、方法完整、可移植、可安装、可校验且可版本化的正文，不能只交 runtime、空 catalog 或测试 fixture。当前内置内容包含以下 13 个 primary，其中叙事电影海报、人像焕新、商品白底精修和实景拼贴·写意纸境暂不公开，其余 9 个供目录选择；实际目录可见性以 manifest 为准：

1. `creative-free-generation@1.0.1`（自由创作，承接纯文本或可选参考图的通用从零生图）
2. `creative-portrait-renewal@1.0.0`（人像焕新，2026-10-07 起隐藏）
3. `creative-scene-collage@1.4.2`（实景拼贴）
4. `creative-scene-reimagining@1.3.1`（照片意象重绘）
5. `xieyi-scene-collage@1.0.0`（实景拼贴·写意纸境，暂不公开）
6. `minimal-scene-collage@4.3.1`（极简拼贴）
7. `daily-memory-page@1.1.0`（实景转译·日常记忆页）
8. `cinematic-story-poster@1.1.0`（叙事电影海报，2026-10-07 起隐藏，暂不继续开发使用）
9. `social-contrast-poster@1.1.0`（日常反差海报）
10. `commerce-white-background@1.0.0`（商品白底精修，暂不公开）
11. `void-line-poster@1.2.0`（虚空线稿）
12. `second-world-photo-remix@1.0.4`（实景延伸线稿）
13. `watercolor-scene-collage@1.0.1`（实景拼贴-水彩）

2026-10-08 虚空线稿按用户新版「实验艺术书籍 · 极简版画海报」更新为 1.2.0：保留 3:4、上下等分、独立照片与真实摄影；允许自然环境延伸和细微摄影分级。下半区以主题/轮廓/姿态/叙事关系形成一个锚点、动作与庞大空间关系，主运动可下降、上升、定向流动、扩散或不规则回声，核心密集、边缘稀疏消失。照片鲜艳辨识主色、纸色与黑形成 2–3 色版画，极短英文标题搭配 2–4 个微文本，允许旋转、轨迹对齐与嵌入粒子场；不再默认限制两行或禁止所有版面序号。实际成图才作质量检查，保持用户无文字/指定文本优先。不改变宿主工具、权限、编译或收费规则；内容校验、golden eval 与 API/Worker 重启后等待用户实测。

水彩 primary 保留用户提供的上下对照式淡彩速写方法：默认 3:4 竖版、摄影与水彩纸各占一半，原图不插画化，下半区小景约占其可见面积的 30%–45%，居中略偏下并保留大量留白。颜色、辨识元素和空间关系从每张照片提炼，不把示例风景物件写成必备内容；默认无文字，只有用户提供的地点、日期或短句可克制加入。内容需通过本地打包、golden dataset、原图绑定与 Provider 提示词交接测试，重启 API/Worker 后目录自动出现；没有真实出图前不得宣称视觉效果已通过。

2026-10-07 水彩内容质量修订：保留上述创作核心，区分视觉重点、解释身份/动作/支撑/尺度/空间所必需的环境与可省略信息。保留被选择元素的关键关系，不要求完整重建近中远景；纸白进入小画内部，不只围在四周。30%–45% 是构图尺度参考，不是必须涂满的面积指标；识别重点不随背景一起平均淡化。背景太完整时先删减无作用的环境和连续铺色，不用整体缩小代替内容取舍。增加非人物场景、必要环境保留、内部留白与局部修改的 golden case；内容校验和版本/hash 恢复测试不替代真实成图验收。

本节所说的“当前 Skill schema”仅指宿主 package manifest/profile 和内部编译结果，不是要求作者把平台字段或候选计划写入 `SKILL.md`。`SKILL.md` 应保持 Codex 兼容的 `name/description` frontmatter 与可直接复制的通用创作知识；宿主能力、输入、张数、Preset、依赖和权限由 manifest 与平台契约负责。

`creative-free-generation` 是第一方通用任务知识，不伪装成风格 Skill，也不替代九个素材职责更严格的专门 primary；当用户目标明显属于专门 Skill 时只提示切换，不静默换 Skill。九个专门创意 primary 可以依据权利明确的用户材料组织创作方法与量化执行规则，但正文不携带无关的作者署名、账号、推广链接、品牌背书或未授权资产；真实来源和必要版权声明保留在审计元数据与许可证记录中。内容须遵守产品文字策略、权限边界并通过 eval。白底精修和共享电商知识按商品事实、素材职责和类目风险组织；宿主 schema 与权限契约单独维护，不把画布、Planner 或执行授权语义写入通用 Skill 正文。

首版还必须交付 7 个热门类目 auxiliary：服饰鞋包、美妆个护、食品饮料、家居生活、宠物用品、运动户外、数码配件；并交付真人商品摄影、共享电商视觉、素材角色、身份与关系保真、原创隔离、视觉重量/视线关系、跨图叙事差异等 required/optional auxiliary 及其一跳 L2 自检 reference。热门类目只作为 `internal auxiliary`，由 Agent 在用户所选电商 primary 的精确一跳 allowlist 内按事实动态加载，不出现在前端主 Skill 选择器中。

同时包含 A04 正式 UI 必需但 S08 未交付的窄后端激活面：会话列表/详情/重命名/归档 API，turn 的产品模型选择与生成偏好不可变快照，以及已选 Brain snapshot 注入现有 `AgentBrainPort`。这些接口只服务 A04，不扩展新的业务状态或第二套 Agent runtime。

S11 同时负责首个真实 Agent Brain 激活，不能把这项留给 S15 临时补齐：

- 至少交付一个编译期注册的精确 Brain adapter，只消费 S14A 已审批的 channel/credential/model snapshot；首期只允许 `openai`/`anthropic` 协议族及 `openai_chat_completions`/`openai_responses`/`anthropic_messages` 变体。禁止任意 URL、客户端 Key、按名称临时换模或通用 header 注入。
- S14A 管理员可以为 channel 配置服务端 relay-origin allowlist 内的 HTTPS Base URL，并按该 channel 创建多个精确模型快照；管理台不提供任意 header/request JSON 输入。图片/编辑使用 `openai_images`，视频在对应阶段门禁前不得进入可执行收费路由。
- turn 的 Brain 执行快照除模型/能力/价格/配额外，还必须固定 `provider_channel_id + provider_channel_revision + adapter_key + endpoint_profile_key + region + protocol_family + api_variant + credential_version_id`。Worker 只按该绑定读取当时的 active credential；通道 Base URL 属于不可变 channel 配置，默认项或凭据轮换后不得追随新 Key，旧绑定不可用时在网络调用前 fail closed。
- `pnpm poc:agent-brain` 在显式真实成本门禁下以固定五次调用覆盖 strict tool/terminal、澄清、候选计划、optional auxiliary、命中条件后的 primary L2 Reference 加载、可信 usage 与 actual cost；报告写 Git 忽略目录并经人工审批。超时/连接复位后的 unknown、exposure 保留、不支持模型网络前 fail closed 和无静默换模必须由同一 adapter/router 的可控自动化反例证明，并与真实 PoC 报告一起作为验收证据；禁止在公网 PoC 中人为制造不可控故障后把未确认成本记为零。
- 真实 Brain 返回的 tool/candidate 仍经过 S08 ToolPolicy 和 S09 Compiler；Provider 已可能收到请求但结果未知时保留 exposure，不自动换 Brain 或伪装为 0 成本。
- local/test 自动化可使用 deterministic fake；beta/production 只有真实 Brain PoC、凭据、预算、catalog 和 S15 上线门禁同时通过才可激活。

不包含：画布编辑器、套图表单、模板市场、公开分享、做同款、会员购买、完整商品/任务/账户页面。只有对应阶段 feature 已激活时，工作台才显示前往已有页面族的入口；S15 前不得显示空路由、“即将开放”按钮或不可完成的跳转。S12/S13A/S13B 仍负责图片 Provider 投递、内容安全、artifact 发布、结算和真实创意/电商生成；S11 不用假结果冒充生图完成。自动化与 local/test 可继续使用 deterministic fake Brain，但必须同样经过用户所选 catalog entry 的服务端重校验和 turn snapshot；fake 不作为真实体验或上线证据。S11 可在 local/test 安装、审批和发布 1A 内容用于工作台闭环；staging/beta/production 只有在对应 Tool、模型规格、安全和费用能力完成后才允许加入 active release。白底精修由 S12 激活，10 个创意 primary 由 S13A/S13B 激活，以上 11 个 primary 和 7 个热门类目 auxiliary 全部进入 S15 上线门禁。平台主图套图、Amazon 合规套图和详情信息图仍由 S22/S23 交付确定性套图、排版和平台规则能力，不能在首版只靠 Skill 正文冒充支持。

## 交付面

| 交付面         | 要求                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| 前端/UI        | A04 页面族、全局工作台壳、桌面/移动布局和 1A 状态组件                                                         |
| 后端/API       | 复用 S03/S06/S08/S09/S10/S14A，并补齐 A04 必需的 session API、模型与生成偏好快照；Next.js 不发明业务状态      |
| Brain/Provider | 首个编译期注册的真实 Brain adapter、受控 PoC、usage/成本/三态接线；fake 只用于 local/test                     |
| SSE            | turn、tool、workflow、task、artifact 增量；快照恢复和 watchdog                                                |
| Skill 内容     | 11 个 1A primary、热门类目与通用 auxiliary、Preset/L2、来源权利记录、正反例和 golden eval；可复现 `.skillpkg` |
| 测试           | Testing Library 组件测试 + Playwright 主/反流程                                                               |

### 首版 Skill 内容门禁

2026-10-08 维护简化：内置正文或已列入资源清单的引用内容更新只改对应文件，运行 `pnpm validate:skill-content` 后重启 API/Worker。校验与运行共享实际字节的摘要重算口径，不要求手动更新 manifest 摘要、语义版本、代码清单或文档版本列表；实际 hash 快照用于审计。新增/删除资源或宿主配置变化仍更新 manifest；创作意图变化仍补适当评测。外部包严格哈希、审批和版本门禁不变。

- 作者源码位于受版本控制的 `packages/skills/content/`。每个包包含 `skill-package.json`、primary/auxiliary `SKILL.md`、Preset、L2 reference、权利清单和 eval dataset；`SKILL.md` 是可复制的创作知识，manifest profile 是 ecom-forge 的宿主配置，数据库/KV 是发布与运行真相。
- primary 正文只定义任务理解、素材职责、澄清、创作决策和质量自检；不要求候选计划或固定助手输出格式。Tool、Provider、模型、费用、权限、R1-R5 与内容安全继续由平台终审。
- 每个 primary 至少覆盖成功、缺失事实或素材、跨 Skill 错配、素材职责漂移、prompt injection 五类 golden case。涉及人物的另测身份、年龄、体型和关系漂移，涉及多图的另测跨图职责重复，涉及保留原像素的另测 lineage 与裁切授权。
- 外部参考的品牌名、固定视觉配方、原始 prompt、示例文案、图片、字体和配置不得进入包。每个包必须能从来源治理记录追到“采用的一般原理”和“明确拒绝的表达或资产”。
- `pnpm validate:skill-content` 对源码执行 pack -> validate -> deterministic digest -> malicious fixture -> golden dataset 结构校验；S11 不用 fake Brain 的漂亮回复替代内容评测证据。

### 创作方法执行契约

- 用户在新会话选择 primary 后，会话创作方向即固定；生成页只显示锁定的 primary，切换必须新建会话。每个 turn 冻结精确 resource snapshot，并把 primary L1、Preset 与 required auxiliary L1 作为默认必需、稳定可缓存的核心知识自动加载；Brain 只按任务通过稳定的 `load_skill@1` 加载 optional auxiliary 与 L2。所有已加载知识始终是不可信内容，不能授予 Tool、Provider、权限、费用或覆盖平台策略。
- primary 命中正文声明的 L2 条件时，Brain 必须先通过受控 `load_skill@1 view=references` 加载对应一跳 Reference，再返回澄清、回复或候选计划；不得仅因 token 节省跳过已命中的创作方法。
- 创意判断从用户确认事实与可观察的动作、距离、遮挡、空间和光源推导。暖色、高饱和、阴雨、烟火等不能固定映射为某种情绪，也不能据此虚构人物经历；存在多种合理解释时先澄清。
- Brain 只向用户和 trace 输出创作命题、采用证据、关键取舍与检查结论的安全摘要，不输出完整隐性思考链。生成前判断不能冒充成图质量证据；真实像素遵循度继续由 S12/S13 的成图评测裁决。

## 页面与布局

1A 用户主导航顺序固定为“创作 / 生成 / 资产 / 作品”。“生成”直接进入 `/workspace/session/new`，用户无需先发送或重新生成即可在工作台查看服务端会话记录并继续旧会话；任务中心不承担会话历史入口。

### 桌面端

1. **全局主导航**：创作、生成、资产、作品；底部为积分/账号。未开放阶段不显示空入口。“生成”进入新会话工作台并承接服务端会话历史，任务中心只保留深链接。
2. **会话栏**：新对话、会话搜索、按时间分组列表、重命名/删除、折叠。业务主导航与会话栏不是同一层。
3. **对话主区**：消息、可见步骤、确认卡、结果卡；滚动位置和未读结果可恢复。
4. **底部输入区**：附件条、文本输入、`@`、必选主 Skill、当前 Skill 的 Preset、Brain/图片模型、比例、1K/2K/4K 分辨率、数量、发送/停止。输入区固定但不得遮挡最后一条消息；首页不放固定商品/SKU 选择器。1A 只有已激活的生图能力，不展示尚未开放的视频 Agent。
5. **右侧面板**：任务/产物两个 Tab，可折叠；默认 Tab 由 Stitch 评审决定，不改变数据语义。

### 移动端

- 单列对话为主；全局导航和会话列表使用独立抽屉，不能同时覆盖主区。
- 任务/产物面板改为底部抽屉；费用/事实卡在对话流内全宽展示。
- 输入区适配键盘、安全区和多行文本；附件横向滚动，发送按钮尺寸稳定。
- 大图预览全屏，关闭后回到原消息位置；刷新/返回不重复 turn。

## 输入区交互契约

### 模型选择恢复与隔离

- 新会话和各历史会话使用独立的输入偏好缓存，缓存不保存消息、图片、附件引用或授权事实。浏览器缓存仅是选择草稿，服务端的 catalog 校验及 turn 不可变快照仍为执行真相。
- 无本地模型草稿时，从当前会话最近一轮恢复产品 entry/version，不能按显示名猜测或继承其他会话选择；entry 删除、不可用或版本不匹配时阻止默认回填，要求显式重选。
- 切换路由与异步加载存在竞态时，旧会话状态不得写入新会话缓存，也不得用于提交。只在进入当前会话时恢复一次，后续刷新、分页和 SSE 不得重置手动选择。
- 回归覆盖两个历史会话、新会话、刷新、未发送的手动选择、模型失效和加载失败；验证提交 payload 与当前会话选择一致，并覆盖桌面/移动。

### 附件

- 1A 只支持上传已验证图片和从图片资产库显式选择，最多 10 个，以 API 限制为最终兜底；视频附件必须等 S16 的资产处理、审核和模型能力契约激活后再显示。
- 每个附件显示缩略图、类型/角色、上传状态、预览、移除和失败重试。
- 上传完成前禁止发送收费动作；已成功附件在其他文件失败时不得重传。
- 会话历史中的旧产物不会自动进入新 turn。用户点击“继续改”或“加入本次输入”后，才成为当前附件。
- 无权限、已删除、隔离或处理中的附件在发送前阻断并给出具体恢复动作。

### `@` 引用

- `@` 只列**当前输入区附件**，不是全会话、全资产库或全站搜索。
- 从资产库选择素材必须先通过“添加附件”；加入后才进入 `@` 候选。
- 持久化绑定 attachment/artifact ID；“图片 1”等序号仅显示，附件排序后引用对象不变。
- 移除被引用附件后，输入中对应 mention 显示失效并阻止发送，不由 Agent 猜测替代对象。

### Skill 与执行

- 自然语言是指令路径，但主 Skill 是发送前必选上下文。输入 `/`、点击 Skill 触发器和首页快捷入口都打开/更新同一个服务端 catalog 驱动的选择状态；快捷入口等同于用户明确选择对应 primary，不只是填模板文案。
- 未选择 primary、必选 Preset 缺失、catalog 中选择已停用/漂移、附件未就绪或引用失效时发送按钮禁用。服务端返回 `SKILL_SELECTION_REQUIRED/INVALID` 时保留草稿并刷新 catalog，要求用户重新选择，不能自动换成其他 Skill。
- 新会话 Composer 允许选择 primary/Preset；首个 turn 创建后，session 页面从服务端 `primary_skill_slug + preset_selections` 恢复并锁定当前 catalog 中同逻辑身份的最新版本，Skill 与 Preset 控件不可切换并提示“新建会话后可切换”。每次创建 turn 仍显式发送完整 `skill_selection` 供服务端重验与快照，不能依赖浏览器记忆。运行中的 turn 始终显示其创建时精确快照；内置 Skill/Preset 升版后，同会话新 turn使用当前 catalog 的同逻辑身份版本。
- 风格 1/2/3 等只作为当前 primary 定义的 Preset slot 展示；选择器显示预览 swatch/缩略图、名称和简短适用说明，不显示 auxiliary、Provider、模型、Key、内部 capability 或价格真相。
- 1A 生图参数可显示比例和清晰度，不提供图片数量控件。用户通过自然语言表达数量，例如“帮我生成两张图”或“生成三张”；前端不得用正则、关键词或本地规则解析数量，也不得先写入一个默认数量冒充用户选择。Brain 必须在 candidate plan 中输出最终 `output_count` 及 `output_count_source=user_explicit|skill_default`；用户明确数量优先，未明确时使用 primary Skill 的服务端默认值。Compiler 再按图片模型能力、Skill 规则和平台单 turn 上限校验，超限时在 Provider 调用和资金预留前阻断，不得静默减少张数。
- 创作端提供推理/图片的产品化模型选择器，数据只来自 S14A active model/pricing catalog；显示用户名称、能力/质量速度、支持规格和积分，不显示 Provider、内部 model ID、Key、endpoint 或真实成本。primary Skill 与模型选择相互独立且均为服务端校验上下文；服务端仍负责准入、预算、启停和可用路由裁决，不得静默替换用户选择。S16 前 video catalog 为空，界面不展示视频选择器。
- “直接执行”表示点击生成后由 Brain 解析任务，再经过确定性编译、积分核对和预留后执行，不表示跳过权限、内容安全或交易校验。
- 不显示“规划中等待确认”“计划确认”或费用确认卡。Agent 可以在内部形成 plan；用户只处理必要澄清、商品事实和风险确认。

### 生成动作与积分核对

- 发送区只有一个主动作：普通对话为“发送”，会产生图片任务时为“生成”，本会话改图为“继续改并生成”。不提供“始终确认费用/自动执行”二选一，不要求用户设置当次积分上限。
- 点击生成创建的幂等 turn request 是本次动作证据。服务端按该 turn 固定的 Skill、模型 catalog/pricing snapshot、Brain 解析后的 `output_count` 和图片规格生成 quote；Credit application 必须在任何图片 Provider 调用前核对余额、并发与 quote 完整性，并原子创建 reservation + workflow。只有 reservation 成功后才允许投递图片工具。
- 模型选择器可以展示公开的计价单位，运行进度在 Compiler 完成后展示本次预计积分，结果与积分流水展示实际结算；前端不计算最终张数或最终费用，也不把内部成本、Provider 或 SKU 暴露给用户。
- 余额不足、并发已满、价格未知、pricing/catalog 漂移或张数越界时不生成费用卡：保留正文、附件、Skill 和模型选择，在输入区或任务状态中给出可执行提示。价格/catalog 漂移必须刷新后由用户重新点击生成；系统不得静默换模、换价、降规格、减少张数或调用 Provider。

## 对话流组件

| 组件       | 内容                                                | 主要动作                                           |
| ---------- | --------------------------------------------------- | -------------------------------------------------- |
| 用户消息   | 文本、附件、Skill/目标摘要、发送状态                | 重试仅用于未创建持久化 turn 的网络失败             |
| Agent 文本 | 澄清、结果说明、失败/边界话术                       | 复制、反馈；不展示思维链或完整 prompt              |
| 可见步骤   | 正在读取上下文/加载知识/准备方案/安全检查等用户语言 | 默认只显示当前一行，右侧箭头展开已完成步骤         |
| 生成占位   | 按本轮目标比例预留的图片生成中骨架                  | 仅随权威 workflow 状态出现，成图原位替换且不跳动   |
| 澄清卡     | 仅缺失且阻塞的字段                                  | 提交后生成新 turn 输入，不收费                     |
| 商品事实卡 | 商品、SKU、身份、颜色/Logo/文字等本任务所需事实     | 修正、确认；保存不可覆盖事实版本                   |
| 结果卡     | 缩略图组、风险状态、版本/来源、成本摘要             | 预览、继续改、下载、存资产；S24 后电商产物可送画布 |
| 边界卡     | R1-R5、余额不足、内容拒绝、隔离、结果未知           | 积分/任务详情/申诉；S24 激活后才可跳转画布         |

## 核心流程

### 创意直执行

`描述/参考图 -> 点击生成 -> Brain 解析张数/工具参数 -> 必要澄清 -> Compiler 报价 -> Credit 核对并预留 -> 可见步骤 -> 结果 -> 继续改/下载/存库`。全程不插费用卡；积分或能力校验不通过时停在图片 Provider 调用前。

### 电商从零生成

`商品图 + 描述 -> 选择或快速创建商品 -> 解析摘要 -> 商品事实卡 -> Compiler 报价 -> Credit 核对并预留 -> 任务 -> 风险提示 -> 结果`。这里“从零”只表示用户不必预先建立商品档案，可在对话中快速创建；白底精修仍必须提供用户有权使用的商品原图并确认商品事实，不能从纯文本臆造真实商品。解析摘要可编辑，但不是“计划确认”；确认事实后直接进入确定性报价和积分核对，不再增加费用卡。

### 本会话继续改图

点击结果“继续改”后，该产物加入当前输入附件、输入框聚焦，用户填写改变项/保持项并点击“继续改并生成”。Brain 解析本次张数和编辑参数，随后重新报价并在 Provider 调用前完成积分核对。新结果保留 parent artifact，原结果不覆盖。画布/套图既有产物在收费前被 R1-R5 拦截；S24 激活前只解释边界并引导回原入口，不显示不可用画布卡，S24 激活后才提供带上下文的画布跳转。

## 任务、刷新与实时连接

- 首次打开/刷新先加载 session/messages/active turn/workflow 快照，再用返回的 `last_event_seq` 订阅 SSE；不得只靠内存恢复。
- 当前 turn 的可见步骤紧跟该轮用户消息，位于 Assistant 结果之前；进行中展开并随真实 activity 更新，结束后的历史步骤默认折叠，可用箭头展开。标题使用“创作过程”，不暗示公开了模型私有推理。同 `activity_id` 的 finished 更新原行，不生成重复卡片。展开内容仍只显示服务端白名单阶段摘要与完成/失败状态，不显示模型隐性思考、完整 prompt、Skill 正文、内部工具名或参数。
- 澄清问题与回答控件在同一条 Assistant 消息下，问题只显示一次；允许选项、文字回答和打开现有附件选择器。附图后由用户从 Composer 发送新消息，取代旧待确认 turn，不得把附件塞进只接受答案的 confirm payload。`waiting_for_you` 停止思考动画；已经提交的 workflow 继续显示真实任务进度。图片区只根据权威 task/artifact 显示已完成张数，不推断百分比。
- 显式 `agent_respond` 生成中的公开草稿可在同一 Assistant 位置实时显示，但必须标识为运行中、与正式消息区分；正式消息到达或草稿清除时原位接管/移除。刷新从 GET turn 恢复草稿与事件游标，不重新触发模型或生成；不得用打字动画伪装流式，更不得展示 reasoning token、完整提示词、Skill 正文或其他工具参数。
- turn 已创建 `workflow_run_id`、仍为 `thinking` 且尚无 Assistant 结果时，在对应用户消息的进度行后显示图片生成中占位。用户在同一会话继续发送新消息后，所有已经提交且尚未形成持久 Assistant 结果的 workflow 仍按各自 `turn_id` 保留、恢复和增量更新，不得被最新 turn 的实时快照覆盖或从消息流消失。占位按各 turn 的 `generation_preferences.aspect_ratio` 预留稳定尺寸，限制最大可视高度；真实结果在同一几何区域原位替换，桌面和移动端均不得产生布局跳动。占位不伪造进度百分比，不因刷新、SSE 重连或 polling 回退重复创建；持久 Assistant 结果接管后才释放对应临时投影。
- Agent 消息、可见步骤和生成占位使用同一个稳定的“创作助手”头像与身份标签；用户头像与 Agent 头像在视觉上明确区分，头像尺寸不得因状态变化而改变。
- 每张已生成图片可显示一个“创作笔记”图标；点击后只展示 Brain 为该图片节点实际产出的公开 `creative_note`。多图必须按 task/artifact 一一对应，不得展示第一张的复用文案、前端推断文案、完整 Provider prompt 或隐藏推理链；没有服务端笔记时不显示入口。
- GET turn 快照返回由 outbox 重建的 `activities[]` 最新状态；刷新、SSE gap 和 polling 回退后都以该快照收敛，不允许仅保留浏览器内存中的活动。
- SSE 心跳、客户端 watchdog 和重连以 `06` 为准；重连期间保留已有内容并显示非阻塞状态。
- workflow 终态事件后仍须读取不落后于该事件游标的权威快照，再关闭实时连接；`retryable/latest_retry`、产物与结算投影不得因提前断开而停留在事件前状态。
- 事件断档、watchdog 超时或 SSE 不可用时，重新取快照后续订；禁止重新 POST turn/confirm。
- 切页、关闭抽屉或刷新不停止后台生成。收费任务只能通过明确取消 API 处理。
- 新消息 supersede 只作用于 `04` 允许的未收费 turn；已提交 run 不被静默取消。
- `outcome_unknown` 显示“本次生成未完成”，不得声称有人或平台正在核对。停止生成动画并显示明确“重新生成”入口；点击会新建独立收费任务，提示旧结果可能迟到，不得重投原 attempt。原请求未结算冻结最迟 30 分钟由自动 sweeper 释放。生成后内容审核未知仍显示“结果复核中”和 24 小时复核时限；两类状态均保留已可见产物。
- 多图中结果已确定的单张失败必须进入终态失败槽位，并在该槽位显示“重新生成”。点击只重试这一张：直接复用服务端冻结 task，新建单图 quote/reservation/workflow/task，不重新调用 Brain/Compiler 规划，不重跑成功图片；按钮等待态、错误态和刷新恢复均由 `retryable/latest_retry` 投影及新 workflow 快照驱动。当前接口是 task 级重试，只对冻结 `output_count=1` 的 image task 开放；`output_count>1` 的单 task 不得伪装成可重试单槽位。完整 Provider Prompt 永不下发，仍只允许显示公开 `creative_note`。

## API/SSE 映射

| UI 动作/数据     | 契约                                                           |
| ---------------- | -------------------------------------------------------------- |
| 会话列表/搜索    | `GET /api/v1/agent/sessions`，signed keyset cursor             |
| 会话恢复         | `GET /api/v1/agent/sessions/{session_id}`，先快照后 SSE        |
| 重命名/删除      | session PATCH/archive；revision CAS + 用户幂等键               |
| 新建 turn        | `POST /api/v1/agent/turns`，使用客户端幂等键                   |
| Skill 目录       | `GET /api/v1/skills`；ETag/短缓存只供展示，发送时服务端重校验  |
| 模型目录         | `GET /api/v1/model-catalog?category=brain` 或 `category=image` |
| 提交确认卡       | `POST /api/v1/agent/turns/{turn_id}/confirm`                   |
| 主动停止理解阶段 | `POST /api/v1/agent/turns/{turn_id}/interrupt`                 |
| 费用提交         | `POST /api/v1/run-quotes/{quote_id}/submit`                    |
| 取消/明确重试    | workflow cancel/retry API；不得前端改状态                      |
| 商品/资产/作品   | `06` products/assets/artifacts API                             |
| 实时恢复         | `GET /api/v1/events?...&last_event_seq=` + workflow/task 快照  |

创建 turn 时，Composer 必须把当前用户选择的产品化模型作为完整 `model_selection` 一并提交：`{ catalog_revision, brain: { catalog_entry_id, version_no }, image?: { catalog_entry_id, version_no }, video?: { catalog_entry_id, version_no } }`。字段来自 S14A active catalog；前端不得提交 Provider、内部 `model_id`、channel、Key、SKU、价格或成本。发送前 UI 只负责检查选择是否仍在本地 catalog 中，服务端仍需按 `06` 的规则重新解析 active release、能力、rollout 和视频阶段门禁；catalog 漂移时保留草稿并要求刷新，不自动换模。

Composer 提交 strict `generation_preferences={schema_version:2,output_kind:'image',aspect_ratio,resolution_tier}`，不提交 `output_count`。服务端按所选 image entry 重新校验比例与清晰度并固化 hash；Brain 在 candidate plan 中解析 `output_count/output_count_source`，Compiler 重新校验后才形成 Provider 参数和 quote。前端不得解析 prompt 中的数量，已创建 turn 的偏好与 Brain 结果均不被后续 Composer 选择覆盖。

## 会话、模型与恢复不变量

- 会话列表和详情只来自 PostgreSQL；`localStorage` 只保存尚未创建 turn 的 Composer 草稿，禁止保存已登录会话、历史消息、任务终态或权限真相。
- UI“删除会话”只调用 archive。存在活动 turn/workflow/待确认时明确阻断并引导停止或取消，不静默终止、不删除资金/产物/trace。
- 首次进入允许把 active catalog 的显式默认 Brain/图片项显示为已选，但发送动作仍完整提交 ID/version/revision；catalog 空、unavailable、漂移或不支持当前规格时发送禁用且保留草稿。
- S11 激活后新 turn 必须固定 skill selection、model selection、generation preferences 三组用户选择 snapshot/hash，并由服务端根据幂等生成动作写入不可变 execution authorization evidence/hash；任一缺失都不能进入 Brain 或图片 Provider。authorization evidence 不含用户设置的金额上限。
- API 创建 trace 时把所选 Brain 的精确不可变 model row/strict snapshot 固定到 trace；Worker 只消费该 snapshot。运行中 catalog、默认项、通道或价格变化不能静默换模；真实 adapter 未注册/未批准时 fail closed，local/test fake 也不得绕过 catalog selection。
- 页面刷新先取 session/turn/workflow 权威快照，再以返回 cursor 建立 SSE；恢复过程中禁止重新 POST turn/confirm。历史消息分页只加载 user/assistant 安全投影。
- 1A Agent turn 不投影 `cost@v1` 费用卡。刷新后从 turn/workflow/quote 权威快照恢复预计积分和积分阻断原因，但不得重新 POST turn、重新创建 quote 或调用 Provider；余额不足、并发限制和价格漂移均恢复为就地状态与保留草稿提示。

## 数据库与迁移

- 只新增前向 migration：`chat_sessions.revision/archived_at/primary_skill_slug` 及 `(user_id, archived_at, updated_at, id)` 列表索引、`agent_turns.generation_preferences_json/hash`，以及 `05` 已裁决但尚未落 schema 的 `agent_turns.model_selection_snapshot_json/hash`。`primary_skill_slug` 从历史会话最早 turn 前向回填，不修改 turn 快照。
- 新增 `agent_session_mutations` 保存 rename/archive 幂等响应；不修改或复用 Admin 幂等表，不把 Redis 当真相。
- 不修改历史 migration；空库全量迁移与 S08 legacy nullable 数据兼容都必须验证。S11 新写入路径强制完整字段，legacy 行只读且不能进入真实模型恢复。

## 必须覆盖的状态

`empty`、`skill_required`、`skill_refreshing`、`skill_invalid`、`typing`、`uploading`、`upload_failed`、`thinking`、`clarification_required`、`fact_confirmation_required`、`pricing_checking`、`pricing_unavailable`、`quantity_invalid`、`insufficient_credits`、`queued`、`running`、`checking`、`sse_reconnecting`、`snapshot_recovering`、`outcome_unknown`、`quarantined`、`failed`、`refunded`、`completed`、`permission_denied`、`risk_frozen`。

用户只看到 `04 §11.1` 的状态映射，不直接显示内部枚举、tool JSON、Provider 原始错误或账本事件名。

## 测试标准

- Testing Library：输入/键盘、附件生命周期、`@` 候选域、主 Skill 必选、Preset slot、快捷入口显式选择、catalog 失效恢复、事实/风险确认幂等、任务/产物面板、大图预览，以及可见步骤位于当前用户消息后、默认单行、箭头展开/收起、同 ID 原位更新、无内部工具/思考泄露；生成占位覆盖常见比例、无 workflow 不出现、Assistant 结果出现后消失和稳定 Agent 头像。
- Testing Library：不渲染费用卡/执行模式/积分上限/数量控件；自然语言数量保持原文提交且前端不解析；价格、余额不足、数量越界和 catalog 漂移就地提示并保留草稿。
- API 集成：session keyset/搜索/用户隔离、rename/archive 幂等与并发 CAS、active session 归档拒绝；model catalog 漂移/unavailable/跨类别/规格越界均在创建任何 turn 前拒绝。
- Worker 集成：所选 Brain snapshot 被精确消费；catalog/默认项变化不换模；fake 仅 local/test，approved adapter 缺失或凭据不可用 fail closed；超时/连接复位保留成本 exposure 且不自动换模。
- 真实 Brain PoC：`pnpm poc:agent-brain` 覆盖 strict tool/terminal、usage、actual cost 和内容脱敏；结果需人工审批，CI 不调用公网或产生真实费用。超时/连接复位、exposure 保留、无静默换模和未支持模型拒绝由同一运行链路的自动化反例覆盖。
- Skill 内容：11 个 primary 及其 dependency/resource closure 均可复现打包并通过 strict validator；热门类目 auxiliary 的一跳边界、每个 golden dataset 的正反例/素材职责/注入/权利元数据齐全，外部仓库原文和资产扫描为零命中。
- Playwright 正向：S11 使用 deterministic fake 验证邀请登录、自然语言张数由 Brain 解析、创意直接生成、电商事实确认后直接生成、结果继续改/下载/存库和恢复交互；不得把该结果写成真实生图证据，S12/S13A/S13B 另跑真实图片浏览器链路。
- Playwright 反向：上传部分失败、失效 `@`、价格不可用、重复生成、余额不足、数量越界、R1-R5 拒绝、隔离、结果未知；断言以上情况不会调用图片 Provider。
- Playwright 恢复：生成时刷新、SSE 断开/watchdog、事件断档快照恢复、切页后返回；断言 turn/run 数量不增加。
- 桌面和至少一个移动 viewport 截图检查无覆盖、输入区不跳动、最长中文状态文案不溢出。

## 验收清单

- [ ] 第一组页面/overlay/状态清单及 Stitch 设计已评审冻结。
- [ ] 同一工作台已具备创意、电商和本会话改图的完整交互与恢复能力；真实图片完成证据分别由 S12/S13A/S13B 验收，S11 fake 不冒充上线完成。
- [ ] `@` 只引用当前输入附件，资产必须先显式加入。
- [ ] 新会话首轮选择并固定 primary；同会话每次 turn 都携带同 slug 当前版本与本轮 Preset，页面不可切换 primary，新的创作方向必须新建会话；缺失、失效或会话方向冲突时不发送，Agent 不自动选择或替换。
- [ ] 发送区只有“发送/生成/继续改并生成”主动作，不显示费用卡、执行模式、数量控件或当次积分上限；自然语言张数由 Brain 解析，Compiler 与 Credit 在图片 Provider 调用前完成能力、quote、余额和 reservation 校验。
- [ ] 会话历史来自服务端并支持搜索、重命名、归档；跨用户、并发冲突和活动会话归档均 fail closed。
- [ ] 每次 turn 固定用户选择的 Brain/图片模型与比例/分辨率/数量；目录漂移不自动换模，运行中配置变化不追改快照。
- [ ] 至少一个真实 Brain adapter 与 `poc:agent-brain` 通过；真实报告证明 strict tool/terminal、usage 与 actual cost，自动化反例证明成本 exposure、超时 unknown、未支持模型网络前拒绝和无静默换模，两类证据均可追溯到同一 adapter/router。
- [ ] 11 个 1A primary、7 个热门类目及通用 auxiliary、Preset/L2 已形成正式可复现内容包，不是测试 fixture；local/test 可安装发布，并由 S12/S13A/S13B 激活后进入 S15 上线门禁。
- [ ] 必要事实/风险确认清晰；不存在计划确认或费用确认卡。
- [ ] 页面刷新、切页和 SSE 重连不丢任务、不重复提交。
- [ ] 内部状态、prompt、tool JSON 和 Provider 原始错误不泄露。
- [ ] 画布不作为 1A 主交互出现。

# Final Brain relay addendum (2026-08)

The Brain model selector is a real model snapshot selector, not a provider
fallback selector. The user selects one published model for the Brain capability
slot; the server revalidates it and freezes its protocol, model ID, channel,
credential, pricing, quota, and catalog revision in the turn snapshot. All Brain
steps in that turn use that same snapshot. A dispatch failure never silently
selects another model.

The first real adapter set supports OpenAI relay Chat Completions/Responses and
Anthropic Messages relay compatibility. Vercel AI SDK is the internal call layer;
the existing AgentBrainPort, loop guard, compiler, cost exposure, and three-state
outcome contracts remain authoritative. The UI shows configured model names and
specs, never protocol or endpoint details.
