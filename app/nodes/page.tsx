'use client';

import { useEffect, useState } from 'react';
import Layout from '@/components/Layout';
import ProxyNodes from '../../src/components/ProxyNodes';

export default function NodesPage() {
  return (
    <Layout>
      <div className="container p-4 mx-auto bg-[#f9f9f9] dark:bg-[#1a1a1a]">
        <ProxyNodes />
      </div>
    </Layout>
  );
} 