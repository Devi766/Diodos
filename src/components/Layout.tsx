import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import classNames from 'classnames';
import { 
  HomeIcon, 
  GlobeIcon, 
  ReaderIcon, 
  GearIcon,
  DashboardIcon,
  InfoCircledIcon,
  HamburgerMenuIcon,
  Cross1Icon,
  BarChartIcon,
  RocketIcon
} from '@radix-ui/react-icons';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.1');
  
  const menuItems = [
    { name: '控制面板', href: '/', icon: <DashboardIcon className="w-5 h-5" /> },
    { name: '节点管理', href: '/nodes', icon: <GlobeIcon className="w-5 h-5" /> },
    { name: '连接数据', href: '/connections', icon: <BarChartIcon className="w-5 h-5" /> },
    { name: '订阅管理', href: '/subscriptions', icon: <ReaderIcon className="w-5 h-5" /> },
    { name: '系统设置', href: '/settings', icon: <GearIcon className="w-5 h-5" /> },
  ];

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
          const version = await window.electronAPI.getAppVersion();
          setAppVersion(version);
        }
      } catch (error) {
        console.error('获取应用版本号失败:', error);
      }
    };

    fetchVersion();
  }, []);

  return (
    <div className="flex h-screen bg-[#f9f9f9] dark:bg-[#1a1a1a] overflow-hidden">
      {/* Sidebar - Desktop */}
      <div 
        className={classNames(
          "hidden md:flex flex-col bg-white dark:bg-[#1a1a1a] border-r border-gray-200 dark:border-gray-800 h-screen transition-all duration-300 overflow-hidden",
          sidebarCollapsed ? "w-16" : "w-64"
        )}
      >
        <div className="flex items-center px-4 py-6 border-b border-gray-200 dark:border-gray-800">
          {!sidebarCollapsed && (
            <div className="flex items-center">
              <img src="/logo.png" alt="FlyClash Logo" className="h-8 w-8 mr-2" />
              <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">FlyClash</h1>
            </div>
          )}
          {sidebarCollapsed && (
            <div className="mx-auto">
              <div className="w-6 h-6 rounded-md bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500 flex items-center justify-center text-white font-bold">
                F
              </div>
            </div>
          )}
          
          <button
            className="ml-auto text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <HamburgerMenuIcon className="w-5 h-5" />
          </button>
        </div>
        
        <div className="flex-1 py-6">
          <nav className="px-2 space-y-2">
            {menuItems.map((item) => (
              <Link 
                key={item.href}
                href={item.href}
                className={classNames(
                  "flex items-center px-4 py-3 rounded-lg transition-colors",
                  pathname === item.href 
                    ? "bg-blue-50 text-blue-600 dark:bg-[#2a2a2a] dark:text-blue-400"
                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                )}
              >
                <span className="flex-shrink-0">{item.icon}</span>
                {!sidebarCollapsed && <span className="ml-3">{item.name}</span>}
              </Link>
            ))}
          </nav>
        </div>
        
        <div className="p-4 border-t border-gray-200 dark:border-gray-800">
          <div className={classNames(
            "flex items-center",
            sidebarCollapsed ? "justify-center" : "justify-start"
          )}>
            <span className={classNames(
              "flex items-center justify-center w-8 h-8 rounded-full bg-green-100 dark:bg-[#2a2a2a]", 
              sidebarCollapsed ? "" : "mr-3"
            )}>
              <InfoCircledIcon className="w-4 h-4 text-green-600 dark:text-green-400" />
            </span>
            
            {!sidebarCollapsed && (
              <div>
                <div className="text-sm font-medium text-gray-700 dark:text-gray-300">已连接</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">v{appVersion}</div>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Fixed Title Bar */}
        <div className={classNames(
          "fixed top-0 right-0 h-12 z-50",
          sidebarCollapsed ? "md:w-[calc(100%-64px)]" : "md:w-[calc(100%-256px)]",
          "w-full"
        )}>
          <div 
            className="w-full h-full bg-transparent" 
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          />
        </div>

        {/* Top Bar - Mobile */}
        <div className="md:hidden bg-white dark:bg-[#1a1a1a] border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between px-4 py-4">
            <div className="flex items-center">
              <img src="/logo.png" alt="FlyClash Logo" className="h-7 w-7 mr-2" />
              <h1 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">FlyClash</h1>
            </div>
            
            <button 
              className="text-gray-700 dark:text-gray-300" 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <Cross1Icon className="w-5 h-5" /> : <HamburgerMenuIcon className="w-5 h-5" />}
            </button>
          </div>
          
          {/* Mobile Menu */}
          {mobileMenuOpen && (
            <div className="px-4 pb-4 bg-white dark:bg-[#1a1a1a] border-b border-gray-200 dark:border-gray-800">
              <nav className="space-y-2">
                {menuItems.map((item) => (
                  <Link 
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={classNames(
                      "flex items-center px-4 py-3 rounded-lg transition-colors",
                      pathname === item.href 
                        ? "bg-blue-50 text-blue-600 dark:bg-[#2a2a2a] dark:text-blue-400"
                        : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                    )}
                  >
                    <span className="flex-shrink-0">{item.icon}</span>
                    <span className="ml-3">{item.name}</span>
                  </Link>
                ))}
              </nav>
            </div>
          )}
        </div>
        
        {/* Page Content */}
        <main className="flex-1 overflow-y-auto pt-12 relative">
          {children}
        </main>
      </div>
    </div>
  );
} 