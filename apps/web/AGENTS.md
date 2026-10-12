# Web 子工程说明

## 职责

- 本目录是 Next.js App Router 前端、轻量 BFF、API/SSE 客户端和用户交互层。
- 先遵循根 `AGENTS.md`，UI 细节以 `docs/07-1a-user-flow-and-ui.md` 和当前 SPEC 为准。

## 实现约束

- 不导入 `@ecom-forge/db`、`@ecom-forge/credit` 或 `@ecom-forge/provider`，不在客户端计算费用、权限或产物归属。
- route/server action 只做请求适配与聚合，业务规则放 API 或对应 package。
- 正式 UI 必须来自已评审设计。经用户明确批准时，可在 S11 前按 `docs/design/` 制作高保真代码原型以冻结视觉与交互；原型只使用 mock 数据，不接真实 API、不实现资金裁决，并在 S11 中复用组件后再接正式状态。
- 页面、布局、通用 UI 和业务组件按 `app/`、`components/`、`features/`、`lib/` 分层。
- `components/ui/` 只放无业务语义的基础件；业务组件按 feature 组织。单个实现文件超过 400 行必须拆分，禁止一个文件承载多个页面或巨型业务组件。
- 业务代码禁止硬编码 `#xxx` 色值，一律使用 `app/globals.css` 中的语义 CSS 变量；新增语义色必须先回写设计系统文档，再进入实现。
- 一个状态只能有一个所有者。组件内部 state 不得与持久化或全局状态双轨；跨页面共享状态使用统一 store 和单一类型源；组件 props 超过 10 个时必须拆分子组件、组合对象或下沉局部状态。
- 带展开/收起、拖拽、定时器等状态机的交互必须拆成独立业务组件并提供组件测试，不得内嵌在大型父组件中。
- 图标按钮必须提供 `aria-label`，`title` 不能替代可访问名称；自定义交互必须支持 Tab、方向键和 Escape 等适用键盘操作；动画必须尊重 `prefers-reduced-motion`。
- SSE 必须支持 heartbeat/watchdog、`last_event_seq` 恢复、事件去重和刷新后状态恢复。
- 不直接展示内部状态；使用用户视角状态和可行动文案。

## 验证

- 组件与 hooks 使用 Vitest + Testing Library。
- 新增有行为或状态的组件至少覆盖正常、异常和边界 3 类用例；纯展示基础件至少覆盖渲染、属性透传和可访问性契约。缺少相应组件测试不得合入。
- 关键用户闭环、刷新恢复、费用确认和 SSE 重连使用 Playwright。
- UI 变更至少运行 `pnpm --filter @ecom-forge/web lint`、`typecheck`、`test` 和相关 E2E/build。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
