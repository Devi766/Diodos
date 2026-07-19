'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';
import { useTranslation } from 'react-i18next';

const AiAssistant = dynamic(() => import('@/components/ai/AiAssistant'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function AiAssistantPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col min-w-0 h-full">
      <div className="space-y-1 shrink-0">
        <h1 className="text-2xl font-semibold text-foreground">{t('ai.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('ai.subtitle')}</p>
      </div>
      <div className="mt-4 min-h-0 flex-1">
        <AiAssistant />
      </div>
    </div>
  );
}
