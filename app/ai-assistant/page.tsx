'use client';

import Layout from '@/components/Layout';
import AiAssistant from '@/components/ai/AiAssistant';
import { useTranslation } from 'react-i18next';

export default function AiAssistantPage() {
  const { t } = useTranslation();
  return (
    <Layout>
      <div className="flex flex-col min-w-0 h-full">
        <div className="space-y-1 shrink-0">
          <h1 className="text-2xl font-semibold text-foreground">{t('ai.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('ai.subtitle')}</p>
        </div>
        <div className="mt-4 min-h-0 flex-1">
          <AiAssistant />
        </div>
      </div>
    </Layout>
  );
}
