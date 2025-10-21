'use client';

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { MagnifyingGlassIcon, TrashIcon, TargetIcon } from '@radix-ui/react-icons';

type LogLevel = 'error' | 'warning' | 'info' | 'debug';

interface LogEntry {
  type: LogLevel;
  payload: string;
  time: string;
}

const MAX_LOGS = 500;

const MihomoLogs: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  // 过滤日志
  const filteredLogs = useMemo(() => {
    if (!filter) return logs;
    const lowerFilter = filter.toLowerCase();
    return logs.filter(log => 
      log.payload.toLowerCase().includes(lowerFilter) || 
      log.type.toLowerCase().includes(lowerFilter)
    );
  }, [logs, filter]);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs, autoScroll]);

  // 监听日志事件
  useEffect(() => {
    if (!window.electronAPI) return;

    const handleLog = (log: LogEntry) => {
      setLogs(prev => {
        const newLogs = [...prev, { ...log, time: new Date().toLocaleString() }];
        // 限制日志数量
        if (newLogs.length > MAX_LOGS) {
          return newLogs.slice(-MAX_LOGS);
        }
        return newLogs;
      });
    };

    // 注册日志监听器
    window.electronAPI.onMihomoLogs?.(handleLog);

    return () => {
      // 清理监听器
      window.electronAPI.offMihomoLogs?.();
    };
  }, []);

  // 清空日志
  const handleClearLogs = () => {
    setLogs([]);
  };

  // 获取日志级别颜色
  const getLogLevelColor = (level: LogLevel) => {
    switch (level) {
      case 'error':
        return 'text-red-600 dark:text-red-400';
      case 'warning':
        return 'text-yellow-600 dark:text-yellow-400';
      case 'info':
        return 'text-blue-600 dark:text-blue-400';
      case 'debug':
        return 'text-slate-600 dark:text-slate-400';
      default:
        return 'text-foreground';
    }
  };

  // 获取日志级别背景色
  const getLogLevelBg = (level: LogLevel) => {
    switch (level) {
      case 'error':
        return 'bg-red-50 dark:bg-red-900/10';
      case 'warning':
        return 'bg-yellow-50 dark:bg-yellow-900/10';
      case 'info':
        return 'bg-blue-50 dark:bg-blue-900/10';
      case 'debug':
        return 'bg-slate-50 dark:bg-slate-900/10';
      default:
        return 'bg-muted/30';
    }
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
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索日志..."
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-[#2a2a2a] border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          )}
        </div>

        {/* 自动滚动按钮 */}
        <button
          onClick={() => setAutoScroll(!autoScroll)}
          className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-colors ${
            autoScroll
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-foreground hover:bg-muted/80'
          }`}
          title="自动滚动"
        >
          <TargetIcon className="w-4 h-4" />
          <span className="text-sm">自动滚动</span>
        </button>

        {/* 清空按钮 */}
        <button
          onClick={handleClearLogs}
          className="px-4 py-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg flex items-center gap-2 transition-colors"
          title="清空日志"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="text-sm">清空</span>
        </button>
      </div>

      {/* 日志列表 */}
      <div 
        ref={logsContainerRef}
        className="bg-white dark:bg-[#2a2a2a] rounded-xl shadow-sm overflow-hidden"
      >
        <div className="h-[calc(100vh-280px)] overflow-y-auto p-4 space-y-2">
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {filter ? '没有匹配的日志' : '暂无日志'}
            </div>
          ) : (
            filteredLogs.map((log, index) => (
              <div
                key={index}
                className={`p-3 rounded-lg ${getLogLevelBg(log.type)} transition-colors`}
              >
                <div className="flex items-center gap-3 mb-1">
                  <span className={`text-xs font-bold uppercase ${getLogLevelColor(log.type)}`}>
                    {log.type}
                  </span>
                  <span className="text-xs text-muted-foreground">{log.time}</span>
                </div>
                <div className="text-sm text-foreground font-mono break-all select-text">
                  {log.payload}
                </div>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* 日志统计 */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          共 {filteredLogs.length} 条日志
          {filter && ` (从 ${logs.length} 条中筛选)`}
        </span>
        <span>最多保留 {MAX_LOGS} 条</span>
      </div>
    </div>
  );
};

export default MihomoLogs;

