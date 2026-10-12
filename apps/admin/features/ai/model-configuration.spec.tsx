import { App } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelConfigurationPage } from './model-configuration';

const auth = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/features/auth/admin-auth-provider', () => ({
  useAdminAuth: () => auth,
}));

const configurations = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    purpose: 'brain',
    protocol_family: 'anthropic',
    endpoint_host: 'relay.example.com',
    base_url: 'https://relay.example.com/v1',
    model_id: 'brain-model',
    key_hint: 'key-111111111111',
    prices: null,
    status: 'active',
    runtime_status: 'available',
    revision: 2,
    updated_at: '2026-08-20T00:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    purpose: 'image',
    protocol_family: 'openai',
    endpoint_host: 'relay.example.com',
    base_url: 'https://relay.example.com/v1',
    model_id: 'image-model',
    key_hint: 'key-222222222222',
    prices: { '1k': '1.00', '2k': '2.00', '4k': '3.00' },
    status: 'active',
    runtime_status: 'available',
    revision: 4,
    updated_at: '2026-08-20T00:00:00.000Z',
  },
] as const;

function renderPage() {
  return render(
    <App>
      <ModelConfigurationPage />
    </App>,
  );
}

beforeEach(() => {
  auth.request.mockReset();
  auth.request.mockResolvedValue({ items: configurations });
});

afterEach(cleanup);

describe('ModelConfigurationPage', () => {
  it('offers Gemini for Brain and sends its type with the unchanged model-list flow', async () => {
    auth.request.mockImplementation((path: string) => {
      if (path === '/model-configurations') return { items: configurations };
      if (path === '/model-configurations/probe-models')
        return {
          probe_token: 'probe-token',
          expires_at: '2026-10-02T00:10:00.000Z',
          models: [{ id: 'gemini-test', label: 'Gemini test' }],
        };
      return {};
    });
    renderPage();
    await screen.findByText('brain-model');
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const drawer = await screen.findByRole('dialog', { name: '添加模型' });
    fireEvent.click(within(drawer).getByText('Gemini', { exact: true }));
    fireEvent.change(within(drawer).getByLabelText('接口地址'), {
      target: { value: 'https://relay.example.com' },
    });
    fireEvent.change(within(drawer).getByLabelText('API Key'), {
      target: { value: 'test-relay-key' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: '获取模型' }));
    await waitFor(() =>
      expect(auth.request).toHaveBeenCalledWith(
        '/model-configurations/probe-models',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const [, init] = auth.request.mock.calls.find(
      ([path]) => path === '/model-configurations/probe-models',
    ) as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      purpose: 'brain',
      protocol_family: 'google',
      base_url: 'https://relay.example.com',
    });
  });
  it('keeps connection, model and credits in one list without internal concepts', async () => {
    renderPage();

    expect(await screen.findByText('brain-model')).toBeTruthy();
    expect(screen.getByText('image-model')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /配置 .* 积分/ })).toHaveLength(1);
    expect(screen.queryByText('服务通道')).toBeNull();
    expect(screen.queryByText('模型快照')).toBeNull();
    expect(screen.queryByText('规格与积分')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const drawer = await screen.findByRole('dialog', { name: '添加模型' });
    expect(within(drawer).getByLabelText('接口地址')).toBeTruthy();
    expect(within(drawer).getByLabelText('API Key')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: '获取模型' })).toBeTruthy();
  });

  it('updates image credits from the model row with revision CAS', async () => {
    renderPage();
    expect(await screen.findByText('image-model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '配置 image-model 积分' }));

    const dialog = await screen.findByRole('dialog', { name: '积分配置' });
    expect(within(dialog).queryByLabelText('3K')).toBeNull();
    expect(within(dialog).getByLabelText('4K')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('1K'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存积分配置' }));

    await waitFor(() =>
      expect(auth.request).toHaveBeenCalledWith(
        '/model-configurations/22222222-2222-4222-8222-222222222222/credits',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const [path, init] = auth.request.mock.calls.find(
      ([requestPath]) =>
        requestPath === '/model-configurations/22222222-2222-4222-8222-222222222222/credits',
    ) as [string, RequestInit];
    expect(path).toBe('/model-configurations/22222222-2222-4222-8222-222222222222/credits');
    expect(init.method).toBe('PUT');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({
      prices: { '1k': '2.00', '2k': '2.00', '4k': '3.00' },
      expected_revision: 4,
      reason: '更新模型积分',
    });
  });

  it('reuses the saved key when an existing model is probed with an empty key field', async () => {
    auth.request.mockImplementation((path: string) => {
      if (path === '/model-configurations') return { items: configurations };
      if (path === '/model-configurations/probe-models') {
        return {
          probe_token: 'probe-token',
          expires_at: '2026-08-20T00:10:00.000Z',
          models: [{ id: 'image-model', label: 'Image Model' }],
        };
      }
      return {};
    });
    renderPage();

    expect(await screen.findByText('image-model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改模型 image-model' }));
    const drawer = await screen.findByRole('dialog', { name: '修改模型' });
    const apiKey = within(drawer).getByLabelText<HTMLInputElement>('API Key');
    expect(apiKey.value).toBe('');
    fireEvent.click(within(drawer).getByRole('button', { name: '获取模型' }));

    await waitFor(() =>
      expect(auth.request).toHaveBeenCalledWith(
        '/model-configurations/probe-models',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const [, init] = auth.request.mock.calls.find(
      ([requestPath]) => requestPath === '/model-configurations/probe-models',
    ) as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      purpose: 'image',
      protocol_family: 'openai',
      base_url: 'https://relay.example.com/v1',
      configuration_id: '22222222-2222-4222-8222-222222222222',
    });
  });
});
