import { createSseChunkParser, type ParsedSseEvent } from './sse-parser';
import { parseRecord, RealtimeRecoveryError } from './workflow-realtime.validation';

const apiOrigin = (process.env.NEXT_PUBLIC_API_ORIGIN ?? '').replace(/\/$/, '');
const WATCHDOG_TIMEOUT_MS = positiveClientInteger(
  process.env.NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS,
  45_000,
);
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 30_000;

export type RealtimeConnectionStatus =
  'idle' | 'connecting' | 'live' | 'reconnecting' | 'recovered' | 'polling' | 'closed';

export interface RealtimeEvent {
  event_seq: number;
  event_type: string;
}

export interface ScopedRealtimeCallbacks<TSnapshot, TEvent extends RealtimeEvent> {
  onStatus(status: RealtimeConnectionStatus): void;
  onSnapshot(snapshot: TSnapshot): void;
  onEvent(event: TEvent): void;
  onAuthenticationRequired(): void;
  onUnavailable(): void;
}

export interface ScopedRealtimeClientOptions<TSnapshot, TEvent extends RealtimeEvent> {
  scope: string;
  snapshotUrl: string;
  parseSnapshot(value: unknown): TSnapshot;
  snapshotCursor(snapshot: TSnapshot): number;
  parseEvent(serialized: string, expectedScope: string): TEvent;
  callbacks: ScopedRealtimeCallbacks<TSnapshot, TEvent>;
  refreshSnapshotAfterEvent?: (event: TEvent) => boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  random?: () => number;
}

class RealtimeHttpError extends Error {
  constructor(readonly status: number) {
    super(`Realtime request failed with ${status}`);
    this.name = 'RealtimeHttpError';
  }
}

export class ScopedRealtimeClient<TSnapshot, TEvent extends RealtimeEvent> {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private status: RealtimeConnectionStatus = 'idle';
  private snapshot: TSnapshot | null = null;
  private cursor = 0;
  private stopped = true;
  private failures = 0;
  private controller: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingActive = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryWaiter: (() => void) | null = null;
  private onlineWaiter: (() => void) | null = null;

