import React, { useState, useEffect } from 'react';
import * as Switch from '@radix-ui/react-switch';
import * as Tabs from '@radix-ui/react-tabs';

export default function Settings() {
  const [startWithSystem, setStartWithSystem] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  const [theme, setTheme] = useState('system');

  // 在组件加载时获取保存的主题
  useEffect(() => {
    const fetchTheme = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
          const result = await window.electronAPI.getTheme();
          if (result.success) {
            setTheme(result.theme);
          }
        }
      } catch (error) {
        console.error('获取主题设置失败:', error);
      }
    };

    fetchTheme();

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

    // 添加事件监听器
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.onThemeChanged(handleThemeChanged);

      // 清理函数
      return () => {
        window.electronAPI?.removeThemeListener();
      };
    }
    return undefined;
  }, []);

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

  return (
    <div className="p-6">
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
                    className={`py-1 px-3 text-sm rounded-md ${
                      theme === 'light'
                        ? 'bg-blue-100 text-blue-700 dark:bg-[#2a2a2a] dark:text-blue-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-[#2a2a2a] dark:text-gray-200'
                    }`}
                    onClick={() => handleThemeChange('light')}
                  >
                    浅色
                  </button>
                  <button
                    className={`py-1 px-3 text-sm rounded-md ${
                      theme === 'dark'
                        ? 'bg-blue-100 text-blue-700 dark:bg-[#2a2a2a] dark:text-blue-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-[#2a2a2a] dark:text-gray-200'
                    }`}
                    onClick={() => handleThemeChange('dark')}
                  >
                    深色
                  </button>
                  <button
                    className={`py-1 px-3 text-sm rounded-md ${
                      theme === 'system'
                        ? 'bg-blue-100 text-blue-700 dark:bg-[#2a2a2a] dark:text-blue-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-[#2a2a2a] dark:text-gray-200'
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
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-300 mb-1">HTTP 端口</label>
                    <input
                      type="number"
                      className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                      defaultValue="7890"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-300 mb-1">Socks5 端口</label>
                    <input
                      type="number"
                      className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                      defaultValue="7891"
                    />
                  </div>
                </div>
              </div>
              
              <div className="mb-4">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">允许局域网访问</h3>
                <div className="flex items-center">
                  <Switch.Root
                    className="w-[42px] h-[25px] bg-gray-300 dark:bg-gray-600 rounded-full relative focus:shadow-[0_0_0_2px] focus:shadow-black data-[state=checked]:bg-indigo-500 outline-none cursor-default"
                    defaultChecked={false}
                  >
                    <Switch.Thumb className="block w-[21px] h-[21px] bg-white rounded-full shadow-[0_2px_2px] shadow-black transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[19px]" />
                  </Switch.Root>
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-200">允许其他设备通过局域网连接到本代理</span>
                </div>
              </div>
              
              <div>
                <button className="py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors">
                  保存设置
                </button>
              </div>
            </div>
          </Tabs.Content>
          
          <Tabs.Content value="about" className="w-full">
            <div className="flex flex-col items-center text-center py-8">
              <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">FlyClash</h2>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">版本: v0.1.0</p>
              
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
                  className="py-2 px-4 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-md transition-colors"
                  href="https://github.com/MetaCubeX/mihomo"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Mihomo 项目
                </a>
                <a
                  className="py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors"
                  href="https://github.com/yourusername/flyclash"
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
    </div>
  );
} 