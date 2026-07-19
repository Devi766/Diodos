'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';
import { useTranslation } from 'react-i18next';

const ExternalResources = dynamic(() => import('@/components/ExternalResources'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function ExternalResourcesPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6 min-w-0">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{t('externalResources.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('externalResources.subtitle')}</p>
      </div>
      <ExternalResources />
    </div>
  );
}

