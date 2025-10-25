'use client';

import Layout from '@/components/Layout';
import Settings from '@/components/Settings';
import { useTranslation } from 'react-i18next';

export default function SettingsPage() {
  const { t } = useTranslation();

  return (
    <Layout>
      <div className="space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t('settings.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('settings.subtitle')}</p>
          </div>
        </div>
        <Settings />
      </div>
    </Layout>
  );
}
