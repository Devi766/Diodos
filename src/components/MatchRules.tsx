'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { MagnifyingGlassIcon, ReloadIcon } from '@radix-ui/react-icons';
import { FixedSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { useMihomoAPI } from '../services/mihomo-api';

type MatchRule = {
  type: string;
  payload: string;
  proxy: string;
  size?: number;
};

export default function MatchRules() {
  const [matchRulesList, setMatchRulesList] = useState<MatchRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mihomoAPI = useMihomoAPI();

  const fetchMatchRules = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await mihomoAPI.matchRules();
      setMatchRulesList(response.rules || []);
    } catch (error: any) {
      console.error('获取规则列表失败:', error);
      setErrorMessage(`获取规则列表失败: ${error.message || '未知错误'}`);
      setMatchRulesList([]);
    } finally {
      setIsLoading(false);
    }
  };

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
    return (
      <div style={style} className="px-4 py-1">
        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 hover:bg-slate-100 dark:hover:bg-slate-900/50 transition-colors">
          <div className="text-sm text-foreground font-medium mb-2 break-all">
            {rule.payload}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium">
              {rule.type}
            </span>
            <span className="text-muted-foreground">→</span>
            <span className="text-primary font-medium">{rule.proxy}</span>
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
            placeholder="搜索规则..."
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
          title="刷新规则列表"
        >
          <ReloadIcon className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          <span className="text-sm">刷新</span>
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
                <p className="text-sm">加载中...</p>
              </div>
            </div>
          ) : filteredRules.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {searchTerm ? '没有匹配的规则' : '暂无规则'}
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
          共 {filteredRules.length} 条规则
          {searchTerm && ` (从 ${matchRulesList.length} 条中筛选)`}
        </span>
      </div>
    </div>
  );
}

