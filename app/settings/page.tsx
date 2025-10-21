'use client';

import Layout from '@/components/Layout';
import Settings from '@/components/Settings';

export default function SettingsPage() {
  return (
    <Layout>
      <div className="space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">系统设置</h1>
            <p className="mt-1 text-sm text-muted-foreground">调整系统、代理及界面相关偏好</p>
          </div>
        </div>
        <Settings />
      </div>
    </Layout>
  );
}
