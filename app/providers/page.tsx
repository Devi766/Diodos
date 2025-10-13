'use client';

import Layout from '@/components/Layout';
import ProxyProviders from '@/components/ProxyProviders';
import RuleProviders from '@/components/RuleProviders';
import { useProviderAvailability } from '@/hooks/use-provider-availability';

export default function ProvidersPage() {
  const { status } = useProviderAvailability();

  return (
    <Layout>
      <div className="bg-[#f9f9f9] dark:bg-[#1a1a1a] min-h-screen p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              外部资源
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              管理外部代理提供者和规则提供者资源
            </p>
          </div>

          {status === 'absent' && (
            <div className="bg-white dark:bg-[#1f1f1f] border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center text-gray-500 dark:text-gray-400">
              当前配置不包含任何 Provider
            </div>
          )}

          <ProxyProviders />
          <RuleProviders />
        </div>
      </div>
    </Layout>
  );
}
