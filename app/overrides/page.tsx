'use client';

import Layout from '@/components/Layout';
import Overrides from '@/components/Overrides';

export default function OverridesPage() {
  return (
    <Layout>
      <div className="space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">配置覆写</h1>
          <p className="text-sm text-muted-foreground">管理配置文件和脚本覆写</p>
        </div>
        <Overrides />
      </div>
    </Layout>
  );
}

