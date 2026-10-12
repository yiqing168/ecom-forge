# API 子工程说明

## 职责与边界

- 本目录承载 NestJS HTTP API、SSE、Webhook、认证、权限和业务编排入口。
- Controller 只负责 schema/DTO 校验、鉴权上下文、调用应用 Service 和响应映射。
- Controller 不直接访问数据库、不计算费用、不写账本、不调用 Provider、邮件、对象存储或队列。
- 业务规则和权限最终裁决必须位于 Service/领域层；共享业务规则优先复用 `packages/*`。
- 数据库事务内禁止网络调用；跨聚合状态变化通过 `event_outbox` 和队列衔接。

## 实现约束

- 所有外部输入先按白名单 schema 转为 `unknown` 后校验；响应使用显式 DTO，禁止直接返回数据库实体。
- 路由鉴权统一使用 Guard/中间件；错误使用 `docs/06-api-queue-and-event-contract.md` §9 错误码，由全局 Filter 映射 HTTP。
- 按契约要求的写接口必须携带 `Idempotency-Key`；相同 key 与 payload 重放返回原结果，不同 payload 返回 `IDEMPOTENCY_CONFLICT`。
- 环境变量只能由 `src/config/` 的 typed loader 读取并在启动时校验；业务模块不得直接读取 `process.env` 或按环境散落分支。
- 日志使用结构化字段并携带 request/trace ID；禁止记录密钥、OTP、ticket、完整邮箱、邀请码、签名 URL、完整 prompt 或二进制内容。
- 限流 IP 只接受受信代理链解析的地址；客户端伪造的 `X-Forwarded-For`、`X-Real-IP`、`Forwarded` 不得改变限流身份。IPv6 按契约聚合。
- 邮件、Provider、DNS、对象存储和其他 HTTP 调用必须在事务外执行，并通过状态表/队列收敛结果。
- 模块间不得跨目录导入另一模块的持久化实现；通过公开 Service/端口或 `packages/*` 交互。

## 测试与验证

- 新增 Service 至少覆盖正常、失败和边界/幂等三类用例；状态机必须覆盖重放、并发或故障反例。
- 认证、权限、资金、幂等、队列和 Provider 变更必须补 Supertest 集成测试，不能只用 mock 单测证明。
- TypeScript 变更至少运行 API 包的 lint、typecheck、test；跨包或配置变更还需运行 `pnpm check` 和 `pnpm build`。
- 无法运行的检查必须在交付说明中明确列出原因和残余风险，不得描述为已通过。

## 数据库操作

- schema、字段、索引和约束以 `docs/05-data-model-and-constraints.md` 为准，使用 Drizzle 生成向前迁移。
- 不手写业务 SQL，不修改、重命名或删除历史 migration；不得删库、重建库或执行 destructive reset，除非用户明确批准并确认目标为可丢弃环境。
