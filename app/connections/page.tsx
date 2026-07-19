'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';
import { useTranslation } from 'react-i18next';

const ConnectionTable = dynamic(() => import('@/components/ConnectionTable'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function ConnectionsPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6 min-w-0">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{t('connections.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('connections.subtitle')}</p>
      </div>
      <ConnectionTable />
    </div>
  );
}
