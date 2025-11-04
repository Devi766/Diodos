import React, { useState, useEffect, useMemo } from 'react';
import { Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type ViewMode = 'day' | 'month';

interface TrafficData {
  upload: number;
  download: number;
}

interface DayTrafficData extends TrafficData {
  date: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function TrafficStatisticsCard() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('trafficStatisticsViewMode');
      return (saved === 'month' ? 'month' : 'day') as ViewMode;
    } catch {
      return 'day';
    }
  });
  const [todayData, setTodayData] = useState<TrafficData>({ upload: 0, download: 0 });
  const [monthData, setMonthData] = useState<DayTrafficData[]>([]);
  const monthChartRef = React.useRef<HTMLDivElement>(null);
  const [hoveredDay, setHoveredDay] = useState<{ date: string; upload: number; download: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const loadTodayData = async () => {
      try {
        const result = await window.electronAPI.getTrafficToday();
        if (result.success && result.data) {
          setTodayData({
            upload: result.data.upload || 0,
            download: result.data.download || 0,
          });
        }
      } catch (error) {
        console.error('加载今日流量数据失败:', error);
      }
    };
    loadTodayData();
    const interval = setInterval(loadTodayData, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (viewMode !== 'month') return;
    const loadMonthData = async () => {
      try {
        const result = await window.electronAPI.getTrafficMonth();
        if (result.success && result.data) {
          setMonthData(result.data);
        }
      } catch (error) {
        console.error('加载本月流量数据失败:', error);
      }
    };
    loadMonthData();
  }, [viewMode]);

  // 自动滚动到今天的位置
  useEffect(() => {
    if (viewMode === 'month' && monthChartRef.current) {
      const today = new Date().getDate();
      const barWidth = 20; // 柱子宽度
      const gap = 2; // 间隙
      const scrollPosition = (today - 1) * (barWidth + gap) - monthChartRef.current.clientWidth / 2 + barWidth / 2;
      monthChartRef.current.scrollLeft = Math.max(0, scrollPosition);
    }
  }, [viewMode, monthData]);



  const pieData = useMemo(() => {
    let upload = 0;
    let download = 0;

    if (viewMode === 'day') {
      upload = todayData.upload;
      download = todayData.download;
    } else if (viewMode === 'month') {
      upload = monthData.reduce((sum, d) => sum + d.upload, 0);
      download = monthData.reduce((sum, d) => sum + d.download, 0);
    }

    return [
      { name: '上传', value: upload },
      { name: '下载', value: download },
    ];
  }, [viewMode, todayData, monthData]);

  const totalTraffic = useMemo(() => {
    return pieData.reduce((sum, item) => sum + item.value, 0);
  }, [pieData]);

  return (
    <div className="flex h-[260px] flex-col space-y-3 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
      {/* 标题和视图切换 */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.trafficStatistics')}
        </p>
        <div className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-[#1f1f1f]">
          <button
            onClick={() => {
              setViewMode('day');
              try {
                localStorage.setItem('trafficStatisticsViewMode', 'day');
              } catch (error) {
                console.error('保存视图模式失败:', error);
              }
            }}
            className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === 'day'
                ? 'bg-white text-primary shadow-sm dark:bg-[#222222] dark:text-primary'
                : 'text-gray-600 hover:text-gray-900 dark:bg-[#222222] dark:text-gray-300 dark:hover:bg-[#2a2a2a] dark:hover:text-gray-100'
            }`}
          >
            <Calendar className="h-3 w-3" />
            {t('dashboard.day')}
          </button>
          <button
            onClick={() => {
              setViewMode('month');
              try {
                localStorage.setItem('trafficStatisticsViewMode', 'month');
              } catch (error) {
                console.error('保存视图模式失败:', error);
              }
            }}
            className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === 'month'
                ? 'bg-white text-primary shadow-sm dark:bg-[#222222] dark:text-primary'
                : 'text-gray-600 hover:text-gray-900 dark:bg-[#222222] dark:text-gray-300 dark:hover:bg-[#2a2a2a] dark:hover:text-gray-100'
            }`}
          >
            <Calendar className="h-3 w-3" />
            {t('dashboard.month')}
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-x-hidden">
        <div className="space-y-3">
          {/* 当日流量 - 显示上传下载比例 */}
          {viewMode === 'day' && (
            <div className="space-y-3">
              {/* 总流量 */}
              <div className="text-center">
                <div className="text-xs text-muted-foreground">{t('dashboard.todayTotal')}</div>
                <div className="text-2xl font-semibold text-foreground mt-1">
                  {formatBytes(totalTraffic)}
                </div>
              </div>

              {/* 上传下载合并柱状图 */}
              <div className="space-y-3">
                <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden flex">
                  <div
                    className="h-full bg-gradient-to-r from-yellow-300 to-yellow-500 transition-all duration-300"
                    style={{
                      width: `${totalTraffic > 0 ? (pieData[0].value / totalTraffic) * 100 : 0}%`,
                    }}
                  />
                  <div
                    className="h-full bg-gradient-to-r from-blue-400 to-blue-600 transition-all duration-300"
                    style={{
                      width: `${totalTraffic > 0 ? (pieData[1].value / totalTraffic) * 100 : 0}%`,
                    }}
                  />
                </div>

                {/* 图例 */}
                <div className="flex items-center justify-center gap-6">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-gradient-to-r from-yellow-300 to-yellow-500" />
                    <div className="text-xs">
                      <span className="text-gray-600 dark:text-gray-400">{t('dashboard.upload')} </span>
                      <span className="font-medium text-yellow-500 dark:text-yellow-400">
                        {formatBytes(pieData[0].value)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-gradient-to-r from-blue-400 to-blue-600" />
                    <div className="text-xs">
                      <span className="text-gray-600 dark:text-gray-400">{t('dashboard.download')} </span>
                      <span className="font-medium text-blue-600 dark:text-blue-400">
                        {formatBytes(pieData[1].value)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 本月流量 - 柱状图 */}
          {viewMode === 'month' && (
            <div className="space-y-2">
              <div className="text-center">
                <div className="text-xs text-muted-foreground">{t('dashboard.monthTotal')}</div>
                <div className="text-xl font-semibold text-foreground mt-0.5">
                  {formatBytes(totalTraffic)}
                </div>
              </div>

              <div className="relative h-[110px] pt-2">
                {/* 柱状图容器 */}
                <div
                  ref={monthChartRef}
                  className="absolute inset-0 flex items-end justify-between gap-0.5 px-2 overflow-x-auto custom-scrollbar"
                >
                  {(() => {
                    // 获取当前月份的天数
                    const now = new Date();
                    const year = now.getFullYear();
                    const month = now.getMonth() + 1;
                    const daysInMonth = new Date(year, month, 0).getDate();

                    // 创建完整的月份数据(包括没有数据的天)
                    const fullMonthData = Array.from({ length: daysInMonth }, (_, i) => {
                      const day = i + 1;
                      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                      const existingData = monthData.find((d) => d.date === dateStr);
                      return {
                        date: dateStr,
                        upload: existingData?.upload || 0,
                        download: existingData?.download || 0,
                      };
                    });

                    const maxTraffic = Math.max(...fullMonthData.map((d) => d.upload + d.download), 1);

                    return fullMonthData.map((day) => {
                      const dayTotal = day.upload + day.download;
                      const percentage = maxTraffic > 0 ? (dayTotal / maxTraffic) * 100 : 0;
                      const dayNum = day.date.split('-')[2];

                      return (
                        <div
                          key={day.date}
                          className="flex-shrink-0 flex flex-col items-center gap-1 relative group"
                          style={{ width: '20px' }}
                          onMouseEnter={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setHoveredDay({
                              date: day.date,
                              upload: day.upload,
                              download: day.download,
                              x: rect.left + rect.width / 2,
                              y: rect.top - 10,
                            });
                          }}
                          onMouseLeave={() => setHoveredDay(null)}
                        >
                          {/* 柱子 */}
                          <div className="w-full flex flex-col justify-end" style={{ height: '75px' }}>
                            {dayTotal > 0 && (
                              <div
                                className="w-full bg-gradient-to-t from-blue-400 to-blue-600 rounded-t transition-all duration-300 group-hover:from-blue-500 group-hover:to-blue-700"
                                style={{ height: `${percentage}%` }}
                              />
                            )}
                          </div>
                          {/* 日期标签 */}
                          <div className="text-[9px] text-gray-500 dark:text-gray-400">{dayNum}</div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 悬停浮窗 */}
      {hoveredDay && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{
            left: `${hoveredDay.x}px`,
            top: `${hoveredDay.y}px`,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="bg-gray-900 dark:bg-gray-800 text-white px-3 py-2 rounded-lg shadow-lg text-xs whitespace-nowrap">
            <div className="font-medium mb-1">{hoveredDay.date}</div>
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-yellow-400">↑</span>
                <span>{formatBytes(hoveredDay.upload)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-blue-400">↓</span>
                <span>{formatBytes(hoveredDay.download)}</span>
              </div>
              <div className="flex items-center gap-2 pt-0.5 border-t border-gray-700">
                <span className="text-gray-400">{t('dashboard.total')}</span>
                <span className="font-medium">{formatBytes(hoveredDay.upload + hoveredDay.download)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
