'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';

const SubscriptionManager = dynamic(() => import('@/components/Subscription'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function SubscriptionsPage() {
  return (
    <div className="space-y-6">
      <SubscriptionManager />
    </div>
  );
}
