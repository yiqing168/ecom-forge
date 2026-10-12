import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  provisionValidationTestDatabase,
  resolveTestDatabaseUrl,
} from '../../../scripts/validation/lib/test-database.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const baseUrl = 'postgresql://test:fixture-secret@127.0.0.1:5432/ecom_forge_test';
const request = { pnpmCli: '/fixture/pnpm.cjs', baseUrl };
const output = (value) => `__ECOM_TEST_DATABASE__${JSON.stringify(value)}\n`;

beforeEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('validation database helper trust boundary', () => {
  it('reports an allowlisted migration diagnostic without forwarding adjacent driver output', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stderr: `TEST_DATABASE_MIGRATION_DRIFT\n${baseUrl}`,
    });
    expect(() => provisionValidationTestDatabase(request)).toThrow('TEST_DATABASE_MIGRATION_DRIFT');
    try {
      provisionValidationTestDatabase(request);
    } catch (error) {
      expect(String(error)).not.toContain('fixture-secret');
    }
  });
  it('passes connection configuration through environment only and accepts a valid result', () => {
    const value = { url: baseUrl, outcome: 'base', databaseName: 'ecom_forge_test' };
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: output(value) });
    expect(provisionValidationTestDatabase(request)).toEqual(value);
    const [, args, options] = vi.mocked(spawnSync).mock.calls[0];
    expect(JSON.stringify(args)).not.toContain('fixture-secret');
    expect(options.env.TEST_DATABASE_URL).toBe(baseUrl);
  });

  it.each([
    { status: 1, stdout: baseUrl, stderr: 'driver leaked fixture-secret' },
    { status: 0, stdout: baseUrl, stderr: 'driver leaked fixture-secret' },
    { status: 0, stdout: '__ECOM_TEST_DATABASE__fixture-secret' },
    { error: new Error(`spawn failed ${baseUrl}`) },
  ])('does not expose raw child diagnostics on failure: case %#', (result) => {
    vi.mocked(spawnSync).mockReturnValue(result);
    let error;
    try {
      provisionValidationTestDatabase(request);
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('fixture-secret');
    expect(String(error)).not.toContain(baseUrl);
  });

  it.each([
    {},
    { url: baseUrl, outcome: 'unexpected', databaseName: 'ecom_forge_test' },
    {
      url: baseUrl.replace('127.0.0.1', 'other.example'),
      outcome: 'base',
      databaseName: 'ecom_forge_test',
    },
    {
      url: baseUrl.replace('ecom_forge_test', 'ecom_forge'),
      outcome: 'reused',
      databaseName: 'ecom_forge',
    },
    {
      url: baseUrl.replace('ecom_forge_test', 'ecom_forge_test_sibling'),
      outcome: 'base',
      databaseName: 'ecom_forge_test_sibling',
    },
  ])('refuses incomplete results or a changed endpoint: case %#', (value) => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: output(value) });
    expect(() => provisionValidationTestDatabase(request)).toThrow('invalid result');
  });

  it.each([
    'not-a-url',
    baseUrl.replace('ecom_forge_test', 'ecom_forge'),
    baseUrl.replace('postgresql:', 'https:'),
  ])('rejects invalid input before spawning: case %#', (value) => {
    expect(() => resolveTestDatabaseUrl('fixture', { TEST_DATABASE_URL: value })).toThrow();
    expect(() => provisionValidationTestDatabase({ ...request, baseUrl: value })).toThrow();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
