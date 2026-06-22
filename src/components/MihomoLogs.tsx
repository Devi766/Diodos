'use client';

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DownloadIcon, MagnifyingGlassIcon, TrashIcon, TargetIcon } from '@radix-ui/react-icons';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';
import {
  APP_DATA_CACHE_KEYS,
  hasAppDataCache,
  readAppDataCache,
  subscribeAppDataCache,
  writeAppDataCache,
} from '@/services/app-data-cache';

type LogLevel = 'error' | 'warning' | 'info' | 'debug';

interface LogEntry {
  type: LogLevel;
  payload: string;
  time: string;
}

const MAX_LOGS = 500;

const logsViewCache: {
  logs: LogEntry[];
  loaded: boolean;
} = {
  logs: [],
  loaded: false,
};

const normalizeLogLevel = (level: unknown): LogLevel => {
  const normalized = String(level || 'info').toLowerCase();
  if (normalized === 'error') return 'error';
  if (normalized === 'warn' || normalized === 'warning') return 'warning';
  if (normalized === 'debug') return 'debug';
  return 'info';
};

const formatLogTime = (time: unknown) => {
  if (!time) return new Date().toLocaleString();
  if (typeof time === 'number') return new Date(time).toLocaleString();
  const text = String(time);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleString();
};

const normalizeLog = (log: unknown): LogEntry | null => {
  if (!log) return null;

  if (typeof log === 'string') {
    return {
      type: normalizeLogLevel(log),
      payload: log,
      time: new Date().toLocaleString(),
    };
  }

  if (typeof log !== 'object') return null;
  const record = log as Record<string, unknown>;
  const payload = record.payload ?? record.message ?? record.msg ?? record.text;

  return {
    type: normalizeLogLevel(record.type ?? record.level),
    payload: payload ? String(payload) : JSON.stringify(log),
    time: formatLogTime(record.time ?? record.timestamp),
  };
};

const LOGS_CACHE_KEY = APP_DATA_CACHE_KEYS.logs;

const readLogsSessionCache = (): LogEntry[] | null => {
  const cached = readAppDataCache<unknown>(LOGS_CACHE_KEY);
  if (!Array.isArray(cached)) return null;
  return cached.map(normalizeLog).filter((entry): entry is LogEntry => Boolean(entry)).slice(-MAX_LOGS);
};

const hydrateLogsFromSession = () => {
  if (logsViewCache.loaded) return;
  const cached = readLogsSessionCache();
  if (!cached) return;
  logsViewCache.logs = cached;
  logsViewCache.loaded = true;
};

