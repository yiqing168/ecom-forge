import type { Database } from '@ecom-forge/db';

import { AgentTurnLeaseRepository } from './agent-turn-lease.repository.js';
import { AgentTurnTerminalRepository } from './agent-turn-terminal.repository.js';
import { AgentTurnToolRepository } from './agent-turn-tool.repository.js';
import { AgentTurnActivityRepository } from './agent-turn-activity.repository.js';
import { AgentTurnDraftRepository } from './agent-turn-draft.repository.js';

export type { ClaimedAgentTurn } from './agent-turn.types.js';

export class AgentTurnRepository {
  private readonly lease: AgentTurnLeaseRepository;
  private readonly terminal: AgentTurnTerminalRepository;
  private readonly tool: AgentTurnToolRepository;
  private readonly activity: AgentTurnActivityRepository;
  private readonly draft: AgentTurnDraftRepository;

  constructor(database: Database) {
    this.lease = new AgentTurnLeaseRepository(database);
    this.terminal = new AgentTurnTerminalRepository(database);
    this.tool = new AgentTurnToolRepository(database);
    this.activity = new AgentTurnActivityRepository(database);
    this.draft = new AgentTurnDraftRepository(database);
  }

  claim(input: Parameters<AgentTurnLeaseRepository['claim']>[0]) {
    return this.lease.claim(input);
  }

  activeLeaseRetryAt(input: Parameters<AgentTurnLeaseRepository['activeLeaseRetryAt']>[0]) {
    return this.lease.activeLeaseRetryAt(input);
  }

  renew(input: Parameters<AgentTurnLeaseRepository['renew']>[0]) {
    return this.lease.renew(input);
  }

  releaseForRetry(input: Parameters<AgentTurnLeaseRepository['releaseForRetry']>[0]) {
    return this.lease.releaseForRetry(input);
  }

  persistContext(input: Parameters<AgentTurnLeaseRepository['persistContext']>[0]) {
    return this.lease.persistContext(input);
  }

  startActivity(input: Parameters<AgentTurnActivityRepository['start']>[0]) {
    return this.activity.start(input);
  }

  finishActivity(input: Parameters<AgentTurnActivityRepository['finish']>[0]) {
    return this.activity.finish(input);
  }

  appendResponseDraft(input: Parameters<AgentTurnDraftRepository['append']>[0]) {
    return this.draft.append(input);
  }

  clearResponseDraft(input: Parameters<AgentTurnDraftRepository['clear']>[0]) {
    return this.draft.clear(input);
  }

  finishTool(input: Parameters<AgentTurnToolRepository['finishTool']>[0]) {
    return this.tool.finishTool(input);
  }

  finishImageInspection(input: Parameters<AgentTurnToolRepository['finishImageInspection']>[0]) {
    return this.tool.finishImageInspection(input);
  }

  finishToolFailure(input: Parameters<AgentTurnToolRepository['finishToolFailure']>[0]) {
    return this.tool.finishToolFailure(input);
  }

  recordIllegalToolBatch(input: Parameters<AgentTurnToolRepository['recordIllegalToolBatch']>[0]) {
    return this.tool.recordIllegalToolBatch(input);
  }

  startKnowledgeActivity(input: Parameters<AgentTurnToolRepository['startKnowledgeActivity']>[0]) {
    return this.tool.startKnowledgeActivity(input);
  }

  finishKnowledgeActivity(
    input: Parameters<AgentTurnToolRepository['finishKnowledgeActivity']>[0],
  ) {
    return this.tool.finishKnowledgeActivity(input);
  }

  completeResponse(input: Parameters<AgentTurnTerminalRepository['completeResponse']>[0]) {
    return this.terminal.completeResponse(input);
  }

  recordPublicTextRejection(
    input: Parameters<AgentTurnTerminalRepository['recordPublicTextRejection']>[0],
  ) {
    return this.terminal.recordPublicTextRejection(input);
  }

  recordKnowledgeRequirement(
    input: Parameters<AgentTurnTerminalRepository['recordKnowledgeRequirement']>[0],
  ) {
    return this.terminal.recordKnowledgeRequirement(input);
  }

  recordProductFactsUnavailable(
    input: Parameters<AgentTurnTerminalRepository['recordProductFactsUnavailable']>[0],
  ) {
    return this.terminal.recordProductFactsUnavailable(input);
  }

  requestClarification(input: Parameters<AgentTurnTerminalRepository['requestClarification']>[0]) {
    return this.terminal.requestClarification(input);
  }

  requestProductFacts(input: Parameters<AgentTurnTerminalRepository['requestProductFacts']>[0]) {
    return this.terminal.requestProductFacts(input);
  }

  beginAuthoring(input: Parameters<AgentTurnTerminalRepository['beginAuthoring']>[0]) {
    return this.terminal.beginAuthoring(input);
  }
  saveAuthoringBatch(input: Parameters<AgentTurnTerminalRepository['saveAuthoringBatch']>[0]) {
    return this.terminal.saveAuthoringBatch(input);
  }

  block(input: Parameters<AgentTurnTerminalRepository['block']>[0]) {
    return this.terminal.block(input);
  }
}
