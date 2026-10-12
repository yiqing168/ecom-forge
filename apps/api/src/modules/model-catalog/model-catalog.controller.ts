import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';

import { AuthenticationService } from '../auth/authentication.service.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import {
  copyAuthCookies,
  requestHeaders,
  type ApiRequest,
  type ApiResponse,
} from '../auth/auth-http.js';
import { ModelCatalogService } from './model-catalog.service.js';

@Controller('api/v1/model-catalog')
export class ModelCatalogController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(ModelCatalogService) private readonly catalog: ModelCatalogService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Query('category') category: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const session = await this.authentication.currentSession(requestHeaders(request));
    if (!session?.user.emailVerified) {
      throw new ForbiddenException({
        error: { code: 'AUTH_VERIFICATION_REQUIRED', message: '请先完成邮箱验证' },
      });
    }
    if (session.access?.restrictionReason === 'account_restricted') {
      throw new AccountFrozenError();
    }
    copyAuthCookies(session.headers, response);
    return this.catalog.list(z.enum(['brain', 'image', 'video']).parse(category), session.user.id);
  }
}
