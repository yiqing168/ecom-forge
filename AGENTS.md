# 项目工作说明

## 项目概述

- 本项目是面向中国电商用户的 AI 创作平台，1A 第一入口是对话 Agent，用于创意生图、电商从零生成和本会话产物迭代。
- 无限画布属于阶段 3a/3b 的专业工作流模块，不得把 1A 做成画布 Agent。
- 产品、交易、状态、数据和 API 语义由 `docs/` 裁决；实现任务由 `docs/spec/` 裁决。发生冲突时按 `docs/README.md` 的优先级处理，不得由代码自行发明新口径。
- 当前只有一名开发者，SPEC 按依赖串行交付。外部 Provider 等待期可以切换任务，但不视为并行产能。
- 主要技术栈为 pnpm monorepo、Turbo、Next.js、NestJS、TypeScript、Drizzle/PostgreSQL、Redis/BullMQ、Vitest、Supertest 和 Playwright。

## 开工规则

1. 先读当前 SPEC 的“开工前必读”和直接上游契约。
2. 确认 SPEC 的依赖已完成，再修改代码；未完成依赖不得用临时业务语义填空。
3. 修改契约、枚举、表字段、API payload 或状态转换前，先改其裁决文档并完成复审。
4. 保持改动聚焦当前 SPEC，不重构无关模块，不删除已有改动。
5. 每个 SPEC 同时交付它要求的代码、测试、日志、监控入口和验收命令。

## Skill 内容生命周期

- 内置 Skill 是 `packages/skills/content/` 中随应用交付的第一方内容。修改已列入资源清单的 Markdown、frontmatter 或引用资源后，重启 API/Worker 即读取最新内容；不必手动更新 manifest hash、byte_size、语义版本号或代码中的版本清单，不经过管理台上传、审批、发布、激活或回滚流程。新增/删除资源，或修改目录、能力、依赖和 Preset 配置时，才更新 manifest。
- 外部 Skill 包才使用 quarantine、内容校验、审批、catalog 发布、停用和回滚链路。外部包不得覆盖同名内置 Skill。
- 内置 Skill 仍必须通过本地内容校验和 golden eval；本地校验和启动均在内存中按当前工程文件重算资源 hash/byte_size，不回写 manifest。`skill-package.json` 在内置路径只作为资源清单和宿主配置，不是发布门禁。内容审计、诊断和复现使用实际 definition/resource/package/catalog hash 快照；语义版本号用于配置契约升级，不是内容更新的手动门禁或运行时激活开关。内容意图改变时按风险补评测，不为普通措辞更新同步固定字符串断言。
- 新建 turn（包括历史会话继续创建的 turn）使用当前进程加载到的最新内置 Skill；正在执行的 turn 只在当前执行边界内保持一致，不得在一次运行中途切换内容。

### Skill 制作规范

- `SKILL.md` 必须是可脱离本仓库使用的通用 Skill：使用 Codex 兼容的 YAML frontmatter（至少 `name`、`description`）和普通 Markdown 创作知识。正文写任务目标、专业方法、事实判断、真实限制、质量检查和修改方法；不要要求 `candidate_plan`、`image.edit`、`semantic_reference`、固定助手输出格式、固定 Prompt 顺序或固定字符数。
- ecom-forge 的 `skill_profiles` 位于 `skill-package/skill-package.json`，承载 catalog、Skill 类型、输入/事实提示、能力提示、默认张数、Preset、依赖、references 和审计元数据。它是宿主运行配置，不得复制进 `SKILL.md`，也不能把能力提示当成工具授权。
- 新增或迁移 Skill 时保留创作意图和有价值的方法，不为满足平台 schema 改写成平台专用任务书。模型负责理解并决定回答、澄清、生成或改图，宿主 Agent 负责工具、权限、交易、Provider 和结果处理。
- 用户自己上传且服务端确认归属、可读、生命周期有效、hash/version 和存储内容一致的图片，默认视为当前创作请求的授权输入；跨用户、删除、隔离、缺失或版本漂移仍必须拒绝，不把 `source-rights-confirmed` 作为普通用户上传的必填确认项。

