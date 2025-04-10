import React from 'react';
import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { BarChartIcon, GearIcon, HomeIcon, ReaderIcon } from '@radix-ui/react-icons';
import { usePathname } from 'next/navigation';
import classNames from 'classnames';

// 检查是否在Electron环境
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

export default function NavMenu() {
  const pathname = usePathname();
  
  const menuItems = [
    { name: '控制面板', href: '/', pageName: 'index', icon: <HomeIcon className="w-5 h-5" /> },
    { name: '节点列表', href: '/nodes', pageName: 'nodes', icon: <HomeIcon className="w-5 h-5" /> },
    { name: '连接数据', href: '/connections', pageName: 'connections', icon: <BarChartIcon className="w-5 h-5" /> },
    { name: '订阅管理', href: '/subscriptions', pageName: 'subscriptions', icon: <ReaderIcon className="w-5 h-5" /> },
    { name: '系统设置', href: '/settings', pageName: 'settings', icon: <GearIcon className="w-5 h-5" /> },
  ];

  // 处理Electron环境下的导航
  const handleNavigation = (e: React.MouseEvent<HTMLAnchorElement>, item: typeof menuItems[0]) => {
    if (isElectron() && window.electronAPI) {
      e.preventDefault();
      // 使用新的loadPage方法导航
      console.log(`点击导航：${item.name}, 页面: ${item.pageName}`);
      window.electronAPI.loadPage(item.pageName);
    }
  };

  return (
    <NavigationMenu.Root className="flex py-4 px-6 bg-white dark:bg-[#1a1a1a] border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center mr-8">
        <div className="flex items-center">
          <img src="/logo.png" alt="FlyClash Logo" className="h-6 w-6 mr-2" />
          <span className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">FlyClash</span>
        </div>
      </div>
      
      <NavigationMenu.List className="flex gap-2">
        {menuItems.map((item) => (
          <NavigationMenu.Item key={item.href}>
            <a 
              href={item.href} 
              onClick={(e) => handleNavigation(e, item)}
              className={classNames(
                "flex items-center px-4 py-2 rounded-md transition-colors",
                pathname === item.href
                  ? "bg-blue-50 text-blue-600 dark:bg-[#2a2a2a] dark:text-blue-400"
                  : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              )}
            >
              <span className="mr-2">{item.icon}</span>
              {item.name}
            </a>
          </NavigationMenu.Item>
        ))}
      </NavigationMenu.List>
      
      <div className="ml-auto">
        <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
          <span className="inline-block w-2 h-2 mr-2 bg-green-500 rounded-full"></span>
          已连接
        </div>
      </div>
    </NavigationMenu.Root>
  );
} 