import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';

import { AuthenticationService } from '../auth/authentication.service.js';
import type { ApiRequest, ApiResponse } from '../auth/auth-http.js';
import { AuthWriteGuard } from '../auth/auth-write.guard.js';
import { ProductService } from './product.service.js';
import { requireResourceUser } from './resource-auth.js';
import { ResourceExceptionFilter } from './resource-exception.filter.js';
import {
  createFactSetSchema,
  createProductSchema,
  parseIdempotencyKey,
  productListQuerySchema,
  updateProductSchema,
  uuid,
} from './resource.schemas.js';

@Controller('api/v1/products')
@UseFilters(ResourceExceptionFilter)
export class ProductController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(ProductService) private readonly products: ProductService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response);
    const parsed = productListQuerySchema.parse(query);
    return {
      ok: true,
      data: await this.products.list(userId, {
        limit: parsed.limit,
        ...(parsed.query ? { query: parsed.query } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      }),
      error: null,
    };
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(
    @Param('id') id: string,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response);
    return { ok: true, data: await this.products.get(userId, uuid.parse(id)), error: null };
  }

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response, true);
    return {
      ok: true,
      data: await this.products.create(
        userId,
        createProductSchema.parse(body),
        parseIdempotencyKey(key),
      ),
      error: null,
    };
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response, true);
    return {
      ok: true,
      data: await this.products.update(
        userId,
        uuid.parse(id),
        updateProductSchema.parse(body),
        parseIdempotencyKey(key),
      ),
      error: null,
    };
  }

  @Post(':id/fact-sets')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthWriteGuard)
  async createFacts(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const userId = await requireResourceUser(this.authentication, request, response, true);
    return {
      ok: true,
      data: await this.products.createFacts(
        userId,
        uuid.parse(id),
        createFactSetSchema.parse(body),
        parseIdempotencyKey(key),
      ),
      error: null,
    };
  }
}
