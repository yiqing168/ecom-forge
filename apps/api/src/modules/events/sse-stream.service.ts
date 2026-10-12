import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import {
  encodeBusinessEvent,
  encodeControlEvent,
  EventContractError,
  projectPublicEvent,
} from './event-contract.js';
import { EventOutboxRepository } from './event-outbox.repository.js';
import type { EventStreamQuery } from './event-query.js';
import { EventWakeHub } from './event-wake.hub.js';
import { SseConnectionLimitError, SseConnectionRegistry } from './sse-connection.registry.js';

interface StreamRequest {
  once(event: 'aborted', listener: () => void): this;
  off(event: 'aborted', listener: () => void): this;
}

interface StreamResponse {
  statusCode: number;
  headersSent?: boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
  setHeader(name: string, value: string): void;
  flushHeaders?(): void;
  write(chunk: string): boolean;
  end(): void;
  once(event: 'close' | 'drain', listener: () => void): this;
  off(event: 'close' | 'drain', listener: () => void): this;
}

@Injectable()
export class SseStreamService {
  private readonly logger = new Logger(SseStreamService.name);
  private readonly telemetryKey = randomBytes(32);
  private readonly connections: SseConnectionRegistry;

  constructor(
    private readonly outbox: EventOutboxRepository,
    private readonly wakeHub: EventWakeHub,
    private readonly config: AppConfig['sse'],
  ) {
    this.connections = new SseConnectionRegistry(
      config.maxConnections,
      config.maxConnectionsPerUser,
    );
  }

