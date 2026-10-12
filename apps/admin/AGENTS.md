# Admin 子工程说明

## 职责

- 本目录是独立部署的管理控制面，只使用 Admin Session、Admin CSRF、MFA、step-up、permission 与 scope。
- 不导入 `apps/web`、普通用户 Session 或用户页面组件；不在普通站点暴露管理入口。
- 浏览器只调用 `/api/v1/admin/*`，不得访问数据库、直接写账本、直连 Provider 或对象存储。

## 实现约束

- 页面按运营领域拆分；共享 antd/ProComponents 适配层放 `components`，管理业务组件放 `features`。
- 所有写操作必须显式呈现 reason、expected revision、幂等键和 step-up 状态；前端隐藏按钮不构成权限。
- 密钥、TOTP、恢复码、enrollment token 和邀请码明文等敏感内容不得写入 localStorage/sessionStorage、日志或错误上报；邀请码只允许在创建或受控 reveal 响应的当前界面短暂展示和复制。
- 列表使用服务端 keyset cursor；不在浏览器猜测权限、资金状态、Provider 状态或可执行迁移。
- 移动端只支持查询与契约允许的紧急操作，不提供批量发布。
- 组件与页面使用语义 token；组件统一使用 antd/ProComponents，图标使用 `@ant-design/icons` 并提供可访问名称，不引入 Umi/Max。
- 列表统一复用 cursor data-source adapter，不向 keyset API 发送 offset/current/pageSize 或伪造 total；表单状态归 antd Form，Zod 只做边界契约校验。

## 验证

- UI 变更至少执行本包 lint、typecheck、test、build，并覆盖桌面与 390px 移动截图。
- 登录、MFA、step-up、权限拒绝、Session 失效和高风险写操作必须有真实 Admin API Playwright E2E。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
