import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Switch from '@radix-ui/react-switch';
import * as Tabs from '@radix-ui/react-tabs';
import * as Toast from '@radix-ui/react-toast';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useMihomoAPI } from '../services/mihomo-api';

export default function Settings() {
  const [startWithSystem, setStartWithSystem] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  const [theme, setTheme] = useState('system');
  const [appVersion, setAppVersion] = useState('');
  const isFirstRender = useRef(true);
  
  // 代理设置相关状态
  const [mixedPort, setMixedPort] = useState(7890);
  const [allowLan, setAllowLan] = useState(false);
  const [enableIPv6, setEnableIPv6] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  
  // Toast提示相关状态
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  
  // 使用mihomo API
  const mihomoAPI = useMihomoAPI();

  // 在组件加载时获取保存的主题和应用版本号
  useEffect(() => {
    const fetchData = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
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
  }, []);

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
  
  useEffect(() => {
    // 组件首次加载时不调用，只在状态变化时调用
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    
    updateAutoLaunch();
  }, [updateAutoLaunch]);

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
          setConfigLoaded(true);
        }
      } catch (error) {
        console.error('获取mihomo配置失败:', error);
      }
    };

    fetchUserSettings();
  }, []);

  // 显示Toast提示
  const showToast = (title: string, description: string, type: 'success' | 'error') => {
    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(true);
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
      
      // 更新所有相关配置项
      const configUpdate = {
        'mixed-port': portValue,
        'allow-lan': lanAccess,
        'ipv6': ipv6Enabled
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
    <div className="p-6">
      <Toast.Provider swipeDirection="right">
        <h1 className="text-2xl font-bold mb-6 text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">系统设置</h1>
        
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
                  <Switch.Root
                    className="w-[42px] h-[25px] bg-gray-300 dark:bg-gray-600 rounded-full relative focus:shadow-[0_0_0_2px] focus:shadow-black data-[state=checked]:bg-indigo-500 outline-none cursor-default"
                    checked={startWithSystem}
                    onCheckedChange={setStartWithSystem}
                  >
                    <Switch.Thumb className="block w-[21px] h-[21px] bg-white rounded-full shadow-[0_2px_2px] shadow-black transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[19px]" />
                  </Switch.Root>
                </div>
                
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">最小化到托盘</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">关闭窗口时最小化到系统托盘</p>
                  </div>
                  <Switch.Root
                    className="w-[42px] h-[25px] bg-gray-300 dark:bg-gray-600 rounded-full relative focus:shadow-[0_0_0_2px] focus:shadow-black data-[state=checked]:bg-indigo-500 outline-none cursor-default"
                    checked={minimizeToTray}
                    onCheckedChange={setMinimizeToTray}
                  >
                    <Switch.Thumb className="block w-[21px] h-[21px] bg-white rounded-full shadow-[0_2px_2px] shadow-black transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[19px]" />
                  </Switch.Root>
                </div>
                
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">自动检查更新</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">启动时自动检查是否有新版本</p>
                  </div>
                  <Switch.Root
                    className="w-[42px] h-[25px] bg-gray-300 dark:bg-gray-600 rounded-full relative focus:shadow-[0_0_0_2px] focus:shadow-black data-[state=checked]:bg-indigo-500 outline-none cursor-default"
                    checked={autoCheckUpdate}
                    onCheckedChange={setAutoCheckUpdate}
                  >
                    <Switch.Thumb className="block w-[21px] h-[21px] bg-white rounded-full shadow-[0_2px_2px] shadow-black transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[19px]" />
                  </Switch.Root>
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
                    <Switch.Root
                      className="w-[42px] h-[25px] bg-gray-300 dark:bg-gray-600 rounded-full relative focus:shadow-[0_0_0_2px] focus:shadow-black data-[state=checked]:bg-indigo-500 outline-none cursor-default"
                      checked={allowLan}
                      onCheckedChange={(checked) => {
                        console.log('允许局域网访问切换为:', checked, '类型:', typeof checked);
                        setAllowLan(Boolean(checked));
                      }}
                    >
                      <Switch.Thumb className="block w-[21px] h-[21px] bg-white rounded-full shadow-[0_2px_2px] shadow-black transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[19px]" />
                    </Switch.Root>
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-200">允许其他设备通过局域网连接到本代理</span>
                  </div>
                </div>
                
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">IPv6支持</h3>
                  <div className="flex items-center">
                    <Switch.Root
                      className="w-[42px] h-[25px] bg-gray-300 dark:bg-gray-600 rounded-full relative focus:shadow-[0_0_0_2px] focus:shadow-black data-[state=checked]:bg-indigo-500 outline-none cursor-default"
                      checked={enableIPv6}
                      onCheckedChange={(checked) => {
                        console.log('IPv6支持切换为:', checked);
                        setEnableIPv6(Boolean(checked));
                      }}
                    >
                      <Switch.Thumb className="block w-[21px] h-[21px] bg-white rounded-full shadow-[0_2px_2px] shadow-black transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[19px]" />
                    </Switch.Root>
                    <span className="ml-2 text-sm text-gray-700 dark:text-gray-200">启用IPv6支持（需要重启代理）</span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-12">
                    启用后可支持IPv6连接，如果您的网络不支持IPv6可能会导致连接问题
                  </p>
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
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">版本: v{appVersion}</p>
                
                <div className="bg-gray-50 dark:bg-[#222222] p-4 rounded-md mb-6 text-left w-full max-w-lg">
                  <p className="text-sm text-gray-700 dark:text-gray-200 mb-2">
                    FlyClash 是一个基于 Mihomo 内核的现代化代理客户端，拥有美观的界面和强大的功能。
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-200">
                    Mihomo 是一个开源的代理内核，FlyClash 仅仅是一个基于此的用户界面。
                  </p>
                </div>
                
                <div className="flex gap-4">
                  <a
                    className="flex items-center justify-center py-2 px-4 bg-gradient-to-r from-gray-200 to-gray-300 hover:from-gray-300 hover:to-gray-400 dark:from-gray-700 dark:to-gray-800 dark:hover:from-gray-600 dark:hover:to-gray-700 text-gray-800 dark:text-gray-200 rounded-lg transition-all duration-300 transform hover:scale-105 hover:shadow-lg"
                    href="https://github.com/MetaCubeX/mihomo"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Mihomo 项目
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