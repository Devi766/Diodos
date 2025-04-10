import React from 'react';
import Link from 'next/link';

// 为Electron API添加类型声明
declare global {
  interface Window {
    electronAPI?: {
      navigateTo: (url: string) => void;
      // 其他API...
    };
  }
}

// 检查是否在Electron环境
const isElectron = () => {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
};

// 电子环境下的链接组件
export default function ElectronLink({ 
  href, 
  className, 
  children,
  ...props 
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isElectron() && window.electronAPI) {
      e.preventDefault();
      // 使用Electron API导航
      window.electronAPI.navigateTo(href);
    }
    // 非Electron环境不做处理，让Next.js Link正常工作
  };
  
  return (
    <Link 
      href={href} 
      className={className} 
      onClick={handleClick}
      {...props}
    >
      {children}
    </Link>
  );
} 