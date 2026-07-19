'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';
import { useTranslation } from 'react-i18next';

const Overrides = dynamic(() => import('@/components/Overrides'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function OverridesPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6 min-w-0">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{t('overrides.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('overrides.subtitle')}</p>
      </div>
      <Overrides />
    </div>
  );
}

