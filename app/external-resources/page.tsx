'use client';

import Layout from '@/components/Layout';
import ExternalResources from '@/components/ExternalResources';

export default function ExternalResourcesPage() {
  return (
    <Layout>
      <div className="space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">外部资源</h1>
          <p className="text-sm text-muted-foreground">管理地理数据库和规则集</p>
        </div>
        <ExternalResources />
      </div>
    </Layout>
  );
}

