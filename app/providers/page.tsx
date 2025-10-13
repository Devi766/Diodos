'use client';

import Layout from '@/components/Layout';
import ProxyProviders from '@/components/ProxyProviders';
import RuleProviders from '@/components/RuleProviders';

export default function ProvidersPage() {
  return (
    <Layout>
      <div className="bg-[#f9f9f9] dark:bg-[#1a1a1a] min-h-screen p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              资源管理
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              管理代理提供者和规则提供者资源
            </p>
          </div>

          <ProxyProviders />
          <RuleProviders />
        </div>
      </div>
    </Layout>
  );
}
