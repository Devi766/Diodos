'use client';

import SubscriptionConverter from '@/components/SubscriptionConverter';
import { useTranslation } from 'react-i18next';

export default function ConverterPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{t('converter.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('converter.subtitle')}</p>
      </div>
      <SubscriptionConverter />
    </div>
  );
}

