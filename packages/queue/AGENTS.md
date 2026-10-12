# Queue 包说明

- 队列名、job payload、版本和幂等键严格来自 `06`，job 类型放 payload，不创建第二套命名。
- `jobId` 使用稳定业务 ID；BullMQ attempts 不等于业务重试，也不裁决 Provider 是否可重投。
- 本包只提供队列连接、payload schema 和调度基础，不写账本、不自造任务状态。
- payload 变更必须考虑滚动发布期间新旧 Producer/Consumer 兼容，并提供 schema/契约测试。
- Redis 错误、重复入队、延迟任务、poison job 和优雅关闭必须有明确处理方式。
