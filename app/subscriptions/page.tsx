'use client';

import Layout from '@/components/Layout';
import SubscriptionManager from '@/components/Subscription';

export default function SubscriptionsPage() {
  return (
    <Layout>
      <div className="bg-[#f9f9f9] dark:bg-[#1a1a1a] min-h-screen">
        <SubscriptionManager />
      </div>
    </Layout>
  );
} 