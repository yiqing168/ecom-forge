# Credit 包说明

- 本包是唯一资金写入口，`credit_ledger` 是真相，account balance/frozen 只是可重建投影。
- quote、reservation、consume、release、refund 和 appeal_refund 必须遵循 `01/04/05`。
- 幂等键和唯一约束必须共同防重；reservation 与 workflow_run 按契约在同一事务创建。
- `accepted` 不得提前 release/refund；`outcome_unknown` 原 attempt 不得重投，未结算冻结只允许按 `04` 的 30 分钟自动超时规则释放，且不得把释放解释为 Provider 确定失败。
- 资金代码必须覆盖并发提交、重复回执、事务回滚、余额不足、部分结算和 ledger replay。
