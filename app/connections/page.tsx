'use client';

import { useEffect, useState } from 'react';
import Layout from '@/components/Layout';
import ConnectionTable from '@/components/ConnectionTable';

export default function ConnectionsPage() {
  return (
    <Layout>
      <div className="container p-4 mx-auto bg-[#f9f9f9] dark:bg-[#1a1a1a]">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">连接数据</h1>
        </div>
        <ConnectionTable />
      </div>
    </Layout>
  );
} 