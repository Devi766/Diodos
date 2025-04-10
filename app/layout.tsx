'use client';

import "./globals.css";
import { useEffect, useState } from "react";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [theme, setTheme] = useState<string>('light');

  useEffect(() => {
    // 在客户端渲染时获取主题设置
    const initTheme = async () => {
      try {
        // 如果window.electronAPI可用（在Electron环境中）
        if (typeof window !== 'undefined' && window.electronAPI) {
          const result = await window.electronAPI.getTheme();
          if (result.success) {
            const themeName = result.theme;
            
            // 根据主题名称设置类名
            let actualTheme = themeName;
            if (themeName === 'system') {
              // 跟随系统设置
              actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }
            
            setTheme(actualTheme);
            document.documentElement.className = actualTheme;
            
            // 监听主题变化事件
            window.electronAPI.onThemeChanged((_, newTheme) => {
              if (newTheme === 'system') {
                // 跟随系统设置
                const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                setTheme(systemTheme);
                document.documentElement.className = systemTheme;
              } else {
                setTheme(newTheme);
                document.documentElement.className = newTheme;
              }
            });
            
            return;
          }
        }
        
        // 默认情况下跟随系统设置
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        setTheme(systemTheme);
        document.documentElement.className = systemTheme;
      } catch (error) {
        console.error('初始化主题失败:', error);
        // 出错时默认使用浅色主题
        setTheme('light');
        document.documentElement.className = 'light';
      }
    };
    
    initTheme();
    
    // 清理函数
    return () => {
      if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.removeThemeListener) {
        window.electronAPI.removeThemeListener();
      }
    };
  }, []);

  return (
    <html lang="zh-CN" className={theme}>
      <head>
        <title>FlyClash</title>
        <meta name="description" content="现代、美观的Clash客户端，基于Mihomo内核" />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body className="antialiased bg-[#f9f9f9] dark:bg-[#1f2937]">
        {children}
      </body>
    </html>
  );
}
