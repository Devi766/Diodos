'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';

const UsageAnalytics = dynamic(() => import('@/components/UsageAnalytics'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function UsagePage() {
  return <UsageAnalytics />;
}
