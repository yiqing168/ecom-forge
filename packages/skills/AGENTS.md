# Portable Skill contract

The Markdown file is the portable Skill. It uses the Codex-compatible frontmatter
`name` and `description`, followed by ordinary task knowledge: visual decisions,
working method, constraints, quality checks, and revision guidance.

Platform execution data is separate from the Markdown. The ecom-forge manifest may
store `skill_profiles` for catalog visibility, capabilities, input bindings, output
counts, presets, dependencies, references, and audit snapshots. A copied `SKILL.md`
must not require `candidate_plan`, `Provider`, `Compiler`, `Brain`, `Worker`,
`semantic_reference`, `image.edit`, or another platform tool/output protocol.

The model decides whether to answer, clarify, generate, or edit with the tools
available in its host Agent. The Skill supplies the creative method; the host Agent
supplies tool permissions, safety, billing, and result handling. There is no global
prompt order or target character count. Preserve the user's material decisions and
only organize them when that makes the image instruction easier to execute.

Images uploaded by the current user are treated as authorized inputs by default
when the server confirms ownership, readability, active lifecycle, content hash, and
supported image data. Cross-user, deleted, quarantined, unreadable, or changed data
continues to fail closed. A separate rights-confirmation fact is not required for a
normal user upload.

# Skills 包说明

- Skill 资源遵循 `02` 的 L0 元数据、L1 主 `SKILL.md`、L2 按需 references 渐进加载。
- Skill 拆分必须带来渐进加载或共享收益。只在部分任务动态需要的知识，或被多个 primary 共享的知识，才拆为 auxiliary/reference；某 primary 每次必读且不共享的知识必须直接写入主 `SKILL.md`。
- 复杂 primary 可按自身方法链使用稳定编号，使任务目标、输入证据、关键决策和质量门禁形成可追踪的完整路径。编号数量、章节名称和具体顺序由每个 Skill 自己决定，不把任何现有 Skill 的“一到十”固化为通用模板；平台执行边界由宿主和 manifest 负责，不写入可复制 Skill 的固定输出契约。
- 编排约定复用的是“先建立事实与目标，再作专业决策，最后形成可执行结果并自检边界”的思路，不复用固定标题、固定审美配方或固定章节数。简单 Skill 不为形式强制编号；同一 Skill 演进时应保持结构稳定，确需调整时同步版本记录和评测。
- `.md` 引用必须规范化并限制在 Skill 根目录，检测循环、深度、文件大小和总 token 预算。
- KV key 必须包含 Skill/version/resource path/content hash；外部发布版本不可原地覆盖。内置正文修改只需校验并重启 API/Worker，不手动同步 hash/byte_size 或递增版本；新增资源和宿主配置变化才修改 manifest，内容身份由实际 hash 快照记录。
- 运行时必须固化实际加载资源快照，不能只记录主 Skill 版本。
- Skill 内容不能直接触发收费或越权动作，候选计划仍需 compiler 校验。
