'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MagnifyingGlassIcon, ReloadIcon } from '@radix-ui/react-icons';
import { FixedSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { useMihomoAPI } from '../services/mihomo-api';
import { useTranslation } from 'react-i18next';
import {
  APP_DATA_CACHE_KEYS,
  hasAppDataCache,
  readAppDataCache,
  subscribeAppDataCache,
  writeAppDataCache,
} from '@/services/app-data-cache';

type MatchRule = {
  type: string;
  payload: string;
  proxy: string;
  size?: number;
  index: number;
  extra?: {
    disabled?: boolean;
    hitCount?: number;
    missCount?: number;
    hitAt?: string;
    missAt?: string;
  };
};

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const matchRulesViewCache: {
  rules: MatchRule[];
  loaded: boolean;
} = {
  rules: [],
  loaded: false,
};

const MATCH_RULES_CACHE_KEY = APP_DATA_CACHE_KEYS.matchRules;

const readMatchRulesSessionCache = (): MatchRule[] | null => {
  const cached = readAppDataCache<unknown>(MATCH_RULES_CACHE_KEY);
  return Array.isArray(cached) ? cached as MatchRule[] : null;
};

const hydrateMatchRulesFromSession = () => {
  if (matchRulesViewCache.loaded) return;
  const cached = readMatchRulesSessionCache();
  if (!cached) return;
  matchRulesViewCache.rules = cached;
  matchRulesViewCache.loaded = true;
};

export default function MatchRules() {
  const { t } = useTranslation();
  const [matchRulesList, setMatchRulesList] = useState<MatchRule[]>(() => {
    hydrateMatchRulesFromSession();
    return matchRulesViewCache.rules;
  });
  const [isLoading, setIsLoading] = useState(() => !matchRulesViewCache.loaded);
  const [searchTerm, setSearchTerm] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mihomoAPI = useMihomoAPI();
  const mihomoAPIRef = useRef(mihomoAPI);
  const matchRulesRef = useRef(matchRulesList);

  useEffect(() => {
    mihomoAPIRef.current = mihomoAPI;
  }, [mihomoAPI]);

  useEffect(() => {
    matchRulesViewCache.rules = matchRulesList;
    matchRulesRef.current = matchRulesList;
  }, [matchRulesList]);

  useEffect(() => {
    if (!isLoading) {
      matchRulesViewCache.loaded = true;
    }
  }, [isLoading]);

  useEffect(() => {
    return subscribeAppDataCache(MATCH_RULES_CACHE_KEY, () => {
      const cached = readMatchRulesSessionCache();
      if (!cached) return;
      matchRulesViewCache.rules = cached;
      matchRulesViewCache.loaded = true;
      setMatchRulesList(cached);
      setIsLoading(false);
    });
  }, []);

  const formatMatchRulesError = useCallback((error: unknown, fallback = t('matchRules.unknownError')) => {
    const message = error instanceof Error ? error.message : (error ? String(error) : fallback);
    if (message.includes(TAURI_RUNTIME_UNAVAILABLE)) {
      return t('matchRules.apiUnavailable');
    }
    if (message.includes('Mihomo service unavailable') || message.includes('Mihomo服务未运行')) {
      return t('matchRules.serviceUnavailable');
    }
    return message || fallback;
  }, [t]);

  const fetchMatchRules = useCallback(async () => {
    const coldLoad =
      matchRulesRef.current.length === 0 &&
      !matchRulesViewCache.loaded &&
      !hasAppDataCache(MATCH_RULES_CACHE_KEY);
    if (coldLoad) setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await mihomoAPIRef.current.matchRules();
      const rules = (response.rules || []).map((rule, idx) => ({
        ...rule,
        index: idx,
      }));
      writeAppDataCache(MATCH_RULES_CACHE_KEY, rules);
      setMatchRulesList(rules);
    } catch (error: any) {
      console.error('获取规则列表失败:', error);
      setErrorMessage(t('matchRules.fetchError', { error: formatMatchRulesError(error) }));
      if (matchRulesRef.current.length === 0 && !matchRulesViewCache.loaded) {
        setMatchRulesList([]);
      }
    } finally {
      if (coldLoad) setIsLoading(false);
    }
  }, [formatMatchRulesError, t]);

  useEffect(() => {
    fetchMatchRules();
  }, [fetchMatchRules]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshAfterProfileChange = () => {
      void fetchMatchRules();
    };

    window.addEventListener('profile-updated', refreshAfterProfileChange);
    window.addEventListener('backup-restored', refreshAfterProfileChange);
    window.addEventListener('subscription-auto-updated', refreshAfterProfileChange);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshAfterProfileChange();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshAfterProfileChange();
    });

    return () => {
      window.removeEventListener('profile-updated', refreshAfterProfileChange);
      window.removeEventListener('backup-restored', refreshAfterProfileChange);
      window.removeEventListener('subscription-auto-updated', refreshAfterProfileChange);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, [fetchMatchRules]);

  const filteredRules = useMemo(() => {
    if (!searchTerm) return matchRulesList;

    const lowerSearch = searchTerm.toLowerCase();
    return matchRulesList.filter(rule =>
      rule.payload.toLowerCase().includes(lowerSearch) ||
      rule.type.toLowerCase().includes(lowerSearch) ||
      rule.proxy.toLowerCase().includes(lowerSearch)
    );
  }, [matchRulesList, searchTerm]);

  const suppressColdEmptyState =
    isLoading &&
    filteredRules.length === 0 &&
    !matchRulesViewCache.loaded &&
    !hasAppDataCache(MATCH_RULES_CACHE_KEY);

  const RuleRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const rule = filteredRules[index];
    const isDisabled = !!rule.extra?.disabled;
    const hasExtra = !!rule.extra;

    return (
      <div style={style} className="px-4 py-1">
        <div className={`p-3 rounded-lg transition-colors flex items-center gap-3 ${
          isDisabled
            ? 'bg-slate-100/50 dark:bg-slate-900/10 opacity-50'
            : 'bg-slate-50 dark:bg-slate-900/30 hover:bg-slate-100 dark:hover:bg-slate-900/50'
        }`}>
          {hasExtra && (
            <button
              type="button"
              disabled
              title={t('matchRules.toggleUnavailable')}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                'opacity-60 cursor-not-allowed'
              } ${!isDisabled ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-600'}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                !isDisabled ? 'translate-x-4' : 'translate-x-0'
              }`} />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-medium mb-2 break-all ${
              isDisabled ? 'text-muted-foreground line-through' : 'text-foreground'
            }`}>
              {rule.payload}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium">
                {rule.type}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium">
                {rule.proxy}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex items-center gap-3">
        {/* 搜索框 */}
        <div className="flex-1 relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('matchRules.searchPlaceholder')}
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-[#2a2a2a] border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          )}
        </div>

        {/* 刷新按钮 */}
        <button
          onClick={fetchMatchRules}
          className="px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg flex items-center gap-2 transition-colors"
          title={t('matchRules.refreshTitle')}
        >
          <ReloadIcon className="w-4 h-4" />
          <span className="text-sm">{t('matchRules.refresh')}</span>
        </button>
      </div>

      {/* 规则列表 */}
      <div className="bg-white dark:bg-[#2a2a2a] rounded-xl shadow-sm overflow-hidden">
        <div className="h-[calc(100vh-280px)] custom-scrollbar">
          {suppressColdEmptyState ? (
            <div className="h-full" aria-busy="true" />
          ) : errorMessage ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-md rounded-xl border border-red-200 bg-red-50 p-5 text-center text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                <p className="text-sm">{errorMessage}</p>
                <button
                  type="button"
                  onClick={fetchMatchRules}
                  className="mt-4 inline-flex items-center justify-center rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-700"
                >
                  <ReloadIcon className="mr-2 h-4 w-4" />
                  {t('matchRules.retry')}
                </button>
              </div>
            </div>
          ) : filteredRules.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {searchTerm ? t('matchRules.noMatchingRules') : t('matchRules.noRules')}
            </div>
          ) : (
            <div style={{ height: '100%', paddingTop: '12px', paddingBottom: '12px' }}>
              <AutoSizer>
                {({ height, width }) => (
                  <List
                    height={height}
                    itemCount={filteredRules.length}
                    itemSize={85}
                    width={width}
                    className="custom-scrollbar"
                  >
                    {RuleRow}
                  </List>
                )}
              </AutoSizer>
            </div>
          )}
        </div>
      </div>

      {/* 规则统计 */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('matchRules.totalRules', { count: filteredRules.length })}
          {searchTerm && t('matchRules.filtered', { total: matchRulesList.length })}
        </span>
      </div>
    </div>
  );
}

