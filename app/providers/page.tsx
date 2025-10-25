'use client';

import Layout from '@/components/Layout';
import ProxyProviders from '@/components/ProxyProviders';
import RuleProviders from '@/components/RuleProviders';
import { useProviderAvailability } from '@/hooks/use-provider-availability';
import { useTranslation } from 'react-i18next';

export default function ProvidersPage() {
  const { t } = useTranslation();
  const { status } = useProviderAvailability();

  return (
    <Layout>
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{t('providers.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('providers.subtitle')}</p>
        </div>

        {status === 'absent' && (
          <div className="bg-white dark:bg-[#2a2a2a] border border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-8 text-center text-slate-500 dark:text-slate-400">
            {t('providers.noProviders')}
          </div>
        )}

        <ProxyProviders />
        <RuleProviders />
      </div>
    </Layout>
  );
}
