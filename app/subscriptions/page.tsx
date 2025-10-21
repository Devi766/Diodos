'use client';

import Layout from '@/components/Layout';
import SubscriptionManager from '@/components/Subscription';

export default function SubscriptionsPage() {
  return (
    <Layout>
      <div className="space-y-6">
        <SubscriptionManager />
      </div>
    </Layout>
  );
}
