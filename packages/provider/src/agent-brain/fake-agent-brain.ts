import { skillGenerationIntent } from '@ecom-forge/shared';
import {
  agentSessionSummaryContentSchema,
  parseAgentBrainStepOutcome,
  type AgentBrainPort,
  type AgentBrainStepInput,
  type AgentBrainStepOutcome,
} from '@ecom-forge/agent';

function countInputTokens(input: AgentBrainStepInput) {
  return Math.max(
    1,
    Math.ceil(
      (input.current_message.length +
        JSON.stringify(input.session_summary ?? {}).length +
        input.loaded_skills.reduce((total, item) => total + item.content.length, 0)) /
        4,
    ),
  );
}

function requestedImageCount(message: string): {
  output_count: number;
  output_count_source: 'user_explicit' | 'skill_default';
} {
  const match = message.match(
    /(?:生成|做|出|来)\s*(\d+|一|两|二|三|四|五|六|七|八|九|十|十一|十二|十三|十四|十五|十六)\s*(?:张|幅|个)/u,
  );
  if (!match?.[1]) return { output_count: 1, output_count_source: 'skill_default' };
  const numerals: Record<string, number> = {
    一: 1,
    两: 2,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    十一: 11,
    十二: 12,
    十三: 13,
    十四: 14,
    十五: 15,
    十六: 16,
  };
  const token = match[1];
  const count = Number.isFinite(Number(token)) ? Number(token) : (numerals[token] ?? 1);
  return Number.isInteger(count) && count > 0 && count <= 16
    ? { output_count: count, output_count_source: 'user_explicit' }
    : { output_count: 1, output_count_source: 'skill_default' };
}

function fakeCreativePrompt(goal: string): string {
  return `${goal}. Use the authorized source evidence and the selected Skill's creative method. This is a deterministic test fixture, not an artistic evaluation.`;
}

export class DeterministicFakeAgentBrain implements AgentBrainPort {
  countInputTokens(input: AgentBrainStepInput): number {
    return countInputTokens(input);
  }

