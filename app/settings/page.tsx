'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';
import { useTranslation } from 'react-i18next';

const Settings = dynamic(() => import('@/components/Settings'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function SettingsPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t('settings.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.subtitle')}</p>
        </div>
      </div>
      <Settings />
    </div>
  );
}
