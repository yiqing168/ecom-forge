# Packages 子工程说明

## 通用规则

- packages 是可复用领域模块，不得依赖 `apps/*`，不得读取前端状态或框架 request 对象。
- 导出面保持最小且显式；共享契约放 `types`，无副作用工具放 `shared`，不建立循环依赖。
- 外部输入使用 `unknown` 加 schema 校验；`agent/compiler/credit/provider` 禁止显式 `any`。
- package 不自行发明状态、错误码、队列 payload、表字段或计价语义，必须追溯到 `01-06`。

## 领域边界

- `db`：仅 schema/migration/seed；严格对齐 `05`，迁移向前兼容且不可改历史。
- `types`：纯类型、DTO、枚举、事件，不导入有副作用模块。
- `shared`：纯函数，不访问 DB、Redis、Provider、文件系统或环境变量。
- `agent`：turn/context/tool loop/Skill runtime；实现预算、同参重复和 no-progress 防护，不做费用裁决。
- `compiler`：确定性校验 R1-R5、引用授权、DAG、模型准入和费用条件；LLM 输出始终不可信。
- `credit`：唯一资金写入口；ledger 不可变、操作幂等、事务可 replay，必须覆盖并发。
- `provider`：adapter、能力探测、三态回执、成本快照、限流熔断；请求日志必须脱敏。
- `queue`：稳定队列名、payload、jobId 和调度基础；不把 attempts 映射为业务重试。
- `skills`：L0/L1/L2 渐进加载；`.md` 引用必须做规范化、根目录限制、循环和深度检查并固化快照。

## 验证

- 纯逻辑写单元测试；DB/Redis/资金边界写真实集成测试。
- 公共导出变化必须检查所有消费者并补类型/契约测试。
- 高风险 package 的失败、重复、并发、超时和恢复路径必须有反例测试。