## 常用命令

- 安装依赖：`pnpm install`
- 本地基础设施：`docker compose up -d`
- 数据库迁移：`pnpm db:migrate`
- 全仓开发：`pnpm dev`
- 需要源码热重载时：分别运行 `pnpm --filter @ecom-forge/api dev:watch`、`pnpm --filter @ecom-forge/worker dev:watch`；用户验收期间使用默认 `dev` 稳定进程，禁止开启 watch 导致请求中断。
- 格式检查：`pnpm format:check`
- 格式化：`pnpm format`
- 代码检查：`pnpm lint`
- 自动修复：`pnpm lint:fix`
- 类型检查：`pnpm typecheck`
- 单元测试：`pnpm test`
- API 集成测试：`pnpm test:integration`
- Worker 测试：`pnpm test:worker`
- 浏览器 E2E：`pnpm test:e2e`
- 构建：`pnpm build`
- 完整本地门禁：`pnpm check`
- 阶段 0 验证入口：`pnpm validate:stage0`
- 提交引导：`pnpm commit`

Windows PowerShell 若阻止 `pnpm.ps1`，使用 `pnpm.cmd` 执行同名命令。

## Worker Restart

- Stable local acceptance uses `pnpm.cmd --filter @ecom-forge/worker dev`. The command first rebuilds workspace dependencies and then runs `apps/worker/dist/main.js`, so stale package output cannot be loaded.
- To restart the Worker, stop the current Worker terminal with `Ctrl+C`, then run the same command from the repository root. Wait for `worker_ready` in the Worker log before testing.
- Use `pnpm.cmd --filter @ecom-forge/worker dev:watch` only for source hot reload. It is not the acceptance process because a source reload can interrupt an in-flight turn.
- Do not start a second Worker process. A built-in Skill change requires both API and Worker restart because API freezes the Skill version when creating a turn; Web does not need to restart.

## 环境配置规则

- `.env.local` 只保存当前机器或环境必须动态注入的值：数据库/Redis 连接、部署 Origin/代理范围、Provider relay allowlist、邮件/外部服务连接和 secret/keyring；不得把代码默认值、队列参数、SSE/Agent/存储限制、限流、超时或测试配置复制进去。
- `.env.example` 只保存部署输入的占位符和必要说明，不是 `.env.local` 的完整副本；不得放真实密钥、历史测试地址或固定默认值。
- 固定常量统一写入对应 typed config 的 `runtime-defaults.ts`，并由配置 loader 校验环境覆盖；修改默认值时同步代码测试和部署文档，不通过新增 env 变量解决普通业务策略。
- API 与 Worker 使用各自最小环境集；Worker 专属的消费开关不得放入 API 共用配置。`TEST_*` 只由测试 runner 临时注入。
- 新增环境变量前必须说明它为什么需要跨部署变化；如果答案只是“方便改默认值”，就不能新增，先放进代码配置文件。

## 工程边界

