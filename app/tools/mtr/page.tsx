'use client';

import dynamic from 'next/dynamic';
import RouteContentFallback from '@/components/RouteContentFallback';

const MtrTools = dynamic(() => import('@/components/MtrTools'), { ssr: false, loading: () => <RouteContentFallback /> });
export default function MtrPage() { return <MtrTools />; }
