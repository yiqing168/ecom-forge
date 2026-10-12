# S15 安全合规、验收脚本与中国/HK 上线

| 项     | 内容                                                                       |
| ------ | -------------------------------------------------------------------------- |
| 状态   | v0.1 可评审                                                                |
| 阶段   | 1A / D6                                                                    |
| 优先级 | P0                                                                         |
| 依赖   | S01-S12、S13A、S13B、S14A、S14B 已验收                                     |
| 目标   | 完成 1A 封闭内测上线门禁：安全、合规、验证脚本、监控、备份、香港部署和回滚 |

## 开工前必读

- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/09-validation-and-operations.md`
- `docs/10-engineering-architecture-and-deployment.md`
- `docs/spec/00-master-development-plan.md`
- `docs/spec/S11-agent-workbench-ui-loop.md`
- `docs/spec/S12-commerce-white-background-refine-e2e.md`
- `docs/spec/S13-creative-generation-and-chat-edit-e2e.md`
- `docs/spec/S13B-first-release-specialized-creative-skills-e2e.md`
- `docs/spec/S14-user-center-and-minimal-admin-console.md`
- `docs/spec/S14B-complete-operations-admin-console.md`

## 当前模块范围

包含签名 URL、密钥管理、审计、内容安全上线门禁、腾讯 COS 私有存储生产 adapter、删除保留期清理 Worker、validation、压测、监控告警、备份恢复、香港/中国部署 smoke、回滚手册和已批准的内测协议/隐私/素材授权/AI 风险页面发布校验；1A 不实现产品水印或 AI 标识，S15 不把两者作为上线验收项。S15 还必须验证 S11 正式发布的 11 个 1A primary、7 个热门类目和通用 auxiliary 均已由对应真实图片链路激活，不能用安装成功、fake Brain 或静态 catalog 代替。

1A 的 11 个 primary 验收集合固定为商品白底精修、自由创作、人像焕新、照片意象重绘、实景拼贴、实景拼贴·写意纸境、极简拼贴、实景转译·日常记忆页、叙事电影海报、日常反差海报和虚空线稿；7 个热门类目固定为服饰鞋包、美妆个护、食品饮料、家居生活、宠物用品、运动户外和数码配件。S15 不得按计数替换、遗漏或临时新增同义 Skill。

不包含公开支付上线和大陆 ICP 正式发布。

## 交付面

| 交付面 | 要求                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| 安全   | 签名 URL、权限、密钥、内容安全 Provider 配置与失败策略；确认图片发布未增加产品水印或 AI 标识 |
| 运维   | 香港服务器部署、Nginx、PM2/Docker、备份、回滚                                                |
| 测试   | validation、ledger、Provider PoC、SSE、load、smoke                                           |
| 监控   | 成功率、等待时长、成本、错误率、outcome_unknown、账本差异                                    |

### 生产私有存储门禁

- 交付 `packages/storage` 编译期注册的腾讯 COS 私有桶 adapter，运行时只从 S14A 的 `storage_runtime_state`、channel 和 active credential 解析，不读取长期 `COS_SECRET_*` 环境变量。
- 固定 probe 必须真实执行 put/head/read/range-read/delete，校验私有桶策略、服务端加密和签名能力，并保存 `s10-private-assets@1` evidence；失败或 outcome unknown 不得激活或切换 runtime。
- 新上传只使用当前 active channel；历史 asset/artifact 必须按各自 `storage_channel_id` 读取。通道切换、旧凭据保留、残留 probe 精确清理和回滚均需真实 COS smoke。
- staging/beta/production 在上述 adapter 与 smoke 未通过前 readiness fail closed；禁止 local adapter、公共读 bucket、任意 endpoint 或全桶/模糊 prefix 删除。
- 交付按 `08` 保留期扫描逻辑删除资产的清理 Worker。它只消费数据库中已到期且无活动引用/证据保留的精确对象 ID，按行固定的 `storage_channel_id` 删除原图和缩略图；禁止列桶后模糊删除、跨租户 prefix 删除或因切换通道去当前桶猜测对象。
- 对象删除为外部副作用，使用稳定 cleanup intent、lease 和三态结果；只有确认未发出可自动重试，outcome unknown 先 head/证据核验后收敛。数据库物理清理标记、对象删除证据和审计同一幂等流程推进，不得把超时伪装为已删除。
- 集成测试使用缩短保留期的隔离对象根，覆盖重复消费、对象已不存在、共享引用、活动任务引用、通道切换、部分删除、outcome unknown 和 Worker 崩溃恢复；不得为了测试改写正式保留期或清理开发目录。

### 内测法律文本发布门禁

- `apps/web` 必须提供用户可直接访问的用户协议、隐私政策、素材授权说明和 AI 生成风险说明；注册弹层链接到当前发布版本，不得使用空白页、占位文案或只在数据库保存版本号。
- 法律正文必须来自产品方提供并完成审查的版本化发布件，工程不得自行撰写法律结论。每个发布件固定 `kind/version/effective_at/content_digest`，注册请求的 `agreement_version` 必须与服务端 active 版本匹配并可追溯。
- 素材授权发布件必须显式覆盖首版人像/合照/第三方照片与可能涉及未成年人的输入，给出已审查的适用年龄、授权/监护人路径、允许用途、Provider 处理地域和删除/申诉规则；任一项尚未裁决时，S13A/S13B 对应人像 Skill 在 beta catalog 中 fail closed，而不是用通用勾选框推定授权。
- active 法律版本缺失、页面 digest 与服务端登记不一致或注册 UI 无法访问正文时，beta readiness 和新注册 fail closed；历史用户的同意版本不可被新正文追改。
- 关闭服务/删除申请在 1A 可使用明确的人工联系入口和可追踪工单，不要求本轮发明即时账户物理删除；但入口、处理人、时间、身份核验和处置结果必须可审计，并遵守 `08` 的保留期。

## 命令与压测目标

必须执行总计划“验收脚本归属表”中截至 S15 的全部 `validate:*` 命令，至少显式包含 `validate:skill-content`、`validate:golden-eval-gate`、`validate:image-pipeline`、`validate:creative-chat`、`validate:specialized-skills`、`validate:operations-control-plane`、`validate:smoke` 和聚合入口 `validate:stage0`；缺少命令、零匹配用例或 `--passWithNoTests` 均算失败。真实 Provider/Brain PoC 命令和 S12/S13A/S13B/S14B live 浏览器命令同样必须执行，但不得混入普通 CI。最后执行 `pnpm check`、`pnpm db:check`、`pnpm test:e2e` 与 `pnpm test:load`。1A beta 压测通过标准：

- 50 个并发用户、100 个并发 turn 创建。
- quote submit P95 小于 500ms，SSE 建连 P95 小于 1s。
- 数据库连接数低于实例上限的 70%。
- fake Provider 延迟场景下 worker 可持续消费，且零账本不一致。

## 上线规则

- 只允许封闭内测，不开放支付，不公开推广。
- 香港部署不等于免合规；隐私、内容安全和服务条款仍要完成，法律页面不得声称未实现的 AI 标识能力。
- 生成前文本审核和生成后图片审核必须已由 S07/S12/S13A/S13B 跑通。审核 Provider 不可用时，付费生成请求 fail closed；图片审核结果未知时隔离产物并进入人工处置，不能作为已完成结果交付。
- 生产邮件供应商、域名 SPF/DKIM、受控收件箱 smoke 和退信告警必须完成；环境变量由 `10` 的 `MAIL_*` 分组提供。
- 异常成本、失败率或账本差异达到阈值必须停止新任务。

## 验收清单

- [ ] S01-S12、S13A、S13B、S14A 和 S14B 全部通过。
- [ ] 11 个 1A primary、7 个热门电商类目及通用 auxiliary 均来自版本控制作者源码和可复现 `.skillpkg`，release/rollback、依赖闭包、来源权利和 `validate:skill-content` 通过。
- [ ] 白底精修和 10 个创意 primary 各至少一条真实浏览器成功链路；缺素材、Skill 错配、模型能力不足、内容拒绝、outcome unknown 和恢复路径 fail closed，不能回退到通用图生图冒充完成。
- [ ] S11 的真实 Agent Brain adapter/PoC 已通过 strict tool/terminal、usage、成本 exposure、超时 unknown 和人工审批；不能用 fake Brain 或静态回复代替。
- [ ] 所有测试和 validation 命令通过。
- [ ] 备份和回滚演练通过。
- [ ] 监控告警可触发。
- [ ] 内容安全拦截、隔离和人工处置演练通过；S12/S13A/S13B 发布结果未增加产品水印或 AI 标识。
- [ ] 腾讯 COS 私有存储 adapter、固定 probe、通道切换、历史对象读取和回滚 smoke 通过。
- [ ] 用户资产逻辑删除立即关闭访问；到期物理清理、引用保护、删除三态、审计和备份过期演练通过，无模糊/跨租户删除。
- [ ] 用户协议、隐私政策、素材授权和 AI 生成风险提示使用已发布版本；人像/第三方/未成年人素材政策已经产品与法务确认，注册同意版本可追溯，关闭服务/删除申请/申诉/人工联系路径经过合规验收。
- [ ] 生产邮件投递 smoke 通过。
- [ ] 1A feature-off smoke 证明视频/视频附件、批量、分享/我也要做、模板/做同款、会员购买、套图、平台 hard block 和画布不出现在导航、按钮或营销文案；受保护后置路由在未激活时 404/fail closed。
- [ ] 封闭内测 checklist 签字通过。
