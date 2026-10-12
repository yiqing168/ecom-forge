import {
  AgentBrainCallError,
  type AgentBrainModelSnapshot,
  type AgentBrainStepInput,
  type AgentBrainStepOutcome,
} from '@ecom-forge/agent';
import { calculateAgentBrainActualCost, VercelAiAgentBrain } from '@ecom-forge/provider';
import { addMoney, canonicalSha256 } from '@ecom-forge/shared';

export interface AgentBrainPocCaseResult {
  name: 'respond' | 'clarification' | 'candidate_plan' | 'tool_call' | 'reference_call';
  status: 'passed' | 'failed' | 'outcome_unknown';
  outcomeType?: AgentBrainStepOutcome['type'];
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  actualCostCny?: string;
  evidenceDigest: string;
}

export interface AgentBrainPocReport {
  schema_version: 1;
  adapter_key: string;
  provider: string;
  model_id: string;
  version: string;
  model_snapshot_id: string;
  credential_version_id: string;
  call_count: number;
  total_actual_cost_cny: string;
  status: 'passed' | 'failed' | 'outcome_unknown';
  cases: AgentBrainPocCaseResult[];
  evidence_digest: string;
}

interface PocCase {
  name: AgentBrainPocCaseResult['name'];
  message: string;
  expectedType: AgentBrainStepOutcome['type'];
  input: Partial<AgentBrainStepInput>;
  expectedToolCall?: {
    skillId: string;
    view: 'planning' | 'references';
    referencePaths: string[];
  };
}

const cases: readonly PocCase[] = [
  {
    name: 'respond',
    message: '请直接简短回答：已理解当前创作目标。',
    expectedType: 'respond',
    input: {},
  },
  {
    name: 'clarification',
    message: '信息不足，请只提出一个必要的澄清问题。',
    expectedType: 'request_clarification',
    input: {},
  },
  {
    name: 'candidate_plan',
    message: '请为一张 1:1 的简洁商品主图提出候选执行计划。',
    expectedType: 'candidate_plan',
    input: {},
  },
  {
    name: 'tool_call',
    message: '当前需要类目知识，请只加载允许的辅助 Skill。',
    expectedType: 'tool_calls',
    input: {
      optional_auxiliary_catalog: [
        { skill_id: 'commerce-shared-visual@1.0.0', name: '共享电商视觉' },
      ],
      enabled_tools: [
        { name: 'load_skill', contract_version: 1, description: '加载允许的辅助知识' },
      ],
    },
  },
  {
    name: 'reference_call',
    message: '想做三张有故事感但方向还很宽泛的图。请遵循已加载 Skill，只执行下一步必要的知识加载。',
    expectedType: 'tool_calls',
    input: {
      loaded_skills: [
        {
          skill_id: 'creative-free-generation@1.0.1',
          resource_path: 'SKILL.md',
          name: '自由创作',
          content:
            '当请求只有宽泛审美词或需要两张以上输出时，必须先读取 references/visual-decision-method.md，再形成候选计划。',
        },
      ],
      enabled_tools: [
        {
          name: 'load_skill',
          contract_version: 1,
          description: '加载已选 Skill 的一跳 Reference',
        },
      ],
    },
    expectedToolCall: {
      skillId: 'creative-free-generation@1.0.1',
      view: 'references',
      referencePaths: ['references/visual-decision-method.md'],
    },
  },
];