  async stream(
    userId: string,
    query: EventStreamQuery,
    request: StreamRequest,
    response: StreamResponse,
  ): Promise<void> {
    const connectionId = randomUUID();
    const userScopeHash = this.userScopeHash(userId, query.scopeType, query.scopeId);
    if (!(await this.outbox.isOwnedScope(userId, query.scopeType, query.scopeId))) {
      this.logger.warn({
        event: 'sse_connection_rejected',
        metric: 'sse_connections_rejected_total',
        reason: 'resource_not_found',
        scope_type: query.scopeType,
        user_scope_hash: userScopeHash,
        connection_id: connectionId,
      });
      throw new NotFoundException({
        error: { code: 'RESOURCE_NOT_FOUND', message: '未找到该任务' },
      });
    }
    let releaseConnection: () => void;
    try {
      releaseConnection = this.connections.acquire(userId);
    } catch (error) {
      if (error instanceof SseConnectionLimitError) {
        this.logger.warn({
          event: 'sse_connection_rejected',
          metric: 'sse_connections_rejected_total',
          reason: 'connection_limit',
          scope_type: query.scopeType,
          user_scope_hash: userScopeHash,
          connection_id: connectionId,
          active_connections: this.connections.active(),
        });
        throw new HttpException(
          { error: { code: 'RATE_LIMITED', message: '实时连接过多，请稍后重试' } },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw error;
    }

    let closed = false;
    let cursor = query.lastEventSeq;
    let drainPromise: Promise<void> | undefined;
    let pendingDrain = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let removeWakeListener: (() => void) | undefined;
    let resolveClosed: (() => void) | undefined;
    let closeReason = 'response_closed';

    this.logger.log({
      event: 'sse_connection_accepted',
      metric: 'sse_connections_accepted_total',
      scope_type: query.scopeType,
      event_seq: cursor,
      user_scope_hash: userScopeHash,
      connection_id: connectionId,
      active_connections: this.connections.active(),
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      removeWakeListener?.();
      request.off('aborted', close);
      response.off('close', close);
      releaseConnection();
      if (response.headersSent && !response.writableEnded && !response.destroyed) response.end();
      this.logger.log({
        event: 'sse_connection_closed',
        metric: 'sse_connections_closed_total',
        reconnect_reason: closeReason,
        scope_type: query.scopeType,
        event_seq: cursor,
        user_scope_hash: userScopeHash,
        connection_id: connectionId,
        active_connections: this.connections.active(),
      });
      resolveClosed?.();
    };

    const drain = async (): Promise<void> => {
      if (closed) return;
      if (drainPromise) {
        pendingDrain = true;
        this.logger.debug({
          event: 'sse_wake_coalesced',
          metric: 'sse_wake_coalesced_total',
          scope_type: query.scopeType,
          user_scope_hash: userScopeHash,
          connection_id: connectionId,
        });
        await drainPromise;
        return;
      }
      const currentDrain = (async (): Promise<void> => {
        do {
          pendingDrain = false;
          while (!closed) {
            const replayStartedAt = Date.now();
            const events = await this.outbox.listAfter(
              query.scopeType,
              query.scopeId,
              cursor,
              this.config.replayBatchSize,
            );
            if (events.length > 0) {
              this.logger.log({
                event: 'sse_replay_batch',
                metric: 'sse_replay_events_total',
                replay_events: events.length,
                replay_latency_ms: Date.now() - replayStartedAt,
                scope_type: query.scopeType,
                event_seq: cursor,
                user_scope_hash: userScopeHash,
                connection_id: connectionId,
              });
            }
            if (events.length === 0) break;
            for (const event of events) {
              if (event.eventSeq !== cursor + 1) {
                closeReason = 'event_gap';
                this.logger.warn({
                  event: 'sse_replay_gap',
                  metric: 'sse_replay_gap_total',
                  scope_type: query.scopeType,
                  event_seq: cursor,
                  user_scope_hash: userScopeHash,
                  connection_id: connectionId,
                });
                await this.write(
                  response,
                  encodeControlEvent('recovery_required', {
                    reason: 'event_gap',
                    scope: query.scope,
                    last_event_seq: cursor,
                  }),
                );
                close();
                return;
              }
              const projected = projectPublicEvent(query.scope, event);
              await this.write(response, encodeBusinessEvent(projected));
              cursor = event.eventSeq;
            }
            if (events.length < this.config.replayBatchSize) break;
          }
        } while (pendingDrain && !closed);
      })();
      drainPromise = currentDrain;
      try {
        await currentDrain;
      } finally {
        if (drainPromise === currentDrain) drainPromise = undefined;
      }
    };

    const scheduleHeartbeat = (): void => {
      if (closed) return;
      heartbeatTimer = setTimeout(() => {
        void drain()
          .then(async () => {
            if (closed) return;
            await this.heartbeat(query.scope, cursor, response);
            this.logHeartbeat(query.scopeType, cursor, userScopeHash, connectionId);
            scheduleHeartbeat();
          })
          .catch(() => {
            closeReason = 'stream_error';
            close();
          });
      }, this.config.heartbeatIntervalMs);
      heartbeatTimer.unref();
    };

    try {
      removeWakeListener = await this.wakeHub.listen(query.scopeId, (wake) => {
        if (wake.scope_type !== query.scopeType) return;
        void drain().catch(() => {
          closeReason = 'stream_error';
          close();
        });
      });
      const highWatermark = await this.outbox.highWatermark(query.scopeType, query.scopeId);
      if (query.lastEventSeq > highWatermark) {
        throw new BadRequestException({
          error: { code: 'REQUEST_INVALID', message: '实时游标无效，请刷新后重试' },
        });
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders?.();
      request.once('aborted', close);
      response.once('close', close);

      await drain();
      if (!closed) {
        await this.heartbeat(query.scope, cursor, response);
        this.logHeartbeat(query.scopeType, cursor, userScopeHash, connectionId);
      }
      scheduleHeartbeat();
      await new Promise<void>((resolve) => {
        resolveClosed = resolve;
        if (closed) resolve();
      });
    } catch (error) {
      closeReason = error instanceof EventContractError ? 'event_contract_invalid' : 'stream_error';
      close();
      if (error instanceof EventContractError) {
        this.logger.warn({
          event: 'sse_event_contract_invalid',
          error_code: 'EVENT_CONTRACT_INVALID',
          metric: 'sse_replay_failure_total',
          scope_type: query.scopeType,
          event_seq: cursor,
          user_scope_hash: userScopeHash,
          connection_id: connectionId,
        });
      } else if (!response.destroyed && !response.writableEnded) {
        this.logger.warn({
          event: 'sse_stream_failed',
          error_code: 'SSE_STREAM_FAILED',
          metric: 'sse_replay_failure_total',
          scope_type: query.scopeType,
          event_seq: cursor,
          user_scope_hash: userScopeHash,
          connection_id: connectionId,
        });
      }
      if (response.headersSent) return;
      throw error;
    }
  }

  private heartbeat(scope: string, cursor: number, response: StreamResponse): Promise<void> {
    return this.write(
      response,
      encodeControlEvent('heartbeat', {
        server_time: new Date().toISOString(),
        scope,
        last_event_seq: cursor,
      }),
    );
  }

  private async write(response: StreamResponse, frame: string): Promise<void> {
    if (response.writableEnded || response.destroyed) throw new Error('SSE response is closed');
    if (response.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.logger.warn({
          event: 'sse_backpressure_timeout',
          error_code: 'SSE_BACKPRESSURE_TIMEOUT',
          metric: 'sse_backpressure_timeout_total',
        });
        reject(new Error('SSE backpressure timeout'));
      }, this.config.backpressureTimeoutMs);
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error('SSE response closed during backpressure'));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        response.off('drain', onDrain);
        response.off('close', onClose);
      };
      response.once('drain', onDrain);
      response.once('close', onClose);
    });
  }

  private logHeartbeat(
    scopeType: EventStreamQuery['scopeType'],
    eventSeq: number,
    userScopeHash: string,
    connectionId: string,
  ): void {
    this.logger.debug({
      event: 'sse_heartbeat_sent',
      metric: 'sse_heartbeat_sent_total',
      scope_type: scopeType,
      event_seq: eventSeq,
      user_scope_hash: userScopeHash,
      connection_id: connectionId,
    });
  }

  private userScopeHash(
    userId: string,
    scopeType: EventStreamQuery['scopeType'],
    scopeId: string,
  ): string {
    return createHmac('sha256', this.telemetryKey)
      .update(`${userId}:${scopeType}:${scopeId}`)
      .digest('hex')
      .slice(0, 24);
  }
}