- `apps/web/`：Next.js 页面、交互、API 客户端和 SSE 客户端；不得访问数据库、写账本或直连 Provider。
- `apps/api/`：认证、HTTP/SSE/Webhook、权限、交易事务和状态裁决入口；Controller 保持轻薄。
- `apps/worker/`：BullMQ Processor、Provider 投递/轮询、评估、通知和 Cron；数据库状态是唯一进度真相。
- `packages/db/`：Drizzle schema、migration 和 seed，不承载业务服务。
- `packages/types/`：DTO、事件、状态和 API 响应类型，不依赖应用或有副作用包。
- `packages/shared/`：无副作用工具、错误码、canonical hash 和成本公式。
- `packages/agent/`：turn、上下文、工具循环和 Skill runtime，不拥有费用与权限裁决。
- `packages/compiler/`：确定性计划编译、R1-R5、引用授权和收费动作校验。
- `packages/credit/`：唯一允许写资金流水的业务包。
- `packages/provider/`：Provider adapter、三态回执、成本和模型快照。
- `packages/queue/`：队列名、payload、job 幂等和调度基础，不发明业务状态。
- `packages/skills/`：Skill 与引用资源，遵循 L0/L1/L2 渐进加载。
- Skill 拆分必须服务渐进加载：只有按任务动态选择的可选知识，或被多个 primary 共享的知识，才拆为 auxiliary/reference。若一段知识对某 primary 每次都必须加载且不被其他 primary 共享，必须直接并入该 primary 的 `SKILL.md`，不得创建必加载子 Skill 或必加载专属 reference。
- 复杂、单体化的 primary `SKILL.md` 可按该 Skill 自身的方法链使用稳定编号组织内容，便于维护者审查和版本间对照。编号数量、章节名称与具体顺序不设全局模板；只要求从任务目标和输入证据出发，完整覆盖关键决策、质量门禁和修改方法。简单 Skill 不为形式强制编号或凑章节；平台执行边界写在宿主文档和 manifest，不写成可复制 Skill 的固定输出契约。
- 内部依赖必须使用 `@ecom-forge/*` 和 `workspace:*`；应用不得被 workspace 反向依赖。

## 核心业务约束

- 收费链路固定为 `run_quote -> 已鉴权生成动作证据 -> reservation + workflow_run 同事务创建 -> settlement`。用户点击各入口的“生成/开始批量生成/运行节点/运行工作流”就是本次动作授权；任何生图入口都不显示费用卡、不二次确认费用、不接受用户金额上限。服务端必须在 Provider 前完成报价、余额/并发核对和预留。
- `credit_ledger` 是资金唯一真相，余额是投影；资金变更必须幂等且可通过 ledger replay 重建。
- Provider 回执严格区分 `not_dispatched`、`accepted`、`outcome_unknown`。只有确定未送达可以自动重试；未知结果不得自动重投。
- 产物修改权必须由服务端按 R1-R5 和 producer/mutation owner 确定，不能由 LLM 或前端状态决定。
- 用户数据查询必须显式带 `user_id`/租户边界；下载与分享也必须重新鉴权。
- Agent 工具动作必须经过确定性编译器；同参重复调用、无进展循环、token/积分预算超限必须被阻断。
- 日志不得记录密钥、完整 prompt、签名 URL 或图片二进制；使用 trace/run/task/attempt ID 关联。

## 金额与精度

- 积分和成本金额禁止用 `number` 参与算术。数据库使用 `numeric`，代码统一使用 `decimal.js`。
- Drizzle 的 `numeric` 列必须以 string 读出，禁止隐式转 `number`。
- 金额运算与比较只允许通过 `packages/shared` 的金额工具函数，禁止直接使用 `+ - * /` 和 `=== > <`。
- 舍入规则唯一：保留 2 位小数、`ROUND_HALF_UP`，在 `packages/shared` 集中实现，禁止各处自行 `toFixed`。
- 写入 `credit_ledger` 前必须断言 `balance_after` 与 ledger replay 结果一致。
- `03` 的成本核算公式同样遵守以上精度规则，不得用浮点近似估价。

## 事务与外部调用

- 数据库事务内禁止任何网络调用：Provider、LLM、对象存储、HTTP、邮件、内容审核。
- 事务只做读写和状态校验；外部调用放在事务外，通过 `task_attempt` 和队列衔接。
- 事务必须有明确超时上限，禁止无界事务长时间持有 `credit_accounts` 等热点行锁。
- 跨聚合的状态变更走 `event_outbox` + 队列，不用长事务串联。

## 时间与时区

