'use client';

import Layout from '@/components/Layout';
import MatchRules from '@/components/MatchRules';
import { useTranslation } from 'react-i18next';

export default function MatchRulesPage() {
  const { t } = useTranslation();

  return (
    <Layout>
      <div className="space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{t('matchRules.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('matchRules.subtitle')}</p>
        </div>
        <MatchRules />
      </div>
    </Layout>
  );
}

