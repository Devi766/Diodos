'use client';

import Layout from '@/components/Layout';
import ProxyNodes from '../../src/components/ProxyNodes';

export default function NodesPage() {
  return (
    <Layout>
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">代理组</h1>
          <p className="text-sm text-muted-foreground">浏览和切换节点、维护分组并监控可用情况</p>
        </div>
        <ProxyNodes />
      </div>
    </Layout>
  );
}
