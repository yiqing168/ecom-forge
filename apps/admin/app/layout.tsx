import { AntdRegistry } from '@ant-design/nextjs-registry';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { AdminDesignProvider } from '@/components/providers/admin-design-provider';
import { AdminAuthProvider } from '@/features/auth/admin-auth-provider';
import { AdminMutationProvider } from '@/features/auth/admin-mutation-provider';

import './globals.css';

export const metadata: Metadata = {
  description: 'Ecom Forge 独立运营管理控制面',
  title: 'Ecom Forge Control Plane',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="zh-CN">
      <body>
        <a className="sr-only-focusable" href="#main-content">
          跳到主要内容
        </a>
        <AntdRegistry>
          <AdminDesignProvider {...(nonce ? { nonce } : {})}>
            <AdminAuthProvider>
              <AdminMutationProvider>{children}</AdminMutationProvider>
            </AdminAuthProvider>
          </AdminDesignProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
