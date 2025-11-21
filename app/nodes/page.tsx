'use client';

import Layout from '@/components/Layout';
import ProxyNodes from '../../src/components/ProxyNodes';
import { useTranslation } from 'react-i18next';

export default function NodesPage() {
  const { t } = useTranslation();

  return (
    <Layout>
      <div className="space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{t('nodes.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('nodes.subtitle')}</p>
        </div>
        <ProxyNodes />
      </div>
    </Layout>
  );
}
