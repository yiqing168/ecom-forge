import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  description: '重塑物象，万千风格',
  title: '象塑 · 重塑物象，万千风格',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html data-scroll-behavior="smooth" lang="zh-CN">
      <body>
        <a className="sr-only-focusable" href="#main-content">
          跳到主要内容
        </a>
        {children}
      </body>
    </html>
  );
}
