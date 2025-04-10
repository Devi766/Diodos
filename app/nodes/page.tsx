'use client';

import { useEffect, useState } from 'react';
import Layout from '@/components/Layout';
import ProxyNodes from '../../src/components/ProxyNodes';

export default function NodesPage() {
  return (
    <Layout>
      <div className="container p-4 mx-auto bg-[#f9f9f9] dark:bg-[#1a1a1a]">
        <h1 className="text-2xl font-bold mb-6 text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">节点管理</h1>
        <ProxyNodes />
      </div>
    </Layout>
  );
} 