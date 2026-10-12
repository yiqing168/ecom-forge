# S20 2A 配方模板市场与参考图库

| 项     | 内容                                                 |
| ------ | ---------------------------------------------------- |
| 状态   | v0.1 可评审                                          |
| 阶段   | 2A                                                   |
| 优先级 | P1                                                   |
| 目标   | 实现配方类模板市场、官方参考图库、我的收藏和模板解锁 |

## 开工前必读

- `docs/PRD-AI创作平台需求文档.md` 阶段 2A
- `docs/02-agent-and-skill-orchestration-contract.md`
- `docs/05-data-model-and-constraints.md`
- `docs/06-api-queue-and-event-contract.md`
- `docs/08-security-compliance-and-asset-lifecycle.md`
- `docs/design/01-full-site-screen-flow-spec.md`
- `docs/design/03-v0-full-site-ui-interaction-prompt.md`

## 当前模块范围

包含配方模板、官方参考图库、我的收藏、积分解锁、做同款入口。

不包含画布类模板，画布模板放 S25。

## 交付面

| 交付面   | 要求                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 前端/UI  | 模板列表、详情、解锁、收藏、参考图库选择                                   |
| 后端/API | template/reference list/detail、unlock、favorite、recipe instantiate       |
| 数据库   | templates 不可变版本、template_unlocks、reference_items、content_favorites |
| 测试     | 解锁幂等、权限、模板版本                                                   |

## 业务规则

- 模板版本不可原地覆盖。
- S20 前向 migration 按 `05` 补 `templates.template_key/title/status/published_at/owner_user_id`、`unique(template_key,version)`、`reference_items` 和 `content_favorites`；不得使用会误伤同类型多模板的 `unique(type,version)`。
- 按 `06` §4.2 实现模板/参考列表详情、解锁、收藏和配方实例化；实例化绑定精确 `template_id` 版本，下架版本不可新建任务。
- 解锁走积分账本。
- 参考图授权和来源必须可审计。

## 测试标准

- 实现并通过 `pnpm validate:template-unlock`，覆盖重复点击、模板版本、权限和积分账本幂等。

## 验收清单

- [ ] 模板可解锁并开新会话。
- [ ] 官方参考图库可选。
- [ ] 画布模板不在 2A 出现。
- [ ] 解锁不重复扣费。