const MihomoLogs: React.FC = () => {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>(() => {
    hydrateLogsFromSession();
    return logsViewCache.logs;
  });
  const [isLoadingLogs, setIsLoadingLogs] = useState(() => !logsViewCache.loaded);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [savingLogs, setSavingLogs] = useState(false);
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

  useEffect(() => {
    logsViewCache.logs = logs;
  }, [logs]);

  useEffect(() => {
    if (!isLoadingLogs) {
      logsViewCache.loaded = true;
    }
  }, [isLoadingLogs]);

  useEffect(() => {
    return subscribeAppDataCache(LOGS_CACHE_KEY, () => {
      const cached = readLogsSessionCache();
      if (!cached) return;
      logsViewCache.logs = cached;
      logsViewCache.loaded = true;
      setLogs(cached);
      setIsLoadingLogs(false);
    });
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs, autoScroll]);

  // 监听日志事件
  useEffect(() => {
    const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!electron) {
      setIsLoadingLogs(false);
      return;
    }
    const isTauriRuntime = Boolean((window as any).__TAURI__);

    const handleLog = (log: unknown) => {
      const entry = normalizeLog(log);
      if (!entry) return;
      setIsLoadingLogs(false);
      setLogs(prev => {
        const newLogs = [...prev, entry];
        // 限制日志数量
        if (newLogs.length > MAX_LOGS) {
          return newLogs.slice(-MAX_LOGS);
        }
        return newLogs;
      });
    };

    // 注册日志监听器
    const cleanup = electron.onMihomoLogs?.(handleLog);
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const loadLogSnapshot = async (initial = false) => {
      if (!electron.getLogs) {
        if (initial) setIsLoadingLogs(false);
        return;
      }

      try {
        const result = await electron.getLogs();
        if (result && typeof result === 'object' && !Array.isArray(result) && (result as { success?: boolean }).success === false) {
          console.error('加载 Mihomo 日志失败:', (result as { error?: string; message?: string }).error || (result as { message?: string }).message);
          return;
        }
        const entries = Array.isArray(result)
          ? result.map(normalizeLog).filter((entry): entry is LogEntry => Boolean(entry))
          : [];
        writeAppDataCache(LOGS_CACHE_KEY, entries.slice(-MAX_LOGS));
        setLogs(entries.slice(-MAX_LOGS));
      } catch (error) {
        console.error('加载 Mihomo 日志失败:', error);
      } finally {
        if (initial) {
          setIsLoadingLogs(false);
        }
      }
    };

    if (isTauriRuntime) {
      void loadLogSnapshot(true);
      pollTimer = setInterval(() => {
        void loadLogSnapshot(false);
      }, 2000);
    } else {
      setIsLoadingLogs(false);
    }

    return () => {
      // 清理监听器
      if (typeof cleanup === 'function') {
        cleanup();
      } else {
        electron.offMihomoLogs?.();
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    };
  }, []);

  // 清空日志
  const handleClearLogs = async () => {
    const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!electron?.clearLogs) {
      showToast({ message: t('logs.clearUnavailable'), type: 'error' });
      return;
    }

    try {
      const result = await electron.clearLogs();
      if (!result || result.success !== true) {
        throw new Error(result?.error || t('logs.clearFailed'));
      }
      setLogs([]);
      showToast({ message: t('logs.clearSuccess'), type: 'success' });
    } catch (error) {
      showToast({
        message: t('logs.clearFailedWithError', {
          error: error instanceof Error ? error.message : String(error),
        }),
        type: 'error',
      });
    }
  };

  const handleSaveLogs = async () => {
    const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const logsToSave = filter ? filteredLogs : logs;

    if (logsToSave.length === 0) {
      showToast({ message: t('logs.noLogsToExport'), type: 'warning' });
      return;
    }

    if (!electron?.saveLogs) {
      showToast({ message: t('logs.exportUnavailable'), type: 'error' });
      return;
    }

    setSavingLogs(true);
    try {
      const result = await electron.saveLogs(logsToSave.map(log => ({
        type: log.type,
        payload: log.payload,
        content: log.payload,
        time: log.time,
        timestamp: log.time,
      })));

      if (!result || result.success !== true) {
        throw new Error(result?.error || t('logs.exportFailed'));
      }

      showToast({
        message: result?.filePath
          ? t('logs.exportSuccessWithPath', { path: result.filePath })
          : t('logs.exportSuccess'),
        type: 'success',
        duration: 6000,
      });
    } catch (error) {
      showToast({
        message: t('logs.exportFailedWithError', {
          error: error instanceof Error ? error.message : String(error),
        }),
        type: 'error',
        duration: 5000,
      });
    } finally {
      setSavingLogs(false);
    }
  };

  // 获取日志级别颜色和背景
  const getLogLevelColor = (level: LogLevel) => {
    switch (level) {
      case 'error':
        return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300';
      case 'warning':
        return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300';
      case 'info':
        return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300';
      case 'debug':
        return 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
      default:
        return 'bg-slate-100 dark:bg-slate-800 text-foreground';
    }
  };

  // 获取日志级别背景色 - 统一使用浅色背景
  const getLogLevelBg = () => {
    return 'bg-slate-50 dark:bg-slate-900/30 hover:bg-slate-100 dark:hover:bg-slate-900/50';
  };

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-3">
        {/* 搜索框 */}
        <div className="min-w-[220px] flex-1 relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('logs.searchPlaceholder')}
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
          title={t('logs.autoScrollTitle')}
        >
          <TargetIcon className="w-4 h-4" />
          <span className="text-sm">{t('logs.autoScroll')}</span>
        </button>

        {/* 导出按钮 */}
        <button
          onClick={handleSaveLogs}
          disabled={savingLogs || (filter ? filteredLogs.length === 0 : logs.length === 0)}
          className="px-4 py-2 bg-muted text-foreground hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap"
          title={t('logs.exportTitle')}
        >
          <DownloadIcon className="w-4 h-4" />
          <span className="text-sm">{savingLogs ? t('logs.exporting') : t('logs.export')}</span>
        </button>

        {/* 清空按钮 */}
        <button
          onClick={handleClearLogs}
          className="px-4 py-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap"
          title={t('logs.clearTitle')}
        >
          <TrashIcon className="w-4 h-4" />
          <span className="text-sm">{t('logs.clear')}</span>
        </button>
      </div>

      {/* 日志列表 */}
      <div 
        ref={logsContainerRef}
        className="bg-white dark:bg-[#2a2a2a] rounded-xl shadow-sm overflow-hidden"
      >
        <div className="h-[calc(100vh-280px)] overflow-y-auto p-4 space-y-2">
          {isLoadingLogs &&
          filteredLogs.length === 0 &&
          !logsViewCache.loaded &&
          !hasAppDataCache(LOGS_CACHE_KEY) ? (
            <div className="h-full" aria-busy="true" />
          ) : filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {filter ? t('logs.noMatchingLogs') : t('logs.noLogs')}
            </div>
          ) : (
            filteredLogs.map((log, index) => (
              <div
                key={index}
                className={`p-3 rounded-lg ${getLogLevelBg()} transition-colors`}
              >
                <div className="flex items-center gap-3 mb-1">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${getLogLevelColor(log.type)}`}>
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
          {t('logs.totalLogs', { count: filteredLogs.length })}
          {filter && t('logs.filtered', { total: logs.length })}
        </span>
        <span>{t('logs.maxLogs', { max: MAX_LOGS })}</span>
      </div>
    </div>
  );
};

export default MihomoLogs;

