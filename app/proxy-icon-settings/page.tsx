'use client';

import Layout from '@/components/Layout';
import ProxyIconSettings from '@/components/ProxyIconSettings';
import { useTranslation } from 'react-i18next';

export default function ProxyIconSettingsPage() {
  const { t } = useTranslation();

  return (
    <Layout>
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{t('proxyIcon.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('proxyIcon.enableIconsDesc')}</p>
        </div>
        <ProxyIconSettings />
      </div>
    </Layout>
  );
}

