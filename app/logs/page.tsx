'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';
import { useTranslation } from 'react-i18next';

const MihomoLogs = dynamic(() => import('@/components/MihomoLogs'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function LogsPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{t('logs.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('logs.subtitle')}</p>
      </div>
      <MihomoLogs />
    </div>
  );
}

