'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';
import { useTranslation } from 'react-i18next';

const MatchRules = dynamic(() => import('@/components/MatchRules'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function MatchRulesPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6 min-w-0">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{t('matchRules.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('matchRules.subtitle')}</p>
      </div>
      <MatchRules />
    </div>
  );
}

