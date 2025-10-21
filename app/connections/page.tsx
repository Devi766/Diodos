'use client';

import { useEffect, useState } from 'react';
import Layout from '@/components/Layout';
import ConnectionTable from '@/components/ConnectionTable';

export default function ConnectionsPage() {
  return (
    <Layout>
      <div className="space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">连接信息</h1>
          <p className="text-sm text-muted-foreground">实时查看连接详情并管理当前流量</p>
        </div>
        <ConnectionTable />
      </div>
    </Layout>
  );
} 
