import { randomUUID } from 'node:crypto';

import { QueuePayloadError, parseQueuePayload, queueNameForJobType } from '@ecom-forge/queue';
import type { QueueIntentRepository } from '@ecom-forge/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import type { QueuePublisher } from './queue-publisher.js';
import type { WorkerLifecycleLogger } from '../lifecycle/worker-lifecycle.js';

export interface DispatchSummary {
  claimed: number;
  dispatched: number;
  retryScheduled: number;
  poisonCancelled: number;
  ownerLost: number;
}

export function dispatchBackoffMs(input: {
  attemptCount: number;
  baseMs: number;
  maxMs: number;
  random?: () => number;
}): number {
  const exponent = Math.min(Math.max(input.attemptCount, 0), 30);
  const capped = Math.min(input.maxMs, input.baseMs * 2 ** exponent);
  const jitter = 0.5 + (input.random ?? Math.random)();
  return Math.max(input.baseMs, Math.min(input.maxMs, Math.round(capped * jitter)));
}

function errorCode(error: unknown): string {
  if (error instanceof QueuePayloadError) return error.code;
  return 'QUEUE_ADD_FAILED';
}

export class QueueDispatcher {
  private acceptingClaims = true;

  constructor(
    private readonly intents: QueueIntentRepository,
    private readonly publisher: QueuePublisher,
    private readonly config: WorkerConfig,
    private readonly canWrite: () => boolean = () => true,
    private readonly logger?: WorkerLifecycleLogger,
  ) {}

  pauseClaims(): void {
    this.acceptingClaims = false;
  }

  resumeClaims(): void {
    this.acceptingClaims = true;
  }

  async dispatchOnce(now = new Date()): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      claimed: 0,
      dispatched: 0,
      retryScheduled: 0,
      poisonCancelled: 0,
      ownerLost: 0,
    };
    if (!this.acceptingClaims) return summary;

    const owner = randomUUID();
    const claimed = await this.intents.claimPending({
      owner,
      now,
      leaseMs: this.config.dispatchLeaseMs,
      limit: this.config.dispatchBatchSize,
    });
    summary.claimed = claimed.length;
    for (const intent of claimed) {
      const owner = intent.leaseOwner;
      if (!owner) {
        summary.ownerLost += 1;
        continue;
      }
      let leaseLost = false;
      let renewalInFlight: Promise<void> | undefined;
      const renewalIntervalMs = this.config.dispatchLeaseRenewMs;
      const renewLease = async (): Promise<void> => {
        if (leaseLost || !this.canWrite()) {
          leaseLost = true;
          return;
        }
        try {
          const renewed = await this.intents.renewLease({
            id: intent.id,
            owner,
            now: new Date(),
            leaseMs: this.config.dispatchLeaseMs,
          });
          if (!renewed) leaseLost = true;
        } catch {
          leaseLost = true;
        }
      };
      const renewalTimer =
        typeof renewalIntervalMs === 'number' && renewalIntervalMs > 0
          ? setInterval(() => {
              renewalInFlight ??= renewLease().finally(() => {
                renewalInFlight = undefined;
              });
            }, renewalIntervalMs)
          : undefined;
      renewalTimer?.unref();
      try {
        const payload = parseQueuePayload(intent.payload);
        if (
          payload.schema_version !== intent.payloadVersion ||
          queueNameForJobType(payload.job_type) !== intent.queueName
        ) {
          throw new QueuePayloadError(
            'QUEUE_PAYLOAD_INVALID',
            'Persisted queue intent metadata does not match its payload',
          );
        }
        await this.publisher.add(intent.queueName, intent.jobId, payload);
        if (!this.canWrite() || leaseLost) {
          summary.ownerLost += 1;
          continue;
        }
        const marked = await this.intents.markDispatched({ id: intent.id, owner, now: new Date() });
        if (marked) summary.dispatched += 1;
        else summary.ownerLost += 1;
      } catch (error) {
        if (!this.canWrite() || leaseLost) {
          summary.ownerLost += 1;
          continue;
        }
        const code = errorCode(error);
        this.logger?.error({
          event: 'queue_dispatch_failed',
          queue_name: intent.queueName,
          intent_id: intent.id,
          job_id: intent.jobId,
          attempt_count: intent.attemptCount,
          error_code: code,
          error_name: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
          error_message: error instanceof Error ? error.message : 'Unknown queue dispatch error',
        });
        if (error instanceof QueuePayloadError) {
          const cancelled = await this.intents.cancelPoison({
            id: intent.id,
            owner,
            now: new Date(),
            errorCode: code,
          });
          if (cancelled) summary.poisonCancelled += 1;
          else summary.ownerLost += 1;
          continue;
        }
        const delayMs = dispatchBackoffMs({
          attemptCount: intent.attemptCount,
          baseMs: this.config.dispatchBackoffBaseMs,
          maxMs: this.config.dispatchBackoffMaxMs,
        });
        const retryNow = new Date();
        const released = await this.intents.releaseForRetry({
          id: intent.id,
          owner,
          now: retryNow,
          nextAttemptAt: new Date(retryNow.getTime() + delayMs),
          errorCode: code,
        });
        if (released) summary.retryScheduled += 1;
        else summary.ownerLost += 1;
      } finally {
        if (renewalTimer) clearInterval(renewalTimer);
        if (renewalInFlight) await renewalInFlight;
      }
    }
    return summary;
  }
}