export class AgentBrainPocService {
  constructor(
    private readonly allowedRelayOrigins: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(input: {
    apiKey: string;
    baseUrl: string;
    snapshot: AgentBrainModelSnapshot;
    maxCalls: number;
    timeoutMs: number;
    traceId: string;
  }): Promise<AgentBrainPocReport> {
    const runtime = input.snapshot.runtime;
    if (!input.snapshot.snapshot_id || !runtime)
      throw new Error('AGENT_BRAIN_POC_SNAPSHOT_INVALID');
    if (!Number.isInteger(input.maxCalls) || input.maxCalls < cases.length || input.maxCalls > 5) {
      throw new Error('AGENT_BRAIN_POC_CALL_LIMIT_INVALID');
    }
    const brain = new VercelAiAgentBrain(
      input.apiKey,
      input.baseUrl,
      this.allowedRelayOrigins,
      this.fetchImpl,
    );
    const results: AgentBrainPocCaseResult[] = [];
    let totalCost = '0.00';
    for (const [index, testCase] of cases.entries()) {
      const result = await this.runCase(brain, input, testCase, index + 1);
      results.push(result);
      if (result.actualCostCny) totalCost = addMoney(totalCost, result.actualCostCny);
      if (result.status !== 'passed') break;
    }
    const status: AgentBrainPocReport['status'] = results.some(
      (result) => result.status === 'outcome_unknown',
    )
      ? 'outcome_unknown'
      : results.length === cases.length && results.every((result) => result.status === 'passed')
        ? 'passed'
        : 'failed';
    const evidence = {
      adapter_key: runtime.adapter_key,
      provider: input.snapshot.provider,
      model_id: input.snapshot.model_id,
      version: input.snapshot.version,
      model_snapshot_id: input.snapshot.snapshot_id,
      credential_version_id: runtime.credential_version_id,
      call_count: results.length,
      total_actual_cost_cny: totalCost,
      status,
      cases: results,
    };
    return {
      schema_version: 1,
      ...evidence,
      evidence_digest: canonicalSha256(evidence),
    };
  }

  private async runCase(
    brain: VercelAiAgentBrain,
    input: {
      snapshot: AgentBrainModelSnapshot;
      timeoutMs: number;
      traceId: string;
    },
    testCase: PocCase,
    callNo: number,
  ): Promise<AgentBrainPocCaseResult> {
    try {
      const outcome = await brain.runStep(buildInput(testCase), {
        abortSignal: AbortSignal.timeout(input.timeoutMs),
        deadline: new Date(Date.now() + input.timeoutMs),
        idempotencyKey: canonicalSha256({
          trace_id: input.traceId,
          case: testCase.name,
          call_no: callNo,
        }),
        modelSnapshot: input.snapshot,
        requestedMaxOutputTokens: 512,
        traceId: input.traceId,
      });
      const actualCostCny = calculateAgentBrainActualCost({
        pricing: input.snapshot.pricing,
        inputTokens: outcome.usage.input_tokens,
        ...(outcome.usage.cached_input_tokens !== undefined
          ? { cachedInputTokens: outcome.usage.cached_input_tokens }
          : {}),
        outputTokens: outcome.usage.output_tokens,
      });
      const usage = {
        input_tokens: outcome.usage.input_tokens,
        cached_input_tokens: outcome.usage.cached_input_tokens ?? 0,
        output_tokens: outcome.usage.output_tokens,
      };
      if (outcome.type !== testCase.expectedType) {
        return failure(testCase.name, 'failed', 'AGENT_BRAIN_POC_OUTCOME_TYPE_INVALID', {
          usage,
          actualCostCny,
        });
      }
      if (testCase.expectedToolCall) {
        const call = outcome.type === 'tool_calls' ? outcome.calls[0] : undefined;
        const args = call?.arguments;
        if (
          outcome.type !== 'tool_calls' ||
          outcome.calls.length !== 1 ||
          call?.name !== 'load_skill@1' ||
          args?.skill_id !== testCase.expectedToolCall.skillId ||
          args.view !== testCase.expectedToolCall.view ||
          !Array.isArray(args.reference_paths) ||
          canonicalSha256(args.reference_paths) !==
            canonicalSha256(testCase.expectedToolCall.referencePaths)
        ) {
          return failure(testCase.name, 'failed', 'AGENT_BRAIN_POC_REFERENCE_CALL_INVALID', {
            usage,
            actualCostCny,
          });
        }
      }
      return {
        name: testCase.name,
        status: 'passed',
        outcomeType: outcome.type,
        usage,
        actualCostCny,
        evidenceDigest: canonicalSha256({
          name: testCase.name,
          outcome_type: outcome.type,
          usage,
          actual_cost_cny: actualCostCny,
        }),
      };
    } catch (error) {
      return failure(
        testCase.name,
        error instanceof AgentBrainCallError && error.delivery === 'outcome_unknown'
          ? 'outcome_unknown'
          : 'failed',
        error instanceof AgentBrainCallError ? error.message : 'AGENT_BRAIN_POC_FAILED',
      );
    }
  }
}

function buildInput(testCase: PocCase): AgentBrainStepInput {
  return {
    execution_format: 'transcript_v1',
    current_message: testCase.message,
    authorized_images: [],
    skill_selection: {
      primary_skill_id: 'creative-free-generation@1.0.1',
      default_output_count: 1,
      primary_name: '自由创作',
      preset_names: [],
      required_capabilities: ['image.generate'],
    },
    loaded_skills: [],
    required_auxiliary_catalog: [],
    optional_auxiliary_catalog: [],
    observations: [],
    enabled_tools: [],
    remaining_budget: { rounds: 1, tool_calls: 4, input_tokens: 96_000, output_tokens: 8_192 },
    ...testCase.input,
  };
}

function failure(
  name: AgentBrainPocCaseResult['name'],
  status: 'failed' | 'outcome_unknown',
  code: string,
  billing?: Pick<AgentBrainPocCaseResult, 'usage' | 'actualCostCny'>,
): AgentBrainPocCaseResult {
  return {
    name,
    status,
    ...billing,
    evidenceDigest: canonicalSha256({ name, status, code, ...billing }),
  };
}
