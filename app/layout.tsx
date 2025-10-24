'use client';

import "./globals.css";
import { useEffect, useState } from "react";
import { SpeedTestProvider } from "./contexts/SpeedTestContext";
import { ToastContainer } from "@/components/ui/toast";

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
            // 使用 classList 来添加/移除主题类，而不是替换整个 className
            if (actualTheme === 'dark') {
              document.documentElement.classList.add('dark');
              document.documentElement.classList.remove('light');
            } else {
              document.documentElement.classList.add('light');
              document.documentElement.classList.remove('dark');
            }

            // 监听主题变化事件
            window.electronAPI.onThemeChanged((_, newTheme) => {
              if (newTheme === 'system') {
                // 跟随系统设置
                const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                setTheme(systemTheme);
                if (systemTheme === 'dark') {
                  document.documentElement.classList.add('dark');
                  document.documentElement.classList.remove('light');
                } else {
                  document.documentElement.classList.add('light');
                  document.documentElement.classList.remove('dark');
                }
              } else {
                setTheme(newTheme);
                if (newTheme === 'dark') {
                  document.documentElement.classList.add('dark');
                  document.documentElement.classList.remove('light');
                } else {
                  document.documentElement.classList.add('light');
                  document.documentElement.classList.remove('dark');
                }
              }

              // 强制触发重新渲染
              window.dispatchEvent(new Event('storage'));
            });
            
            return;
          }
        }
        
        // 默认情况下跟随系统设置
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        setTheme(systemTheme);
        if (systemTheme === 'dark') {
          document.documentElement.classList.add('dark');
          document.documentElement.classList.remove('light');
        } else {
          document.documentElement.classList.add('light');
          document.documentElement.classList.remove('dark');
        }
      } catch (error) {
        console.error('初始化主题失败:', error);
        // 出错时默认使用浅色主题
        setTheme('light');
        document.documentElement.classList.add('light');
        document.documentElement.classList.remove('dark');
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
      <body className="antialiased min-h-screen text-foreground">
        <SpeedTestProvider>
          {children}
        </SpeedTestProvider>
        <ToastContainer />
      </body>
    </html>
  );
}
