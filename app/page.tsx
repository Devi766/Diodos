'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';

const Dashboard = dynamic(() => import('@/components/Dashboard'), {
  ssr: false,
  loading: () => <RouteContentFallback />,
});

export default function Home() {
  return <Dashboard />;
}
