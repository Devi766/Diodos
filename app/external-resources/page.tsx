'use client';

import Layout from '@/components/Layout';
import ExternalResources from '@/components/ExternalResources';
import { useTranslation } from 'react-i18next';

export default function ExternalResourcesPage() {
  const { t } = useTranslation();

  return (
    <Layout>
      <div className="space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{t('externalResources.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('externalResources.subtitle')}</p>
        </div>
        <ExternalResources />
      </div>
    </Layout>
  );
}

