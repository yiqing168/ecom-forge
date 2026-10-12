# Worker 子工程说明

## 职责

- 本目录承载 BullMQ Processor、Provider 投递/轮询、产物后处理、评估、通知和 Cron。
- Worker 只按持久化状态推进，不把进程内存或队列 attempts 当业务真相。

## 实现约束

- job 名称、payload 和幂等键以 `06` 为准；`jobId` 使用稳定业务 ID。
- Processor 保持薄层，领域逻辑调用 packages；任何资金变更只能调用 `packages/credit`。
- Provider `accepted/outcome_unknown` 禁止自动重投，BullMQ attempts 只用于确定未送达且契约允许的基础设施错误。
- 每一步记录结构化 trace/run/task/attempt ID，不记录密钥、完整 prompt、签名 URL 或二进制。
- 取消、超时、租约、heartbeat 和 sweeper 必须可重入；进程崩溃后可从数据库恢复。

## 验证

- 使用真实 Redis/BullMQ 环境测试重复消费、进程重启、锁过期、并发 worker 和 poison job。
- Provider 测试默认使用 fake adapter，不调用真实付费模型。
- 变更至少运行本包 lint/typecheck/test:worker 和相关 validation。
