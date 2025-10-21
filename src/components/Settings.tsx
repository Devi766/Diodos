import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Toast from '@radix-ui/react-toast';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useMihomoAPI } from '../services/mihomo-api';
import { Switch } from './ui/switch';

export default function Settings() {
  const [startWithSystem, setStartWithSystem] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  const [theme, setTheme] = useState('system');
  const [appVersion, setAppVersion] = useState('');
  const [subscriptionUA, setSubscriptionUA] = useState('MihomoParty');
  const [kernelPath, setKernelPath] = useState('');
  const [kernelIsDefault, setKernelIsDefault] = useState(true);
  const [kernelExists, setKernelExists] = useState(true);
  const isFirstRender = useRef(true);
  
  // 代理设置相关状态
  const [mixedPort, setMixedPort] = useState(7890);
  const [allowLan, setAllowLan] = useState(false);
  const [enableIPv6, setEnableIPv6] = useState(false);
  const [mihomoSecret, setMihomoSecret] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  
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
    const handleThemeChanged = (_event: any, newTheme: string) => {
      setTheme(newTheme);
      
      // 更新文档的类名来应用主题
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
      window.electronAPI.onThemeChanged(handleThemeChanged);
      window.electronAPI.onServiceRestarted(handleServiceRestarted);

      // 清理函数
      return () => {
        window.electronAPI?.removeThemeListener();
        // 移除服务重启事件监听
        const cleanupServiceRestarted = window.electronAPI?.onServiceRestarted(() => {});
        if (cleanupServiceRestarted) cleanupServiceRestarted();
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
          if (result.theme === 'dark' || (result.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
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

  // 获取用户设置
  useEffect(() => {
    const fetchUserSettings = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
          const result = await window.electronAPI.getProxySettings();
          
          if (result.success && result.settings) {
            console.log('获取到的设置:', result.settings);
            setMixedPort(result.settings['mixed-port'] || 7890);
            setAllowLan(Boolean(result.settings['allow-lan'] || false));
            setEnableIPv6(Boolean(result.settings['ipv6'] || false));
            setMihomoSecret(result.settings['secret'] || '');
            setConfigLoaded(true);
          } else {
            // 如果electronAPI失败，尝试从mihomo获取当前配置
            await fetchMihomoConfig();
          }
        } else {
          // 如果electronAPI不可用，尝试从mihomo获取当前配置
          await fetchMihomoConfig();
        }
      } catch (error) {
        console.error('获取用户设置失败:', error);
        // 出错时尝试从mihomo获取当前配置
        await fetchMihomoConfig();
      }
    };

    const fetchMihomoConfig = async () => {
      try {
        const config = await mihomoAPI.configs();
        if (config) {
          setMixedPort(config['mixed-port'] || 7890);
          setAllowLan(config['allow-lan'] || false);
          setEnableIPv6(config['ipv6'] || false);
          setMihomoSecret(config['secret'] || '');
          setConfigLoaded(true);
        }
      } catch (error) {
        console.error('获取mihomo配置失败:', error);
      }
    };

    fetchUserSettings();
    refreshKernelPath();
  }, [refreshKernelPath]);

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

  // 保存代理设置
  const saveProxySettings = async () => {
    try {
      setIsSaving(true);
      
      // 确保数值类型正确
      const portValue = parseInt(mixedPort.toString(), 10);
      if (isNaN(portValue) || portValue < 1024 || portValue > 65535) {
        showToast('错误', '端口号必须是1024-65535之间的有效数字', 'error');
        setIsSaving(false);
        return;
      }
      
      // 确保布尔值类型正确
      const lanAccess = allowLan === true;
      const ipv6Enabled = enableIPv6 === true;
      
      // 更新所有相关配置项，包括订阅UA和密钥
      const configUpdate = {
        'mixed-port': portValue,
        'allow-lan': lanAccess,
        'ipv6': ipv6Enabled,
        'secret': mihomoSecret,
        'subscription-ua': subscriptionUA
      };
      
      console.log('提交配置更新:', configUpdate);
      
      if (typeof window !== 'undefined' && window.electronAPI) {
        // 使用新的API保存设置
        const result = await window.electronAPI.saveProxySettings(configUpdate);
        if (result.success) {
          showToast('成功', result.message || '设置已保存', 'success');
        } else {
          showToast('错误', `保存设置失败: ${result.error}`, 'error');
        }
      } else {
        // 兼容旧方法：直接使用mihomo API
        await mihomoAPI.patchConfigs(configUpdate);
        if (typeof window !== 'undefined' && window.electronAPI) {
          const result = await window.electronAPI.restartService();
          if (result.success) {
            showToast('成功', '设置已保存，服务已重启', 'success');
          } else {
            showToast('错误', `保存设置成功，但重启服务失败: ${result.message}`, 'error');
          }
        }
      }
    } catch (error) {
      console.error('保存代理设置失败:', error);
      showToast('错误', `保存设置失败: ${error}`, 'error');
    } finally {
      setIsSaving(false);
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
                value="proxy"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                代理
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
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">Mihomo 内核</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
                    应用默认使用内置的内核文件，你也可以手动指定其他版本的 Mihomo 内核。
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
              </div>
            </Tabs.Content>
            
            <Tabs.Content value="proxy" className="w-full">
              <div className="space-y-6">
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">代理端口设置</h3>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-300 mb-1">代理端口 (HTTP/SOCKS5)</label>
                    <input
                      type="number"
                      className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                      value={mixedPort}
                      onChange={(e) => setMixedPort(Number(e.target.value))}
                      min="1024"
                      max="65535"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      当前Mihomo已将HTTP与SOCKS5端口统一为混合端口，设置后两种协议将使用相同端口
                    </p>
                  </div>
                </div>
                
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">允许局域网访问</h3>
                  <div className="flex items-center">
                    <Switch
                      checked={allowLan}
                      onCheckedChange={(checked) => {
                        console.log('允许局域网访问切换为:', checked, '类型:', typeof checked);
                        setAllowLan(Boolean(checked));
                      }}
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-200">允许其他设备通过局域网连接到本代理</span>
                  </div>
                </div>

                <div className="mb-4">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">IPv6支持</h3>
                  <div className="flex items-center">
                    <Switch
                      checked={enableIPv6}
                      onCheckedChange={(checked) => {
                        console.log('IPv6支持切换为:', checked);
                        setEnableIPv6(Boolean(checked));
                      }}
                    />
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-200">启用IPv6支持（需要重启代理）</span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-12">
                    启用后可支持IPv6连接，如果您的网络不支持IPv6可能会导致连接问题
                  </p>
                </div>
                
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">Mihomo API密钥</h3>
                  <div>
                    <input
                      type="text"
                      className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                      value={mihomoSecret}
                      onChange={(e) => setMihomoSecret(e.target.value)}
                      placeholder="留空表示不使用密钥"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      设置后将在与Mihomo内核通信时使用此密钥进行身份验证，增强安全性
                    </p>
                  </div>
                </div>
                
                <div>
                  <button 
                    className={`flex items-center justify-center rounded-lg transition-all duration-300 ${
                      isSaving 
                        ? 'bg-gray-500 cursor-not-allowed' 
                        : 'bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700'
                    } text-white py-2 px-4 transform hover:scale-105 ${isSaving ? '' : 'hover:shadow-lg'}`}
                    onClick={saveProxySettings}
                    disabled={isSaving || !configLoaded}
                  >
                    {isSaving ? '保存中...' : '保存设置'}
                  </button>
                  {!configLoaded && (
                    <p className="text-xs text-yellow-500 mt-2">正在加载配置...</p>
                  )}
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
