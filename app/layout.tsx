'use client';

import "./globals.css";
import { useEffect, useState } from "react";
import { ToastContainer } from "@/components/ui/toast";
import '@/i18n';

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
    }

    // 将hex颜色转换为HSL格式
    const hexToHSL = (hex: string) => {
      hex = hex.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let h = 0, s = 0, l = (max + min) / 2;

      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

        switch (max) {
          case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
          case g: h = ((b - r) / d + 2) / 6; break;
          case b: h = ((r - g) / d + 4) / 6; break;
        }
      }

      h = Math.round(h * 360);
      s = Math.round(s * 100);
      l = Math.round(l * 100);

      return `${h} ${s}% ${l}%`;
    };

    // 应用主题色到CSS变量
    const applyThemeColor = (color: string) => {
      if (typeof document !== 'undefined') {
        const hsl = hexToHSL(color);
        document.documentElement.style.setProperty('--primary', hsl);
        document.documentElement.style.setProperty('--ring', hsl);
      }
    };

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

            // 获取主题色配置
            const colorResult = await window.electronAPI.getThemeColor();
            if (colorResult.success && colorResult.color) {
              applyThemeColor(colorResult.color);
            }

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
          {children}
        <ToastContainer />
      </body>
    </html>
  );
}
