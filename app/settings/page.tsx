'use client';

import Layout from '@/components/Layout';
import Settings from '@/components/Settings';

export default function SettingsPage() {
  return (
    <Layout>
      <div className="bg-[#f9f9f9] dark:bg-[#1a1a1a]">
        <Settings />
      </div>
    </Layout>
  );
} 