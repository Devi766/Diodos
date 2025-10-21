'use client';

import Layout from '@/components/Layout';
import MihomoLogs from '@/components/MihomoLogs';

export default function LogsPage() {
  return (
    <Layout>
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">日志</h1>
          <p className="text-sm text-muted-foreground">查看 Mihomo 核心运行日志</p>
        </div>
        <MihomoLogs />
      </div>
    </Layout>
  );
}

