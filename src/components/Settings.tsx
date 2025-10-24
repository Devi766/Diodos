import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Toast from '@radix-ui/react-toast';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useMihomoAPI } from '../services/mihomo-api';
import { Switch } from './ui/switch';
import OverrideSettings, { OverrideSettingsRef } from './OverrideSettings';
import { Button } from './ui/button';

export default function Settings() {
  const [startWithSystem, setStartWithSystem] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  const [theme, setTheme] = useState('system');
  const [appearanceMode, setAppearanceMode] = useState<'acrylic' | 'dynamic' | 'solid'>('dynamic');
  const [appVersion, setAppVersion] = useState('');
  const [subscriptionUA, setSubscriptionUA] = useState('MihomoParty');
  const [kernelPath, setKernelPath] = useState('');
  const [kernelIsDefault, setKernelIsDefault] = useState(true);
  const [kernelExists, setKernelExists] = useState(true);
  const isFirstRender = useRef(true);

  // Refs for override settings components
  const overrideSettingsRef = useRef<OverrideSettingsRef>(null);
  const [isSavingOverride, setIsSavingOverride] = useState(false);
  
  // Toast提示相关状态
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');

  const refreshKernelPath = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    try {
      const result = await window.electronAPI.getKernelPath();
      if (result && result.success) {
        setKernelPath(result.path || '');
        setKernelIsDefault(Boolean(result.isDefault));
        setKernelExists(result.exists !== false);
      }
    } catch (error) {
      console.error('获取内核路径失败:', error);
    }
  }, []);
  
  // 使用mihomo API
  let mihomoAPI = useMihomoAPI();

  // 在组件加载时获取保存的主题和应用版本号
  useEffect(() => {
    const fetchData = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
          // 获取API配置
          const apiConfigResult = await window.electronAPI.getApiConfig();
          if (apiConfigResult.success) {
            // 使用正确的API配置初始化mihomoAPI
            mihomoAPI = useMihomoAPI({
              host: apiConfigResult.controllerHost,
              port: apiConfigResult.controllerPort,
              secret: apiConfigResult.secret
            });
          }
          
          // 获取主题
          const themeResult = await window.electronAPI.getTheme();
          if (themeResult.success) {
            setTheme(themeResult.theme);
          }

          const appearanceResult = await window.electronAPI.getAppearanceMode?.();
          if (appearanceResult?.success && appearanceResult.mode) {
            setAppearanceMode(appearanceResult.mode as 'acrylic' | 'dynamic' | 'solid');
          }

          // 获取应用版本号
          const version = await window.electronAPI.getAppVersion();
          setAppVersion(version);
          
          // 获取开机启动状态
          const autoLaunchState = await window.electronAPI.getAutoLaunchState();
          setStartWithSystem(autoLaunchState);

          // 获取静默启动设置
          const silentStartResult = await window.electronAPI.getSilentStart();
          if (silentStartResult.success) {
            setSilentStart(silentStartResult.silentStart);
          }

          // 获取订阅UA设置
          const userSettings = await window.electronAPI.getProxySettings();
          if (userSettings.success && userSettings.settings && userSettings.settings['subscription-ua']) {
            setSubscriptionUA(userSettings.settings['subscription-ua']);
        }

        await refreshKernelPath();
      }
    } catch (error) {
      console.error('获取设置数据失败:', error);
    }
  };

    fetchData();

    // 监听主题变更事件
    const handleThemeChanged = async (_event: any, newTheme: string) => {
      // 获取当前保存的主题设置
      const themeResult = await window.electronAPI.getTheme();
      if (themeResult.success) {
        // 更新 theme state 为保存的设置值（可能是 'system'）
        setTheme(themeResult.theme);
      }

      // 更新文档的类名来应用实际主题
      if (newTheme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
      } else {
        document.documentElement.classList.add('light');
        document.documentElement.classList.remove('dark');
      }
    };

    // 监听服务重启事件
    const handleServiceRestarted = (result: {success: boolean, error?: string}) => {
      if (result.success) {
        showToast("服务已重启", "新设置已应用", "success");
        setIsSaving(false);
      } else {
        showToast("服务重启失败", result.error || "未知错误", "error");
        setIsSaving(false);
      }
    };

    // 添加事件监听器
    if (typeof window !== 'undefined' && window.electronAPI) {
      const removeThemeListener = window.electronAPI.onThemeChanged(handleThemeChanged);
      const removeServiceRestarted = window.electronAPI.onServiceRestarted(handleServiceRestarted);
      const removeAppearanceListener = window.electronAPI.onAppearanceModeChanged
        ? window.electronAPI.onAppearanceModeChanged((mode: 'acrylic' | 'dynamic' | 'solid') => {
            setAppearanceMode(mode);
          })
        : undefined;

      // 清理函数
      return () => {
        window.electronAPI?.removeThemeListener?.();
        if (typeof removeThemeListener === 'function') removeThemeListener();
        if (typeof removeServiceRestarted === 'function') removeServiceRestarted();
        if (typeof removeAppearanceListener === 'function') removeAppearanceListener();
      };
    }
    return undefined;
  }, [refreshKernelPath]);

  // 监听开机启动设置变化
  const updateAutoLaunch = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        // 使用新的API设置开机启动
        await window.electronAPI.setAutoLaunch(startWithSystem);
        console.log('开机启动设置已更新:', startWithSystem);
      } catch (error) {
        console.error('更新开机启动设置失败:', error);
        // 如果设置失败，可以恢复UI状态（可选）
        try {
          const currentState = await window.electronAPI.getAutoLaunchState();
          setStartWithSystem(currentState);
        } catch {}
      }
    }
  }, [startWithSystem]);

  // 监听静默启动设置变化
  const updateSilentStart = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        const result = await window.electronAPI.setSilentStart(silentStart);
        if (result.success) {
          console.log('静默启动设置已更新:', silentStart);
        } else {
          console.error('更新静默启动设置失败:', result.error);
        }
      } catch (error) {
        console.error('更新静默启动设置失败:', error);
      }
    }
  }, [silentStart]);
  
  useEffect(() => {
    // 组件首次加载时不调用，只在状态变化时调用
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    updateAutoLaunch();
  }, [updateAutoLaunch]);

  useEffect(() => {
    // 组件首次加载时不调用，只在状态变化时调用
    if (isFirstRender.current) {
      return;
    }

    updateSilentStart();
  }, [updateSilentStart]);

  // 处理主题切换
  const handleThemeChange = async (newTheme: string) => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.setTheme(newTheme);
        if (result.success) {
          setTheme(newTheme);

          // 直接更新文档的类名来立即应用主题
          let actualTheme = newTheme;
          if (newTheme === 'system') {
            actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
          }

          if (actualTheme === 'dark') {
            document.documentElement.classList.add('dark');
            document.documentElement.classList.remove('light');
          } else {
            document.documentElement.classList.add('light');
            document.documentElement.classList.remove('dark');
          }
        }
      }
    } catch (error) {
      console.error('设置主题失败:', error);
    }
  };

  const handleAppearanceModeChange = async (mode: 'acrylic' | 'dynamic' | 'solid') => {
    if (appearanceMode === mode) {
      return;
    }

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.setAppearanceMode) {
        const result = await window.electronAPI.setAppearanceMode(mode);
        if (result.success) {
          setAppearanceMode(mode);
          showToast('成功', '窗口背景效果已更新', 'success');
        } else {
          showToast('错误', result.error || '更新窗口背景失败', 'error');
        }
      }
    } catch (error) {
      console.error('设置外观失败:', error);
      showToast('错误', `设置窗口背景失败: ${error}`, 'error');
    }
  };

  // 获取用户设置
  useEffect(() => {
    const fetchUserSettings = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
          const result = await window.electronAPI.getProxySettings();
          
          if (result.success && result.settings) {
            console.log('获取到的设置:', result.settings);
            if (result.settings['appearanceMode']) {
              setAppearanceMode(result.settings['appearanceMode'] as 'acrylic' | 'dynamic' | 'solid');
            }
          }
        }
      } catch (error) {
        console.error('获取用户设置失败:', error);
      }
    };

    fetchUserSettings();
    refreshKernelPath();
  }, []);

  // 显示Toast提示
  const showToast = (title: string, description: string, type: 'success' | 'error') => {
    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(true);
  };

  const handleSelectKernel = async () => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    try {
      const result = await window.electronAPI.selectKernelExecutable();

      if (result?.success) {
        await refreshKernelPath();
        const message = result.needsRestart
          ? '内核路径已更新，请重新启动内核以生效'
          : '内核路径已更新';
        showToast('成功', message, 'success');
      } else if (!result?.canceled) {
        showToast('错误', result?.error || '选择内核文件失败', 'error');
      }
    } catch (error) {
      console.error('选择内核文件失败:', error);
      showToast('错误', String(error), 'error');
    }
  };

  const handleResetKernel = async () => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    try {
      const result = await window.electronAPI.resetKernelPath();
      if (result?.success) {
        await refreshKernelPath();
        const message = result.needsRestart
          ? '已恢复默认内核，请重新启动内核以生效'
          : '已恢复默认内核';
        showToast('成功', message, 'success');
      } else {
        showToast('错误', result?.error || '恢复默认内核失败', 'error');
      }
    } catch (error) {
      console.error('恢复默认内核失败:', error);
      showToast('错误', String(error), 'error');
    }
  };

  // 保存主题设置
  const saveThemeSettings = async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        const result = await window.electronAPI.setTheme(theme);
        if (result.success) {
          showToast('成功', '主题设置已保存', 'success');
        } else {
          showToast('错误', `保存主题设置失败: ${result.error}`, 'error');
        }
      } catch (error) {
        console.error('保存主题设置失败:', error);
        showToast('错误', `保存主题设置失败: ${error}`, 'error');
      }
    }
  };

  return (
    <div>
      <Toast.Provider swipeDirection="right">

        <div className="bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm p-6">
          <Tabs.Root defaultValue="general" className="w-full">
            <Tabs.List className="flex border-b border-gray-200 dark:border-gray-600 mb-6">
              <Tabs.Trigger
                value="general"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                常规
              </Tabs.Trigger>
              <Tabs.Trigger
                value="kernel"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                内核
              </Tabs.Trigger>
              <Tabs.Trigger
                value="override"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                覆写
              </Tabs.Trigger>
              <Tabs.Trigger
                value="about"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                关于
              </Tabs.Trigger>
            </Tabs.List>
            
            <Tabs.Content value="general" className="w-full">
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">开机启动</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">启动计算机时自动启动FlyClash</p>
                  </div>
                  <Switch
                    checked={startWithSystem}
                    onCheckedChange={setStartWithSystem}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">静默启动</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">启动时不显示主窗口，仅在托盘后台运行</p>
                  </div>
                  <Switch
                    checked={silentStart}
                    onCheckedChange={setSilentStart}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">最小化到托盘</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">关闭窗口时最小化到系统托盘</p>
                  </div>
                  <Switch
                    checked={minimizeToTray}
                    onCheckedChange={setMinimizeToTray}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">自动检查更新</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">启动时自动检查是否有新版本</p>
                  </div>
                  <Switch
                    checked={autoCheckUpdate}
                    onCheckedChange={setAutoCheckUpdate}
                  />
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">订阅下载 User-Agent</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">不同的 User-Agent 可能会影响订阅服务器返回的配置格式</p>
                  <select
                    className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                    value={subscriptionUA}
                    onChange={(e) => {
                      const newUA = e.target.value;
                      setSubscriptionUA(newUA);
                      
                      // 使用专用API保存UA设置，不会重启服务
                      if (typeof window !== 'undefined' && window.electronAPI) {
                        window.electronAPI.saveUASettings(newUA)
                          .then(result => {
                            if (result.success) {
                              showToast('成功', 'UA设置已保存', 'success');
                            } else {
                              showToast('错误', `保存UA设置失败: ${result.error}`, 'error');
                            }
                          })
                          .catch(error => {
                            console.error('保存UA设置失败:', error);
                            showToast('错误', `保存UA设置失败: ${error}`, 'error');
                          });
                      }
                    }}
                  >
                    <option value="FlyClash">FlyClash</option>
                    <option value="Clash">Clash for Windows</option>
                    <option value="Mihomo">Mihomo</option>
                    <option value="MihomoParty">Clash Meta（默认）</option>
                    <option value="Chrome">Chrome浏览器</option>
                  </select>
                </div>
                
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">主题</h3>
                  <div className="flex gap-2">
                    <button
                      className={`py-1.5 px-3 text-sm rounded-lg transition-all duration-300 transform hover:scale-105 ${
                        theme === 'light'
                          ? 'bg-gradient-to-r from-blue-400 to-blue-500 text-white shadow-md'
                          : 'bg-gradient-to-r from-gray-100 to-gray-200 dark:from-[#2a2a2a] dark:to-[#333333] text-gray-700 dark:text-gray-200 hover:shadow-md'
                      }`}
                      onClick={() => handleThemeChange('light')}
                    >
                      浅色
                    </button>
                    <button
                      className={`py-1.5 px-3 text-sm rounded-lg transition-all duration-300 transform hover:scale-105 ${
                        theme === 'dark'
                          ? 'bg-gradient-to-r from-blue-400 to-blue-500 text-white shadow-md'
                          : 'bg-gradient-to-r from-gray-100 to-gray-200 dark:from-[#2a2a2a] dark:to-[#333333] text-gray-700 dark:text-gray-200 hover:shadow-md'
                      }`}
                      onClick={() => handleThemeChange('dark')}
                    >
                      深色
                    </button>
                    <button
                      className={`py-1.5 px-3 text-sm rounded-lg transition-all duration-300 transform hover:scale-105 ${
                        theme === 'system'
                          ? 'bg-gradient-to-r from-blue-400 to-blue-500 text-white shadow-md'
                          : 'bg-gradient-to-r from-gray-100 to-gray-200 dark:from-[#2a2a2a] dark:to-[#333333] text-gray-700 dark:text-gray-200 hover:shadow-md'
                      }`}
                      onClick={() => handleThemeChange('system')}
                    >
                      跟随系统
                    </button>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">窗口背景效果</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">选择最适合你的桌面毛玻璃效果</p>
                  <div className="flex flex-wrap gap-2">
                    {/* macOS 只显示默认和纯色背景 */}
                    {typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac') ? (
                      <>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'dynamic' || appearanceMode === 'acrylic'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('dynamic')}
                        >
                          默认
                        </button>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'solid'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('solid')}
                        >
                          纯色背景
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'dynamic'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('dynamic')}
                        >
                          默认
                        </button>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'acrylic'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('acrylic')}
                        >
                          动态模糊
                        </button>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'solid'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('solid')}
                        >
                          纯色背景
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="kernel" className="w-full">
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">Clash 内核</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
                    应用默认使用内置的内核文件，你也可以手动指定其他版本的 Clash 内核。
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      type="text"
                      className="flex-1 py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                      value={kernelPath}
                      readOnly
                      spellCheck={false}
                    />
                    <div className="flex gap-2">
                      <button
                        className="py-1.5 px-3 text-sm rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors shadow-sm"
                        onClick={handleSelectKernel}
                      >
                        选择文件
                      </button>
                      <button
                        className={`py-1.5 px-3 text-sm rounded-lg transition-colors shadow-sm ${
                          kernelIsDefault && kernelExists
                            ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-[#2a2a2a] dark:text-gray-500'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:text-gray-200 dark:hover:bg-[#333333]'
                        }`}
                        onClick={handleResetKernel}
                        disabled={kernelIsDefault && kernelExists}
                      >
                        恢复默认
                      </button>
                    </div>
                  </div>
                  {!kernelExists && (
                    <p className="text-xs text-red-500 dark:text-red-400 mt-2">
                      无法找到当前配置的内核文件，请重新选择或恢复默认设置。
                    </p>
                  )}
                  {kernelIsDefault && kernelExists && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      正在使用内置的默认内核文件。
                    </p>
                  )}
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="override" className="w-full">
              <div className="space-y-8">
                <OverrideSettings ref={overrideSettingsRef} />

                {/* 统一保存按钮 */}
                <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-gray-700">
                  <Button
                    onClick={async () => {
                      setIsSavingOverride(true);
                      try {
                        await overrideSettingsRef.current?.saveConfig();
                        showToast('成功', '所有配置已保存并应用', 'success');
                      } catch (error) {
                        console.error('保存配置时出错:', error);
                        showToast('错误', '保存配置时出错: ' + error, 'error');
                      } finally {
                        setIsSavingOverride(false);
                      }
                    }}
                    disabled={isSavingOverride}
                    className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                  >
                    {isSavingOverride ? '保存中...' : '保存所有配置'}
                  </Button>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="about" className="w-full">
              <div className="flex flex-col items-center text-center py-8">
                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">FlyClash</h2>
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">版本: V0.1.7</p>
                
                <div className="bg-gray-50 dark:bg-[#222222] p-4 rounded-md mb-6 text-left w-full max-w-lg">
                  <p className="text-sm text-gray-700 dark:text-gray-200 mb-2">
                    FlyClash 是一个基于 Clash 内核的现代化代理客户端，拥有美观的界面和强大的功能。
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-200">
                   功能强大，简单易用，免费无广告
                  </p>
                </div>
                
                <div className="flex gap-4">
                  <a
                    className="flex items-center justify-center py-2 px-4 bg-gradient-to-r from-gray-200 to-gray-300 hover:from-gray-300 hover:to-gray-400 dark:from-gray-700 dark:to-gray-800 dark:hover:from-gray-600 dark:hover:to-gray-700 text-gray-800 dark:text-gray-200 rounded-lg transition-all duration-300 transform hover:scale-105 hover:shadow-lg"
                    href="https://github.com/MetaCubeX/mihomo"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Clash 项目
                  </a>
                  <a
                    className="flex items-center justify-center py-2 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-lg transition-all duration-300 transform hover:scale-105 hover:shadow-lg"
                    href="https://github.com/GtxFury/FlyClash"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    FlyClash 项目
                  </a>
                </div>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </div>
        
        {/* Toast提示组件 */}
        <Toast.Root
          open={toastOpen} 
          onOpenChange={setToastOpen}
          className={`fixed bottom-4 right-4 p-4 rounded-md shadow-md ${
            toastType === 'success' 
              ? 'bg-green-500 text-white' 
              : 'bg-red-500 text-white'
          }`}
        >
          <Toast.Title className="font-medium">{toastTitle}</Toast.Title>
          <Toast.Description>{toastDescription}</Toast.Description>
          <Toast.Close asChild>
            <button 
              className="absolute top-2 right-2 text-white" 
              aria-label="Close"
            >
              <Cross2Icon />
            </button>
          </Toast.Close>
        </Toast.Root>
        
        <Toast.Viewport />
      </Toast.Provider>
    </div>
  );
} 
