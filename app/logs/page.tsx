'use client';

import Layout from '@/components/Layout';
import MihomoLogs from '@/components/MihomoLogs';
import { useTranslation } from 'react-i18next';

export default function LogsPage() {
  const { t } = useTranslation();

  return (
    <Layout>
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{t('logs.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('logs.subtitle')}</p>
        </div>
        <MihomoLogs />
      </div>
    </Layout>
  );
}

