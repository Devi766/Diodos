'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';

const SpeedTestTools = dynamic(() => import('@/components/SpeedTestTools'), { ssr: false, loading: () => <RouteContentFallback /> });
export default function SpeedTestPage() { return <SpeedTestTools />; }
