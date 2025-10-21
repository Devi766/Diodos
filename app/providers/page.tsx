'use client';

import Layout from '@/components/Layout';
import ProxyProviders from '@/components/ProxyProviders';
import RuleProviders from '@/components/RuleProviders';
import { useProviderAvailability } from '@/hooks/use-provider-availability';

export default function ProvidersPage() {
  const { status } = useProviderAvailability();

  return (
    <Layout>
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">提供者</h1>
          <p className="text-sm text-muted-foreground">管理外部代理提供者和规则提供者资源</p>
        </div>

        {status === 'absent' && (
          <div className="bg-white dark:bg-[#2a2a2a] border border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-8 text-center text-slate-500 dark:text-slate-400">
            当前配置不包含任何 Provider
          </div>
        )}

        <ProxyProviders />
        <RuleProviders />
      </div>
    </Layout>
  );
}
