'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';

const IperfTools = dynamic(() => import('@/components/IperfTools'), { ssr: false, loading: () => <RouteContentFallback /> });
export default function IperfPage() { return <IperfTools />; }
