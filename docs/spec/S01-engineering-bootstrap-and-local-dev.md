# S01 工程 Bootstrap 与本地开发环境

| 项     | 内容                                                                             |
| ------ | -------------------------------------------------------------------------------- |
| 状态   | v0.1 实现完成，代码审查通过，待用户验收                                          |
| 阶段   | 1A / D1                                                                          |
| 优先级 | P0                                                                               |
| 目标   | 建立产品级 pnpm monorepo、本地开发环境、基础服务骨架、代码质量门禁和测试命令基线 |

## 开工前必读

- `docs/README.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/spec/00-master-development-plan.md`

## 当前模块范围

实现工程骨架，不实现业务功能。

初始化顺序固定为：`git init -> 创建根 package/workspace -> pnpm install -> Husky prepare/init -> 创建 hooks -> 执行质量门禁`。Husky 前置失败不得跳过。

包含：`apps/web`、`apps/api`、`apps/worker`、`packages/db`、`packages/types`、`packages/shared`、`packages/agent`、`packages/compiler`、`packages/credit`、`packages/provider`、`packages/queue`、`packages/skills`。

不包含：真实 Provider、支付、正式产品 UI 设计、设计系统、业务页面、画布。S01 的 layout、健康页和错误页只用于工程启动与 E2E 验证，不作为 S11 的视觉基线；不得因此跳过参考图审阅和 Stitch 设计门禁。

## 交付面

| 交付面     | 要求                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 前端/UI    | Next.js App Router 项目可启动，提供仅供工程验证的基础 layout、健康页、错误页；不交付正式产品 UI        |
| 后端/API   | NestJS API 可启动，提供 `/api/v1/health`                                                               |
| Worker     | Worker 进程可启动，暂无业务 job                                                                        |
| 数据库     | Docker PostgreSQL、Redis compose                                                                       |
| 测试与质量 | Vitest、Supertest、Playwright、ESLint、Prettier、Husky、lint-staged、commitlint、Commitizen 和 CI 基线 |
| 部署       | 本地 `.env.example`、启动脚本、README                                                                  |

## 接口与命令

- `GET /api/v1/health`
- `pnpm dev`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm lint:fix`
- `pnpm format`
- `pnpm format:check`
- `pnpm check`
- `pnpm commit`
- `pnpm test`
- `pnpm test:integration`
- `pnpm test:worker`
- `pnpm test:e2e`
- `pnpm test:load`
- `pnpm db:check`
- `pnpm validate:stage0`
- `pnpm validate:quality-gates`

`pnpm validate:*` 在 S01 只建立统一命令入口和脚本目录；各验证脚本的真实断言由总计划中的“验收脚本归属表”对应 SPEC 实现。

## 工程约束交付

- Node.js `22.22.3`、Corepack 和 pnpm `11.7.0` 按 `10` 锁定，提交 `pnpm-lock.yaml`。
- `pnpm-workspace.yaml` 只包含 `apps/*` 和 `packages/*`；应用不可被反向依赖，内部包统一 `@ecom-forge/*` + `workspace:*`。
- 必须先 `git init` 并验证 `.git/` 存在，再执行 Husky 安装和 Hook 配置。
- 创建根 `eslint.config.mjs`、`prettier.config.mjs`、`.prettierignore`、`.editorconfig`、`.gitattributes`、`commitlint.config.mjs`。
- 配置 Husky `pre-commit` 和 `commit-msg`；pre-commit 只运行 lint-staged，commit-msg 运行 commitlint。
- 配置 Commitizen + cz-git，提供 `pnpm commit`；普通 `git commit` 仍受 commitlint 约束。
- lint-staged 的文件匹配、ESLint 包边界、Prettier 风格和 Conventional Commits 类型/scope 严格使用 `10 §9`，不得在子项目另建冲突配置。
- 建立 CI 基线，执行 frozen install、format check、lint、typecheck、test 和 build。

## 测试标准

- `apps/api/test/health.e2e-spec.ts`：健康检查返回 200。
- `apps/web/e2e/health.spec.ts`：前端健康页可打开。
- `packages/shared/src/index.spec.ts`：共享包可被 API/Web 引用。
- 增加工程门禁 smoke：故意制造 lint、format 和非法 commit message 时 Hook/CI 必须失败；合法暂存文件不得触发全仓无关文件改写。

## 验收清单

- [x] 本地 `docker compose up -d` 成功。
- [x] Git 仓库先于 Husky 初始化，`.git/` 与 `.husky/pre-commit`、`.husky/commit-msg` 均存在。
- [x] `pnpm dev` 可同时启动 web/api/worker，并通过无共享包 `dist` 的冷启动复验。
- [x] 所有测试命令存在且可空跑通过。
- [x] `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm check` 可执行。
- [x] Husky pre-commit、commit-msg、lint-staged 和 commitlint 可证明会拦截违规提交。
- [x] `pnpm commit` 入口、cz-git 配置和 Conventional Commits 校验已验证；实际提交等待用户验收。
- [x] Node/pnpm/lockfile、LF 和 UTF-8 约束已落库。
- [x] CI 基线可执行，且不依赖本地 Hook 才能阻止违规合并。
- [x] 工程目录与 `10` 一致。
