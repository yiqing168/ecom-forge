# DB 包说明

- Drizzle schema、migration、seed 和数据库连接检查归本包，字段与约束严格对齐 `05`。
- 不实现业务 Service，不从 schema 层直接调用 Provider、Queue 或 Credit。
- 用户数据表与高频查询必须落实 `user_id` 隔离和查询模式驱动索引。
- migration 只向前兼容；已提交或应用的 migration 不可修改、重命名或删除。
- 账本、reservation、workflow、task 变更必须有专项约束查询和空库迁移验证。
- 禁止未经用户明确批准执行 destructive reset、drop 或清空数据。
