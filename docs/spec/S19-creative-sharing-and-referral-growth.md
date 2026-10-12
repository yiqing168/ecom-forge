# S19 2A 创意分享与邀请增长

| 项     | 内容                                                   |
| ------ | ------------------------------------------------------ |
| 状态   | v0.1 可评审                                            |
| 阶段   | 2A                                                     |
| 优先级 | P1                                                     |
| 目标   | 上线创意分享页、“我也要做”转化、撤回分享和邀请增长追踪 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` 阶段 2A
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/research/01-full-site-product-interaction-benchmark.md` §4.5、§4.7

## 当前模块范围

包含公开分享页、撤回分享、匿名访问隐私保护、举报入口、我也要做、注册转化归因。

不包含商品事实、原始素材、完整提示词公开。

## 交付面

| 交付面   | 要求                                                              |
| -------- | ----------------------------------------------------------------- |
| 前端/UI  | 分享页、撤回入口、举报入口、我也要做 CTA                          |
| 后端/API | share create/revoke、public share read/visit/report、运营举报处置 |
| 数据库   | shares、share_reports、visit logs、referral attribution           |
| 测试     | 隐私字段不泄露、撤回后不可访问                                    |

## 业务规则

- 创意分享默认不暴露原始素材、商品事实和完整提示词。
- 分享撤回立即失效。
- 做同款只能创建新会话和引用公开配方，不继承修改权。
- 分享页必须提供举报入口；匿名举报按 IP hash 限流，已登录举报按用户幂等。运营驳回或下架必须写 `admin_audit_logs`。
- 公开页按 `06` §4.2 使用 `GET /api/v1/public/shares/{share_slug}`；每次读取重新检查撤回、隔离和删除状态，只返回公开白名单字段。

## 测试标准

- 实现并通过 `pnpm validate:share-privacy`，覆盖隐私字段、撤回、举报防刷、运营处置和做同款权限。

## 验收清单

- [ ] 分享页可访问和撤回。
- [ ] 注册转化可追踪。
- [ ] 隐私字段不泄露。
- [ ] 做同款进入新会话。
- [ ] 举报可提交、限流并由运营审计处置。
