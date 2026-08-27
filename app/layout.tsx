'use client';

import "./globals.css";
import { useEffect, useState } from "react";
import Script from "next/script";
import { Toaster } from "sonner";
import { ToastContainer } from "@/components/ui/toast";
import Layout from "@/components/Layout";
import AppDataWarmup from "@/components/AppDataWarmup";
import {
  PLATFORM_BODY_CLASSES,
  applyPlatformBodyClass,
  getBrowserPlatform,
  getRuntimePlatform,
} from "@/utils/platform";
import '@/i18n';

const TAURI_COMPAT_VERSION = "20260720-2";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [theme, setTheme] = useState<string>('');

  useEffect(() => {
    let removeThemeListener: (() => void) | undefined;
    let disposed = false;

    // Desktop shell: hide WebView/browser default context menu.
    // Custom UI menus still work because they call stopPropagation().
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      // Keep editor-native menus (Monaco / CodeMirror / contenteditable roots).
      return Boolean(
        target.closest(
          '.monaco-editor, .cm-editor, [contenteditable="true"], [role="textbox"]',
        ),
      );
    };

    const onContextMenu = (event: MouseEvent) => {
      // Keep native copy/paste menu for form fields and code editors.
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isReload = (event.ctrlKey || event.metaKey) && key === "r";
      const isDevtools =
        key === "f12" ||
        ((event.ctrlKey || event.metaKey) && event.shiftKey && (key === "i" || key === "j" || key === "c"));
      if (isReload || isDevtools) {
        event.preventDefault();
      }
    };

    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);

    applyPlatformBodyClass(getBrowserPlatform());
    void getRuntimePlatform().then((runtimePlatform) => {
      if (!disposed) {
        applyPlatformBodyClass(runtimePlatform);
      }
    });

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
          if (disposed) return;
          if (result.success) {
            const themeName = result.theme;

            // 根据主题名称设置类名
            let actualTheme = themeName;
            if (themeName === 'system') {
              // 跟随系统设置
              actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }

            setTheme(actualTheme);
            window.localStorage.setItem('flyclash-resolved-theme', actualTheme);
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
            // onThemeChanged may pass (theme) or (_, theme) depending on bridge shape.
            const unsubscribeThemeListener = window.electronAPI.onThemeChanged((...args: any[]) => {
              const newTheme = typeof args[0] === 'string' ? args[0] : args[1];
              const actualTheme =
                newTheme === 'system'
                  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                  : newTheme;
              setTheme(actualTheme);
              window.localStorage.setItem('flyclash-resolved-theme', actualTheme);
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

              // 强制触发重新渲染
              window.dispatchEvent(new Event('storage'));
            });
            if (typeof unsubscribeThemeListener === 'function') {
              if (disposed) {
                unsubscribeThemeListener();
              } else {
                removeThemeListener = unsubscribeThemeListener;
              }
            }

            // 获取主题色配置
            const colorResult = await window.electronAPI.getThemeColor();
            if (disposed) return;
            if (colorResult.success && colorResult.color) {
              applyThemeColor(colorResult.color);
            }

            return;
          }
        }

        // 默认情况下跟随系统设置
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        setTheme(systemTheme);
        window.localStorage.setItem('flyclash-resolved-theme', systemTheme);
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
        if (disposed) return;
        // 出错时默认使用浅色主题
        setTheme('light');
        window.localStorage.setItem('flyclash-resolved-theme', 'light');
        document.documentElement.classList.add('light');
        document.documentElement.classList.remove('dark');
        document.body.classList.add('theme-light');
        document.body.classList.remove('theme-dark');
      }
    };
    
    initTheme();
    
    // 清理函数
    return () => {
      disposed = true;
      document.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
      if (typeof removeThemeListener === 'function') {
        removeThemeListener();
      }
      document.body.classList.remove(...PLATFORM_BODY_CLASSES);
      delete document.body.dataset.platform;
    };
  }, []);

  return (
    <html lang="zh-CN" className={theme} suppressHydrationWarning>
      <head>
        <title>FlyClash</title>
        <meta name="description" content="现代、美观的 Clash 客户端，基于 FlyClash Core" />
        <link rel="icon" href="/favicon.ico" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('flyclash-resolved-theme');if(t!=='dark'&&t!=='light'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.classList.add(t);document.documentElement.style.colorScheme=t;document.addEventListener('DOMContentLoaded',function(){document.body.classList.add('theme-'+t)},{once:true})}catch(e){}})();`,
          }}
        />
        <Script src={`/tauri-compat.js?v=${TAURI_COMPAT_VERSION}`} strategy="beforeInteractive" />
      </head>
      <body className="antialiased min-h-screen text-foreground" suppressHydrationWarning>
        <AppDataWarmup />
        <Layout>
          {children}
        </Layout>
        <Toaster closeButton position="bottom-right" />
        <ToastContainer />
      </body>
    </html>
  );
}