  async runStep(
    input: AgentBrainStepInput,
    context: Parameters<AgentBrainPort['runStep']>[1],
  ): Promise<AgentBrainStepOutcome> {
    await Promise.resolve();
    if (context.abortSignal.aborted) throw context.abortSignal.reason;
    if (context.deadline.getTime() <= Date.now()) throw new Error('AGENT_REQUEST_TIMEOUT');
    const measuredUsage = { input_tokens: countInputTokens(input), output_tokens: 24 };
    const optional = input.optional_auxiliary_catalog[0];
    const requestedAuxiliary =
      input.current_message.includes('[load-optional]') ||
      input.current_message.includes('[load-reference]');
    const previousUserMessage = [...(input.transcript_messages ?? [])]
      .reverse()
      .find((message) => message.type === 'user_message' && !message.current);
    const previousUserContent =
      previousUserMessage &&
      'content' in previousUserMessage &&
      typeof previousUserMessage.content === 'string'
        ? previousUserMessage.content
        : '';
    const s12GenerationRequested =
      input.current_message.startsWith('[s12-generate]') ||
      (input.confirmed_product_facts !== undefined &&
        previousUserContent.startsWith('[s12-generate]'));
    const s13aGenerationRequested = input.current_message.startsWith('[s13a-generate]');
    const alreadyLoaded = optional
      ? input.loaded_skills.some((skill) => skill.skill_id === optional.skill_id)
      : true;
    if (requestedAuxiliary && optional && !alreadyLoaded) {
      return parseAgentBrainStepOutcome({
        type: 'tool_calls',
        calls: [
          {
            call_id: `load-${optional.skill_id}`,
            name: 'load_skill@1',
            arguments: { skill_id: optional.skill_id, view: 'planning' },
          },
        ],
        usage: measuredUsage,
      });
    }
    const referenceLoaded = (input.transcript_messages ?? []).some(
      (message) =>
        message.type === 'tool_result' &&
        message.name === 'load_skill@1' &&
        message.status === 'succeeded' &&
        typeof message.result === 'object' &&
        message.result !== null &&
        'view' in message.result &&
        message.result.view === 'references',
    );
    if (
      input.current_message.includes('[load-reference]') &&
      optional &&
      alreadyLoaded &&
      !referenceLoaded
    ) {
      return parseAgentBrainStepOutcome({
        type: 'tool_calls',
        calls: [
          {
            call_id: `reference-${optional.skill_id}`,
            name: 'load_skill@1',
            arguments: {
              skill_id: optional.skill_id,
              view: 'references',
              reference_paths: ['references/composition.md'],
            },
          },
        ],
        usage: measuredUsage,
      });
    }
    if (input.current_message.startsWith('[clarify]')) {
      return parseAgentBrainStepOutcome({
        type: 'request_clarification',
        question: '请补充你希望突出的人物、商品或视觉氛围。',
        suggestions: ['突出商品', '突出人物', '强调氛围'],
        usage: measuredUsage,
      });
    }
    if (s12GenerationRequested) {
      const source = input.authorized_images.find((image) => image.role === 'product');
      if (source && !input.confirmed_product_facts) {
        return parseAgentBrainStepOutcome({
          type: 'request_product_facts',
          source_binding_key: source.binding_key,
          candidate_facts: {
            product_name: '蓝色陶瓷杯',
            primary_colors: ['蓝色'],
            logos: [],
            visible_text: [],
            materials: ['陶瓷'],
            must_preserve: ['杯体轮廓', '蓝色釉面'],
            unknown_fields: ['品牌'],
          },
          evidence: [
            { field: 'product_name', observation: '画面主体为单只陶瓷杯。' },
            { field: 'primary_colors', observation: '杯体可见主色为蓝色。' },
            { field: 'materials', observation: '表面反光与杯体形态符合陶瓷材质。' },
          ],
          usage: measuredUsage,
        });
      }
      if (input.confirmed_product_facts) {
        return parseAgentBrainStepOutcome({
          type: 'candidate_plan',
          plan: {
            schema_version: 1,
            intent: { kind: 'commerce_generate', confidence: 0.99 },
            skill_id: input.skill_selection.primary_skill_id,
            source: 'chat',
            nodes: [
              {
                candidate_key: 'generate-main',
                capability: 'image.edit',
                capability_version: 1,
                depends_on: [],
                input_bindings: [input.confirmed_product_facts.source_binding_key],
                params: {
                  goal_summary: '在保留已确认商品事实的前提下生成干净商品图',
                  creative_prompt: '保留已确认商品事实，生成干净、主体明确的商品图。',
                  ...(input.generation_preferences?.aspect_ratio === 'auto'
                    ? { aspect_ratio: input.generation_preferences.supported_aspect_ratios[0] }
                    : {}),
                  ...requestedImageCount(input.current_message),
                },
                expected_output: 'image',
              },
            ],
          },
          usage: measuredUsage,
        });
      }
    }
    if (s13aGenerationRequested) {
      const sessionOutput = input.authorized_images.find(
        (image) => image.candidate_kind === 'latest_output',
      );
      const linkedOriginal = sessionOutput?.lineage_source_binding_keys
        ?.map((key) => input.authorized_images.find((image) => image.binding_key === key))
        .find((image) => image?.candidate_kind === 'original_source');
      const restartOriginal =
        input.current_message.includes('[restart-original]') && linkedOriginal;
      const selectedImages = sessionOutput
        ? restartOriginal
          ? [linkedOriginal]
          : [sessionOutput]
        : input.authorized_images;
      const bindingKeys = selectedImages.map((image) => image.binding_key);
      const editRequested = selectedImages.some((image) => image.role === 'edit_source');
      const skillId = input.skill_selection.primary_skill_id;
      const policy = input.skill_selection.execution_policy;
      const intent = editRequested
        ? 'chat_artifact_edit'
        : policy
          ? skillGenerationIntent(policy, bindingKeys.length)
          : 'raw_asset_generate';
      const route = {
        intent,
        capability: intent === 'creative_generate' ? 'image.generate' : 'image.edit',
      };
      const goal = input.current_message.slice('[s13a-generate]'.length).trim();
      const autoRatios =
        input.generation_preferences?.aspect_ratio === 'auto'
          ? input.generation_preferences.supported_aspect_ratios
          : [];
      const autoAspectRatio = (index: number) =>
        autoRatios.length > 0 ? { aspect_ratio: autoRatios[index % autoRatios.length]! } : {};
      const nodes =
        policy?.family === 'independent_sources' && !editRequested
          ? selectedImages.map((image, index) => ({
              candidate_key: `scene-${index + 1}`,
              capability: 'image.edit' as const,
              capability_version: 1 as const,
              depends_on: [],
              input_bindings: [image.binding_key],
              params: {
                goal_summary: `${goal}（第 ${index + 1} 张源图）`,
                ...autoAspectRatio(index),
                creative_prompt: fakeCreativePrompt(`${goal} (source ${index + 1})`),
                output_count: 1,
                output_count_source: 'user_explicit' as const,
                semantic_summary: `保留第 ${index + 1} 张授权照片中可观察的主体关系与动作证据，建立新构图。`,
                creative_note: `第 ${index + 1} 张作品使用独立源图与独立提示词。`,
              },
              expected_output: 'image' as const,
            }))
          : [
              {
                candidate_key: editRequested ? 'edit-main' : 'generate-main',
                capability: route.capability,
                capability_version: 1 as const,
                depends_on: [],
                input_bindings: bindingKeys,
                params: {
                  goal_summary: goal,
                  ...autoAspectRatio(0),
                  creative_prompt: fakeCreativePrompt(goal),
                  ...(policy?.family === 'optional_references' ||
                  policy?.family === 'reference_composition'
                    ? { output_count: 1, output_count_source: 'skill_default' as const }
                    : requestedImageCount(input.current_message)),
                  ...(policy?.family === 'identity_edit' && !editRequested
                    ? { changed_items: ['lighting', 'composition', 'color_balance'] }
                    : {}),
                  ...(policy?.family === 'reference_composition' && !editRequested
                    ? { creative_note: '今天没有失控，只是生活比闹钟早一步进入了缓冲。' }
                    : {}),
                  ...(editRequested
                    ? {
                        changed_items: ['按本轮指令调整画面'],
                        preserved_items: ['父产物主体关系与未要求改变的内容'],
                      }
                    : {}),
                },
                expected_output: 'image' as const,
              },
            ];
      return parseAgentBrainStepOutcome({
        type: 'candidate_plan',
        plan: {
          schema_version: 1,
          intent: { kind: route.intent, confidence: 0.99 },
          skill_id: skillId,
          source: 'chat',
          ...(sessionOutput
            ? restartOriginal
              ? {
                  source_decision: {
                    mode: 'restart_original' as const,
                    output_binding_key: sessionOutput.binding_key,
                    original_source_binding_key: linkedOriginal.binding_key,
                    reason_summary: '测试请求要求从与当前成图关联的原始源图重新开始。',
                  },
                }
              : {
                  source_decision: {
                    mode: 'refine_latest' as const,
                    output_binding_key: sessionOutput.binding_key,
                    reason_summary: '测试请求可继续使用当前成图中仍存在的视觉证据。',
                  },
                }
            : {}),
          nodes,
        },
        usage: measuredUsage,
      });
    }
    if (input.current_message.startsWith('[candidate-plan]')) {
      return parseAgentBrainStepOutcome({
        type: 'candidate_plan',
        plan: {
          schema_version: 1,
          intent: { kind: 'creative_generate', confidence: 0.99 },
          skill_id: input.skill_selection.primary_skill_id,
          source: 'chat',
          nodes: [
            {
              candidate_key: 'generate-main',
              capability: 'image.generate',
              capability_version: 1,
              depends_on: [],
              input_bindings: [],
              expected_output: 'image',
              params: {
                goal_summary: 'Generate the requested image',
                creative_prompt: 'A minimal studio composition.',
                output_count: 1,
                output_count_source: 'skill_default',
              },
            },
          ],
        },
        usage: measuredUsage,
      });
    }
    if (input.current_message.startsWith('[refuse]')) {
      return parseAgentBrainStepOutcome({
        type: 'respond',
        text: '这个请求无法安全执行。请调整要求并仅使用你有权提供的素材和事实。',
        usage: measuredUsage,
      });
    }
    return parseAgentBrainStepOutcome({
      type: 'respond',
      text: `已结合“${input.skill_selection.primary_name}”整理当前创作方向。正式生图会在图片执行管线启用后执行。`,
      usage: measuredUsage,
    });
  }

  async summarizeSession(
    input: Parameters<NonNullable<AgentBrainPort['summarizeSession']>>[0],
    context: Parameters<NonNullable<AgentBrainPort['summarizeSession']>>[1],
  ) {
    await Promise.resolve();
    if (context.abortSignal.aborted) throw context.abortSignal.reason;
    const userMessages = [
      ...input.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content.trim()),
      ...(input.transcript_items ?? [])
        .filter((item) => item.type === 'user_message')
        .map((item) => item.content.trim()),
    ].filter(Boolean);
    const previous = input.previous_summary;
    return {
      summary: agentSessionSummaryContentSchema.parse({
        goals: [...(previous?.goals ?? []), ...userMessages.slice(-2)].slice(-8),
        confirmed_preferences: previous?.confirmed_preferences ?? [],
        constraints: previous?.constraints ?? [],
        key_decisions: previous?.key_decisions ?? [],
        open_questions: previous?.open_questions ?? [],
      }),
      usage: {
        input_tokens: Math.max(1, Math.ceil(JSON.stringify(input).length / 4)),
        output_tokens: 24,
      },
    };
  }
}
