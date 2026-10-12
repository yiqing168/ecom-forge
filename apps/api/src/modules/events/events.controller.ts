import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthenticationService } from '../auth/authentication.service.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import {
  copyAuthCookies,
  requestHeaders,
  type ApiRequest,
  type ApiResponse,
} from '../auth/auth-http.js';
import { parseEventStreamQuery } from './event-query.js';
import { SseStreamService } from './sse-stream.service.js';

interface EventRequest extends ApiRequest {
  url: string;
  once(event: 'aborted', listener: () => void): this;
  off(event: 'aborted', listener: () => void): this;
}

interface EventResponse extends ApiResponse {
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

@Controller('api/v1')
export class EventsController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(SseStreamService) private readonly streams: SseStreamService,
  ) {}

  @Get('events')
  async events(@Req() request: EventRequest, @Res() response: EventResponse): Promise<void> {
    const session = await this.authentication.currentSession(requestHeaders(request));
    if (!session) {
      throw new UnauthorizedException({
        error: { code: 'AUTH_SESSION_REQUIRED', message: '请先登录' },
      });
    }
    if (session.access?.restrictionReason === 'account_restricted') {
      throw new AccountFrozenError();
    }
    if (request.headers['last-event-id'] !== undefined) throw requestError();
    let query;
    try {
      query = parseEventStreamQuery(request.url);
    } catch {
      throw requestError();
    }
    copyAuthCookies(session.headers, response);
    await this.streams.stream(session.user.id, query, request, response);
  }
}

function requestError(): BadRequestException {
  return new BadRequestException({
    error: { code: 'REQUEST_INVALID', message: '请求参数不正确' },
  });
}
