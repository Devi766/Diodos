'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { MagnifyingGlassIcon, ReloadIcon } from '@radix-ui/react-icons';
import { FixedSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { useMihomoAPI } from '../services/mihomo-api';
import { useTranslation } from 'react-i18next';

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

export default function MatchRules() {
  const { t } = useTranslation();
  const [matchRulesList, setMatchRulesList] = useState<MatchRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [togglingIndices, setTogglingIndices] = useState<Set<number>>(new Set());
  const mihomoAPI = useMihomoAPI();

  const fetchMatchRules = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await mihomoAPI.matchRules();
      const rules = (response.rules || []).map((rule, idx) => ({
        ...rule,
        index: idx,
      }));
      setMatchRulesList(rules);
    } catch (error: any) {
      console.error('获取规则列表失败:', error);
      setErrorMessage(t('matchRules.fetchError', { error: error.message || '未知错误' }));
      setMatchRulesList([]);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleRule = useCallback(async (rule: MatchRule) => {
    if (togglingIndices.has(rule.index)) return;

    setTogglingIndices(prev => new Set(prev).add(rule.index));
    try {
      const willBeDisabled = !rule.extra?.disabled;
      await mihomoAPI.toggleRuleDisabled({ [rule.index]: willBeDisabled });
      // 乐观更新
      setMatchRulesList(prev => prev.map(r =>
        r.index === rule.index
          ? { ...r, extra: { ...r.extra, disabled: willBeDisabled } }
          : r
      ));
    } catch (error: any) {
      console.error('切换规则状态失败:', error);
      // 失败时刷新列表
      await fetchMatchRules();
    } finally {
      setTogglingIndices(prev => {
        const next = new Set(prev);
        next.delete(rule.index);
        return next;
      });
    }
  }, [togglingIndices, mihomoAPI]);

  useEffect(() => {
    fetchMatchRules();
  }, []);

  const filteredRules = useMemo(() => {
    if (!searchTerm) return matchRulesList;

    const lowerSearch = searchTerm.toLowerCase();
    return matchRulesList.filter(rule =>
      rule.payload.toLowerCase().includes(lowerSearch) ||
      rule.type.toLowerCase().includes(lowerSearch) ||
      rule.proxy.toLowerCase().includes(lowerSearch)
    );
  }, [matchRulesList, searchTerm]);

  const RuleRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const rule = filteredRules[index];
    const isDisabled = !!rule.extra?.disabled;
    const isToggling = togglingIndices.has(rule.index);
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
              onClick={() => toggleRule(rule)}
              disabled={isToggling}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                isToggling ? 'opacity-50 cursor-wait' : ''
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
          disabled={isLoading}
          className="px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
          title={t('matchRules.refreshTitle')}
        >
          <ReloadIcon className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          <span className="text-sm">{t('matchRules.refresh')}</span>
        </button>
      </div>

      {/* 错误提示 */}
      {errorMessage && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {errorMessage}
        </div>
      )}

      {/* 规则列表 */}
      <div className="bg-white dark:bg-[#2a2a2a] rounded-xl shadow-sm overflow-hidden">
        <div className="h-[calc(100vh-280px)] custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <ReloadIcon className="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
                <p className="text-sm">{t('matchRules.loading')}</p>
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