  constructor(private readonly options: ScopedRealtimeClientOptions<TSnapshot, TEvent>) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.setStatus('connecting');
    this.addNetworkListeners();
    try {
      await this.refreshSnapshot();
    } catch (error) {
      if (this.handleTerminalHttpError(error)) return;
      this.failures = 1;
      this.startPolling();
    }
    void this.runConnectionLoop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.clearPolling();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryWaiter?.();
    this.retryWaiter = null;
    this.onlineWaiter?.();
    this.onlineWaiter = null;
    this.removeNetworkListeners();
    this.setStatus('closed');
  }

  private async runConnectionLoop(): Promise<void> {
    while (!this.stopped) {
      if (!this.snapshot) {
        try {
          await this.refreshSnapshot();
        } catch (error) {
          if (this.handleTerminalHttpError(error)) return;
          this.failures += 1;
          this.startPolling();
          await this.delay(this.retryDelay());
          continue;
        }
      }
      if (!this.isOnline()) {
        this.setStatus('reconnecting');
        await this.waitForOnline();
        continue;
      }
      try {
        await this.connectOnce();
        if (this.stopped) return;
        throw new Error('Realtime stream ended');
      } catch (error) {
        if (this.stopped) return;
        if (this.handleTerminalHttpError(error)) return;
        if (error instanceof RealtimeRecoveryError || isHttpStatus(error, 400)) {
          try {
            await this.refreshSnapshot();
          } catch (snapshotError) {
            if (this.handleTerminalHttpError(snapshotError)) return;
          }
        }
        this.failures += 1;
        if (this.failures >= 3 || isHttpStatus(error, 429) || isHttpStatus(error, 503)) {
          this.startPolling();
        } else {
          this.setStatus('reconnecting');
        }
        await this.delay(this.retryDelay());
      }
    }
  }

  private async connectOnce(): Promise<void> {
    this.controller = new AbortController();
    let recoveryRequired = false;
    let lastFrameAt = this.now();
    const response = await this.fetcher(
      `${apiOrigin}/api/v1/events?scope=${encodeURIComponent(this.options.scope)}&last_event_seq=${this.cursor}`,
      { credentials: 'include', cache: 'no-store', signal: this.controller.signal },
    );
    if (!response.ok) throw new RealtimeHttpError(response.status);
    if (!response.body) throw new Error('Realtime response has no body');

    const parser = createSseChunkParser((frame) => {
      this.handleFrame(frame);
      lastFrameAt = this.now();
      if (frame.event === 'recovery_required') {
        recoveryRequired = true;
        this.controller?.abort();
      }
    });
    const watchdog = setInterval(() => {
      if (this.now() - lastFrameAt >= WATCHDOG_TIMEOUT_MS) this.controller?.abort();
    }, 1_000);
    const reader = response.body.getReader();
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(value);
      }
      parser.finish();
    } catch (error) {
      if (!this.controller.signal.aborted) throw error;
    } finally {
      clearInterval(watchdog);
      reader.releaseLock();
      this.controller = null;
    }
    if (recoveryRequired) throw new RealtimeRecoveryError();
  }

  private handleFrame(frame: ParsedSseEvent): void {
    if (frame.event === 'heartbeat') {
      const heartbeat = parseRecord(frame.data);
      if (
        heartbeat.scope !== this.options.scope ||
        typeof heartbeat.last_event_seq !== 'number' ||
        heartbeat.last_event_seq !== this.cursor
      ) {
        throw new RealtimeRecoveryError();
      }
      this.markLive();
      return;
    }
    if (frame.event === 'recovery_required') {
      const recovery = parseRecord(frame.data);
      if (recovery.scope !== this.options.scope || recovery.reason !== 'event_gap') {
        throw new RealtimeRecoveryError();
      }
      return;
    }
    const event = this.options.parseEvent(frame.data, this.options.scope);
    if (frame.event !== event.event_type || frame.id !== String(event.event_seq)) {
      throw new RealtimeRecoveryError();
    }
    if (event.event_seq <= this.cursor) return;
    if (event.event_seq !== this.cursor + 1) throw new RealtimeRecoveryError();
    try {
      this.options.callbacks.onEvent(event);
    } catch {
      throw new RealtimeRecoveryError();
    }
    this.cursor = event.event_seq;
    this.markLive();
    if (this.options.refreshSnapshotAfterEvent?.(event)) {
      void this.refreshSnapshot().catch(() => undefined);
    }
  }

  private async refreshSnapshot(): Promise<void> {
    const response = await this.fetcher(`${apiOrigin}${this.options.snapshotUrl}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) throw new RealtimeHttpError(response.status);
    const payload: unknown = await response.json();
    if (this.stopped) return;
    const snapshot = this.options.parseSnapshot(payload);
    const snapshotCursor = this.options.snapshotCursor(snapshot);
    if (this.stopped || snapshotCursor < this.cursor) return;
    this.snapshot = snapshot;
    this.cursor = snapshotCursor;
    this.options.callbacks.onSnapshot(snapshot);
  }

  private markLive(): void {
    const recovered =
      this.failures > 0 || this.status === 'polling' || this.status === 'reconnecting';
    this.failures = 0;
    this.clearPolling();
    this.setStatus(recovered ? 'recovered' : 'live');
    if (recovered) {
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = setTimeout(() => {
        if (!this.stopped && this.status === 'recovered') this.setStatus('live');
      }, 1_500);
    }
  }

  private startPolling(): void {
    if (this.pollingActive || this.stopped) return;
    this.pollingActive = true;
    this.setStatus('polling');
    const poll = async (): Promise<void> => {
      this.pollTimer = null;
      if (this.stopped || !this.pollingActive) return;
      try {
        await this.refreshSnapshot();
      } catch (error) {
        if (this.handleTerminalHttpError(error)) return;
      }
      if (this.stopped || !this.pollingActive) return;
      this.pollTimer = setTimeout(
        () => void poll(),
        typeof document !== 'undefined' && document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS,
      );
    };
    this.pollTimer = setTimeout(() => void poll(), 0);
  }

  private clearPolling(): void {
    this.pollingActive = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private handleTerminalHttpError(error: unknown): boolean {
    if (isHttpStatus(error, 401) || isHttpStatus(error, 403)) {
      this.options.callbacks.onAuthenticationRequired();
      this.stop();
      return true;
    }
    if (isHttpStatus(error, 404)) {
      this.options.callbacks.onUnavailable();
      this.stop();
      return true;
    }
    return false;
  }

  private retryDelay(): number {
    const base = RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)]!;
    return Math.round(base * (1 + this.random() * 0.2));
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.retryWaiter !== finish) return;
        this.retryTimer = null;
        this.retryWaiter = null;
        resolve();
      };
      this.retryWaiter = finish;
      this.retryTimer = setTimeout(finish, milliseconds);
    });
  }

  private setStatus(status: RealtimeConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.callbacks.onStatus(status);
  }

  private isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine;
  }

  private waitForOnline(): Promise<void> {
    if (this.isOnline() || this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      this.onlineWaiter = resolve;
    });
  }

  private handleOnline = (): void => {
    this.onlineWaiter?.();
    this.onlineWaiter = null;
  };

  private handleOffline = (): void => {
    this.controller?.abort();
  };

  private addNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  private removeNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }
}

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof RealtimeHttpError && error.status === status;
}

function positiveClientInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS must be a positive integer');
  }
  return parsed;
}
