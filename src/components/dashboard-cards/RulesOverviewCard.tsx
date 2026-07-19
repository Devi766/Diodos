import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { CheckCircle, XCircle, Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMihomoAPI } from '@/services/mihomo-api';
import {
  hasMatchRulesCache,
  readMatchRulesCache,
  subscribeMatchRulesCache,
  writeMatchRulesCache,
} from '@/services/app-data-hooks';

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

let rulesOverviewMemoryCache: any[] | null = null;

const readCachedRules = () => {
  if (rulesOverviewMemoryCache) return rulesOverviewMemoryCache;
  const rules = readMatchRulesCache<any>();
  if (rules.length > 0) {
    rulesOverviewMemoryCache = rules;
  }
  return rules;
};

const hasRuleExtra = (items: any[]) => {
  return items.some((r: any) => r?.extra);
};

export function RulesOverviewCard() {
  const { t } = useTranslation();
  const mihomoAPI = useMihomoAPI();
  const apiRef = useRef(mihomoAPI);
  const mountedRef = useRef(false);

  useEffect(() => {
    apiRef.current = mihomoAPI;
  }, [mihomoAPI]);

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('rulesOverviewViewMode');
      return (saved === 'miss' ? 'miss' : 'hit') as ViewMode;
    } catch {
      return 'hit';
    }
  });
  const [rules, setRules] = useState<any[]>(() => readCachedRules());
  const [hasExtra, setHasExtra] = useState(() => {
    const cached = readCachedRules();
    return cached.length === 0 ? true : hasRuleExtra(cached);
  });
  const [loading, setLoading] = useState(() => readCachedRules().length === 0 && !hasMatchRulesCache());

  const fetchRules = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (options.showLoading && rulesOverviewMemoryCache?.length !== 0) {
      setLoading(true);
    }

    try {
      const data = await apiRef.current.matchRules();
      if (!mountedRef.current) return;

      if (!Array.isArray(data?.rules)) {
        return;
      }

      const nextRules = data.rules.map((rule: any, index: number) => ({ ...rule, index }));
      rulesOverviewMemoryCache = nextRules;
      writeMatchRulesCache(nextRules);
      setRules(nextRules);
      setHasExtra(nextRules.length === 0 ? false : hasRuleExtra(nextRules));
    } catch (error) {
      if (!mountedRef.current) return;
      console.error('获取规则数据失败:', error);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchRules({ showLoading: false });

    const refreshRules = () => {
      void fetchRules();
    };

    const interval = setInterval(refreshRules, 30000);

    if (typeof window !== 'undefined') {
      window.addEventListener('profile-updated', refreshRules);
      window.addEventListener('backup-restored', refreshRules);
      window.addEventListener('subscription-auto-updated', refreshRules);
    }

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshRules();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshRules();
    });

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      if (typeof window !== 'undefined') {
        window.removeEventListener('profile-updated', refreshRules);
        window.removeEventListener('backup-restored', refreshRules);
        window.removeEventListener('subscription-auto-updated', refreshRules);
      }
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, [fetchRules]);

  useEffect(() => {
    return subscribeMatchRulesCache(() => {
      const cached = readCachedRules();
      if (cached.length > 0 || hasMatchRulesCache()) {
        rulesOverviewMemoryCache = cached;
        setRules(cached);
        setHasExtra(cached.length === 0 ? false : hasRuleExtra(cached));
      }
      setLoading(false);
    });
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

  if (loading && rules.length === 0) {
    return (
      <div className="flex h-[260px] flex-col space-y-5 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
        <div className="flex flex-shrink-0 items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('dashboard.rulesOverview')}
          </p>
          <Scale className="h-4 w-4 text-muted-foreground/70" />
        </div>
        <div className="flex-1 space-y-3 pt-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="h-3 w-32 rounded-full bg-slate-100 dark:bg-[#1f1f1f]" />
                <div className="h-3 w-10 rounded-full bg-slate-100 dark:bg-[#1f1f1f]" />
              </div>
              <div className="h-1.5 rounded-full bg-slate-100 dark:bg-[#1f1f1f]" />
            </div>
          ))}
        </div>
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
