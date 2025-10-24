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
    // 检测平台并添加平台类
    if (typeof window !== 'undefined') {
      const platform = navigator.platform.toLowerCase();
      if (platform.includes('mac')) {
        document.body.classList.add('platform-darwin');
      } else if (platform.includes('win')) {
        document.body.classList.add('platform-windows');
      } else if (platform.includes('linux')) {
        document.body.classList.add('platform-linux');
      }

      // 获取并应用外观模式
      const initAppearance = async () => {
        try {
          // macOS 默认先设置为 dynamic（动态模糊）
          document.body.classList.add('appearance-dynamic');

          if (window.electronAPI) {
            const result = await window.electronAPI.getAppearanceMode();
            if (result.success) {
              const mode = result.mode || 'dynamic';
              console.log('[外观模式] 初始化:', mode);
              document.body.classList.remove('appearance-acrylic', 'appearance-dynamic', 'appearance-solid');
              document.body.classList.add(`appearance-${mode}`);
            }

            // 监听外观模式变化
            window.electronAPI.onAppearanceModeChanged?.((_, mode) => {
              console.log('[外观模式] 变化:', mode);
              document.body.classList.remove('appearance-acrylic', 'appearance-dynamic', 'appearance-solid');
              document.body.classList.add(`appearance-${mode}`);
            });
          }
        } catch (error) {
          console.error('初始化外观模式失败:', error);
          // 出错时确保有默认类（macOS 默认 dynamic）
          document.body.classList.add('appearance-dynamic');
        }
      };

      initAppearance();
    }

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
              document.body.classList.add('theme-dark');
              document.body.classList.remove('theme-light');
            } else {
              document.documentElement.classList.add('light');
              document.documentElement.classList.remove('dark');
              document.body.classList.add('theme-light');
              document.body.classList.remove('theme-dark');
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
                  document.body.classList.add('theme-dark');
                  document.body.classList.remove('theme-light');
                } else {
                  document.documentElement.classList.add('light');
                  document.documentElement.classList.remove('dark');
                  document.body.classList.add('theme-light');
                  document.body.classList.remove('theme-dark');
                }
              } else {
                setTheme(newTheme);
                if (newTheme === 'dark') {
                  document.documentElement.classList.add('dark');
                  document.documentElement.classList.remove('light');
                  document.body.classList.add('theme-dark');
                  document.body.classList.remove('theme-light');
                } else {
                  document.documentElement.classList.add('light');
                  document.documentElement.classList.remove('dark');
                  document.body.classList.add('theme-light');
                  document.body.classList.remove('theme-dark');
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
          document.body.classList.add('theme-dark');
          document.body.classList.remove('theme-light');
        } else {
          document.documentElement.classList.add('light');
          document.documentElement.classList.remove('dark');
          document.body.classList.add('theme-light');
          document.body.classList.remove('theme-dark');
        }
      } catch (error) {
        console.error('初始化主题失败:', error);
        // 出错时默认使用浅色主题
        setTheme('light');
        document.documentElement.classList.add('light');
        document.documentElement.classList.remove('dark');
        document.body.classList.add('theme-light');
        document.body.classList.remove('theme-dark');
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
