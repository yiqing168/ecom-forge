'use client';

import { Button, Result } from 'antd';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <Result
        extra={
          <Button onClick={reset} type="primary">
            重新加载
          </Button>
        }
        status="error"
        subTitle="若问题持续，请查看系统健康与审计记录。"
        title="页面暂时无法加载"
      />
    </main>
  );
}
