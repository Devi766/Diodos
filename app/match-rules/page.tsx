'use client';

import Layout from '@/components/Layout';
import MatchRules from '@/components/MatchRules';

export default function MatchRulesPage() {
  return (
    <Layout>
      <div className="space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">匹配规则</h1>
          <p className="text-sm text-muted-foreground">查看和搜索当前生效的路由规则</p>
        </div>
        <MatchRules />
      </div>
    </Layout>
  );
}

