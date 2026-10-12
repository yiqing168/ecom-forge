# Agent 包说明

- 本包负责 turn、上下文压缩、工具循环和 Skill runtime，以 `02` 为唯一行为契约。
- LLM 只能提出候选动作，任何收费、权限、引用和模型准入必须交给 compiler 确定性裁决。
- 必须限制单 turn LLM 往返、工具次数、token/成本预算，并检测同参重复与 no-progress loop。
- todo 和真实任务状态由引擎写入，LLM 只读；附件/OCR/引用内容一律视为不可信数据。
- 每次 LLM/tool step 都需可追溯模型、prompt/Skill 版本、token、延迟、成本和结果摘要。
