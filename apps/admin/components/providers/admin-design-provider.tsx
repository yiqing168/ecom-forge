'use client';

import '@ant-design/v5-patch-for-react-19';

import { StyleProvider } from '@ant-design/cssinjs';
import { ProConfigProvider } from '@ant-design/pro-components';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';

export function AdminDesignProvider({ children, nonce }: { children: ReactNode; nonce?: string }) {
  return (
    <StyleProvider layer>
      <ConfigProvider
        {...(nonce ? { csp: { nonce } } : {})}
        locale={zhCN}
        theme={{
          cssVar: true,
          hashed: false,
          token: {
            borderRadius: 6,
            colorBgLayout: '#f4f5f3',
            colorError: '#b5423b',
            colorInfo: '#08746f',
            colorPrimary: '#3159d8',
            colorSuccess: '#197047',
            colorText: '#171a18',
            colorTextSecondary: '#626963',
            colorWarning: '#98601d',
            controlHeight: 40,
            fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif",
          },
          components: {
            Button: { fontWeight: 600 },
            Card: { borderRadiusLG: 6 },
            Table: { headerBg: '#f0f1ee', headerColor: '#626963' },
          },
        }}
      >
        <ProConfigProvider hashed={false}>
          <App>{children}</App>
        </ProConfigProvider>
      </ConfigProvider>
    </StyleProvider>
  );
}
