# Provider 包说明

- 所有文本/图片/审核 Provider 通过本包 adapter 接入，不在 API、Worker 或页面写厂商 SDK。
- 回执统一归一为 `not_dispatched/accepted/outcome_unknown`，不得用网络异常猜测未送达。
- adapter 必须支持稳定 idempotency key、连接/请求/下载超时、限流、熔断、降级和成本快照。
- 日志只保留脱敏摘要与 Provider request ID，不记录密钥、完整 prompt、签名 URL 或产物二进制。
- PoC 和自动测试使用受控预算或 fake adapter；收费路由只能使用 `03` 已批准模型。