- 所有时间以 UTC 存储和传输，数据库使用 `timestamptz`。
- 业务逻辑禁止使用本地时区；时区转换只在展示层完成。
- 超时与时限判定（outcome_unknown 结束后 30 分钟自动释放、72h 申诉、turn 超时、签名 URL 有效期、报价 TTL）必须使用服务端时间，不信任客户端时间戳。

## UI 约束

- 正式产品 UI 编码前，先审阅本地且 Git 忽略的 `imgage/`，形成页面/弹窗/状态清单。设计可通过 Stitch/Figma 等设计稿，或由已评审文档驱动的高保真代码原型完成；两种路径都必须经过桌面/移动截图审查和用户验收后才能冻结。
- 参考图只用于提取设计优点，不复制其他系统的产品形态。1A 始终是对话 Agent，不出现画布优先体验。
- 代码原型用于冻结视觉和交互时必须使用 mock 数据，并与正式 API/交易实现隔离；不得因为原型可点击就宣称业务能力已完成，也不得提前发明后续 SPEC 的接口语义。
- 页面按 production feature 划分，避免在 route 文件中堆积大段交互和业务逻辑。
- 用户状态使用 `07` 的视角映射，不直接暴露内部状态枚举。
- 涉及 UI 的任务必须覆盖桌面/移动布局、错误/空/加载/重连状态，并至少提供组件测试或 Playwright 用例。

## 数据库与迁移

- 表、字段、枚举、唯一约束和索引以 `docs/05-data-model-and-constraints.md` 为准。
- 只做向前兼容迁移；删除或重命名必须经过多版本灰度。
- 已提交或已应用的 migration 不可修改、重命名或删除；修正必须新增 migration。
- 禁止手工修改迁移历史或生产数据库来掩盖 drift。
- 迁移提交前必须检查生成 SQL，并在空数据库验证从零执行；资金和 workflow 表还需专项验收查询。
- 不得执行破坏性 reset，除非用户明确批准且已确认目标是可丢弃环境。

## 提交与验证

- 每个 SPEC 固定执行：实现与测试 -> Codex 完整代码审查 -> 修复并复验 -> Codex 明确报告“代码审查通过” -> 等待用户验收 -> 用户明确验收通过后才允许提交。
- 代码审查通过不等于用户验收通过；用户验收前不得执行 `git commit`，也不得擅自合并或推送。
- 使用 pnpm，不使用 npm/yarn，也不引入第二套 lockfile 或任务编排器。
- 不自行升级 Node、pnpm 或核心依赖；升级必须独立提交并通过完整门禁。
- pre-commit 只检查 staged 文件，CI 重新执行 format、lint、typecheck、test 和 build。
- 审查时检查完整工作区 diff；用户验收通过并准备提交前，再人工检查 staged diff，确认无敏感信息、无参考图、无无关文件和无生成产物。
- TypeScript 变更至少运行相关测试、`pnpm lint` 和 `pnpm typecheck`；工程配置变更还需运行 `pnpm install`、`pnpm check` 和 `pnpm build`。
- 资金、权限、幂等、状态机、队列或 Provider 变更必须补失败路径与并发测试，不能只测成功路径。
- 无法运行的检查必须在交付说明中列出原因和风险，不得描述为已通过。

## 禁止事项

- 不提交 `.env`、密钥、token、真实 Provider 数据、`imgage/` 或用户上传内容。
- 不允许 Web/Agent/Worker 绕过 `packages/credit` 写账本。
- 不允许在 `accepted/outcome_unknown` 后依赖 BullMQ 自动 attempts 重投 Provider。
- 不把图片二进制存入 PostgreSQL，不在业务代码中写死云厂商 SDK。
- 不把核心业务逻辑写入 React 组件、Controller 或队列 Processor。
- 不因测试暂时困难而弱化鉴权、幂等、内容安全或资金不变量。
- 不删除或回滚用户已有改动。
