import React, { useState, useEffect, useMemo, useRef } from 'react';
import { CheckCircle, XCircle, Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMihomoAPI } from '@/services/mihomo-api';

type ViewMode = 'hit' | 'miss';

interface RuleItem {
  type: string;
  payload: string;
  proxy: string;
  count: number;
}

interface RuleTypeGroup {
  type: string;
  count: number;
  rules: number;
}

export function RulesOverviewCard() {
  const { t } = useTranslation();
  const mihomoAPI = useMihomoAPI();
  const apiRef = useRef(mihomoAPI);
  apiRef.current = mihomoAPI;

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('rulesOverviewViewMode');
      return (saved === 'miss' ? 'miss' : 'hit') as ViewMode;
    } catch {
      return 'hit';
    }
  });
  const [rules, setRules] = useState<any[]>([]);
  const [hasExtra, setHasExtra] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchRules = async () => {
      try {
        const data = await apiRef.current.matchRules();
        if (cancelled) return;
        if (data?.rules) {
          setRules(data.rules);
          const firstWithExtra = data.rules.find((r: any) => r.extra);
          setHasExtra(!!firstWithExtra);
        }
      } catch (error) {
        if (!cancelled) console.error('获取规则数据失败:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchRules();
    const interval = setInterval(fetchRules, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // 有 extra 字段时：按命中/未命中排序
  const rankedRules = useMemo(() => {
    if (!hasExtra) return [];
    const filtered = rules
      .filter((r: any) => {
        const extra = r.extra;
        if (!extra) return false;
        return viewMode === 'hit' ? (extra.hitCount || 0) > 0 : (extra.missCount || 0) > 0;
      })
      .map((r: any) => ({
        type: r.type,
        payload: r.payload,
        proxy: r.proxy,
        count: viewMode === 'hit' ? (r.extra?.hitCount || 0) : (r.extra?.missCount || 0),
      }))
      .sort((a: RuleItem, b: RuleItem) => b.count - a.count)
      .slice(0, 10);
    return filtered;
  }, [rules, viewMode, hasExtra]);

  // 降级：按规则类型分组统计
  const typeGroups = useMemo(() => {
    if (hasExtra) return [];
    const map = new Map<string, RuleTypeGroup>();
    rules.forEach((r: any) => {
      const existing = map.get(r.type);
      if (existing) {
        existing.rules += 1;
      } else {
        map.set(r.type, { type: r.type, count: 0, rules: 1 });
      }
    });
    return Array.from(map.values()).sort((a, b) => b.rules - a.rules).slice(0, 10);
  }, [rules, hasExtra]);

  const maxCount = useMemo(() => {
    if (hasExtra) return rankedRules[0]?.count || 1;
    return typeGroups[0]?.rules || 1;
  }, [rankedRules, typeGroups, hasExtra]);

  const barColor = viewMode === 'hit'
    ? 'from-blue-500 to-blue-600'
    : 'from-orange-400 to-orange-500';

  if (loading) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
        <p className="text-sm text-muted-foreground">{t('dashboard.loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-[260px] flex-col space-y-5 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
      {/* 标题和切换按钮 */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.rulesOverview')}
        </p>
        {hasExtra && (
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-[#1f1f1f]">
            <button
              onClick={() => {
                setViewMode('hit');
                try { localStorage.setItem('rulesOverviewViewMode', 'hit'); } catch {}
              }}
              className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                viewMode === 'hit'
                  ? 'bg-white text-primary shadow-sm dark:bg-[#222222] dark:text-primary'
                  : 'text-gray-600 hover:text-gray-900 dark:bg-[#222222] dark:text-gray-300 dark:hover:bg-[#2a2a2a] dark:hover:text-gray-100'
              }`}
            >
              <CheckCircle className="h-3 w-3" />
              {t('dashboard.hitRules')}
            </button>
            <button
              onClick={() => {
                setViewMode('miss');
                try { localStorage.setItem('rulesOverviewViewMode', 'miss'); } catch {}
              }}
              className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                viewMode === 'miss'
                  ? 'bg-white text-primary shadow-sm dark:bg-[#222222] dark:text-primary'
                  : 'text-gray-600 hover:text-gray-900 dark:bg-[#222222] dark:text-gray-300 dark:hover:bg-[#2a2a2a] dark:hover:text-gray-100'
              }`}
            >
              <XCircle className="h-3 w-3" />
              {t('dashboard.missRules')}
            </button>
          </div>
        )}
      </div>

      {/* 规则列表 */}
      <div className="flex-1 space-y-2.5 overflow-x-hidden overflow-y-auto custom-scrollbar">
        {hasExtra ? (
          rankedRules.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('dashboard.noRuleStats')}
            </div>
          ) : (
            rankedRules.map((item, index) => (
              <div key={`${item.type}-${item.payload}-${index}`} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                      index === 0
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : index === 1
                        ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                        : index === 2
                        ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                        : 'bg-gray-50 text-gray-600 dark:bg-gray-800/50 dark:text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                    <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                      {item.type}
                    </span>
                    <span className="truncate text-xs text-foreground">{item.payload || item.proxy}</span>
                  </div>
                  <span className="flex-shrink-0 text-xs font-semibold text-foreground ml-2">
                    {item.count}
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div
                    className={`absolute left-0 top-0 h-full rounded-full bg-gradient-to-r ${barColor} transition-all duration-300`}
                    style={{ width: `${(item.count / maxCount) * 100}%` }}
                  />
                </div>
              </div>
            ))
          )
        ) : (
          typeGroups.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('dashboard.noRuleStats')}
            </div>
          ) : (
            typeGroups.map((group, index) => (
              <div key={group.type} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                      index === 0
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : index === 1
                        ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                        : index === 2
                        ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                        : 'bg-gray-50 text-gray-600 dark:bg-gray-800/50 dark:text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                    <span className="text-xs font-medium text-foreground">{group.type}</span>
                  </div>
                  <span className="text-xs font-semibold text-foreground">
                    {group.rules} {t('dashboard.rule')}
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div
                    className="absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-300"
                    style={{ width: `${(group.rules / maxCount) * 100}%` }}
                  />
                </div>
              </div>
            ))
          )
        )}
      </div>
    </div>
  );
}
