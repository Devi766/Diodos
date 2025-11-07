import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  RocketIcon,
  MixerHorizontalIcon,
  FileTextIcon,
  LayersIcon,
  CodeIcon
} from '@radix-ui/react-icons';
import { useProviderAvailability } from '@/hooks/use-provider-availability';
import CloudOutlineIcon from '@/components/icons/CloudOutlineIcon';
import TitleBar from '@/components/TitleBar';
import { showToast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  RELEASES_PAGE_URL,
  ReleaseInfo,
  fetchLatestRelease,
  compareVersions,
  UPDATE_AVAILABLE_EVENT,
  UpdateEventDetail,
} from '@/utils/update-check';

declare global {
  interface Window {
    __flyclashPendingUpdate?: UpdateEventDetail;
  }
}

let hasRunAutoUpdateCheck = false;

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    const storedState = window.localStorage.getItem('flyclash-sidebar-collapsed');
    return storedState === 'true';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.7');
  const [pendingUpdate, setPendingUpdate] = useState<(ReleaseInfo & { currentVersion: string }) | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const hasCheckedUpdatesRef = useRef(false);
  const { hasProviders } = useProviderAvailability();
  const showUpdateDialog = useCallback((release: ReleaseInfo, currentVersion: string) => {
    setPendingUpdate({ ...release, currentVersion });
    setUpdateDialogOpen(true);
  }, []);

  // 避免 SSR hydration 不匹配
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const ua = navigator.userAgent.toLowerCase();
    const body = document.body;
    const classes: string[] = [];

    if (ua.includes('windows')) {
      classes.push('platform-windows');
    } else if (ua.includes('macintosh') || ua.includes('mac os')) {
      classes.push('platform-macos');
    }

    classes.forEach((cls) => body.classList.add(cls));

    return () => {
      classes.forEach((cls) => body.classList.remove(cls));
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const triggerResize = () => {
      window.dispatchEvent(new Event('resize'));
    };

    const timers = [80, 220, 520].map((delay) => window.setTimeout(triggerResize, delay));

    return () => {
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncTheme = () => {
      const isDark = document.documentElement.classList.contains('dark');
      document.body.classList.toggle('theme-dark', isDark);
    };

    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('flyclash-sidebar-collapsed', next ? 'true' : 'false');
      }
      return next;
    });
  }, []);
  
  const menuItems = useMemo(() => {
    const items = [
      { name: t('nav.dashboard'), href: '/', icon: <DashboardIcon className="w-5 h-5" /> },
      { name: t('nav.nodes'), href: '/nodes', icon: <GlobeIcon className="w-5 h-5" /> },
      { name: t('nav.subscriptions'), href: '/subscriptions', icon: <ReaderIcon className="w-5 h-5" /> },
      { name: t('nav.connections'), href: '/connections', icon: <BarChartIcon className="w-5 h-5" /> },
      { name: t('nav.matchRules'), href: '/match-rules', icon: <FileTextIcon className="w-5 h-5" /> },
      { name: t('nav.overrides'), href: '/overrides', icon: <CodeIcon className="w-5 h-5" /> },
      { name: t('nav.externalResources'), href: '/external-resources', icon: <LayersIcon className="w-5 h-5" /> },
      { name: t('nav.tools'), href: '/tools', icon: (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21.71 20.29L20.29 21.71A1 1 0 0 1 18.88 21.71L7 9.85A3.81 3.81 0 0 1 6 10A4 4 0 0 1 2.22 4.7L4.76 7.24L5.29 6.71L6.71 5.29L7.24 4.76L4.7 2.22A4 4 0 0 1 10 6A3.81 3.81 0 0 1 9.85 7L21.71 18.88A1 1 0 0 1 21.71 20.29M2.29 18.88A1 1 0 0 0 2.29 20.29L3.71 21.71A1 1 0 0 0 5.12 21.71L10.59 16.25L7.76 13.42M20 2L16 4V6L13.83 8.17L15.83 10.17L18 8H20L22 4Z" />
        </svg>
      ) },
      { name: t('nav.logs'), href: '/logs', icon: <InfoCircledIcon className="w-5 h-5" /> },
      { name: t('nav.settings'), href: '/settings', icon: <GearIcon className="w-5 h-5" /> },
    ];

    if (hasProviders) {
      items.splice(7, 0, { name: t('nav.providers'), href: '/providers', icon: <CloudOutlineIcon className="w-5 h-5" /> });
    }

    return items;
  }, [hasProviders, t]);

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

  const handleOpenReleasePage = useCallback(async () => {
    if (!pendingUpdate) return;
    const targetUrl = pendingUpdate.url || RELEASES_PAGE_URL;

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(targetUrl);
      } else if (typeof window !== 'undefined') {
        window.open(targetUrl, '_blank');
      }
    } catch (error) {
      console.error('打开更新链接失败:', error);
      if (typeof window !== 'undefined') {
        window.open(targetUrl, '_blank');
      }
    }
  }, [pendingUpdate]);

  const releaseVersionLabel = pendingUpdate
    ? pendingUpdate.displayVersion || `v${pendingUpdate.version}`
    : '';

  const releasePublishedAt = useMemo(() => {
    if (!pendingUpdate?.publishedAt) return null;
    try {
      const date = new Date(pendingUpdate.publishedAt);
      return Number.isNaN(date.getTime()) ? pendingUpdate.publishedAt : date.toLocaleString();
    } catch {
      return pendingUpdate.publishedAt;
    }
  }, [pendingUpdate?.publishedAt]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (hasCheckedUpdatesRef.current || hasRunAutoUpdateCheck) return;
    hasCheckedUpdatesRef.current = true;
    hasRunAutoUpdateCheck = true;

    let canceled = false;

    const autoCheckUpdates = async () => {
      try {
        const settingResult = await window.electronAPI?.getSetting?.('autoCheckUpdate', true);
        const shouldCheck = settingResult === undefined ? true : settingResult.value !== false;
        if (!shouldCheck) return;

        const currentVersion = await window.electronAPI?.getAppVersion?.();
        if (!currentVersion) return;

        const { release: latestRelease, error: fetchError } = await fetchLatestRelease();
        if (!latestRelease || canceled) {
          if (fetchError) {
            console.warn('[UpdateCheck] 自动检查更新失败:', fetchError);
          }
          return;
        }

        if (compareVersions(latestRelease.version, currentVersion) > 0) {
          showUpdateDialog(latestRelease, currentVersion);
        }
      } catch (error) {
        console.error('[UpdateCheck] 自动检查更新失败:', error);
      }
    };

    autoCheckUpdates();

    return () => {
      canceled = true;
    };
  }, [showUpdateDialog]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<UpdateEventDetail>).detail;
      if (detail?.release && detail?.currentVersion) {
        showUpdateDialog(detail.release, detail.currentVersion);
        window.__flyclashPendingUpdate = undefined;
      }
    };

    window.addEventListener(UPDATE_AVAILABLE_EVENT, handler as EventListener);

    const pending = window.__flyclashPendingUpdate;
    if (pending?.release && pending?.currentVersion) {
      showUpdateDialog(pending.release, pending.currentVersion);
      window.__flyclashPendingUpdate = undefined;
    }

    return () => {
      window.removeEventListener(UPDATE_AVAILABLE_EVENT, handler as EventListener);
    };
  }, [showUpdateDialog]);

  // 监听 Mihomo 启动失败事件
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    const handleMihomoStartFailed = (data: { error: string; exitCode?: number }) => {
      console.error('Mihomo 启动失败:', data);
      showToast({
        message: data.error,
        type: 'error',
        duration: 5000
      });
    };

    const cleanup = window.electronAPI.onMihomoStartFailed?.(handleMihomoStartFailed);

    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 监听并应用自定义背景
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    const applyCustomBackground = (config: { imageData?: string; imagePath?: string; opacity: number; blur: number }) => {
      console.log('[Layout] 应用自定义背景配置:', { ...config, imageData: config.imageData ? '(base64 data)' : undefined });

      const { imageData, imagePath, opacity, blur } = config;

      // 确定使用哪种图片源
      let imageUrl: string;
      if (imageData) {
        // 使用base64数据
        imageUrl = imageData;
      } else if (imagePath) {
        // 备用方案：使用file://路径
        imageUrl = `file:///${imagePath.replace(/\\/g, '/')}`;
      } else {
        console.error('[Layout] 没有提供图片数据或路径');
        return;
      }

      // 查找或创建样式元素
      let styleElement = document.getElementById('custom-background-style');
      if (!styleElement) {
        styleElement = document.createElement('style');
        styleElement.id = 'custom-background-style';
        document.head.appendChild(styleElement);
      }

      // 根据是否有模糊和透明度需求，选择不同的渲染策略
      const needsOpacityLayer = opacity < 100;
      const hasBlur = blur > 0;

      if (hasBlur && needsOpacityLayer) {
        // 有模糊且需要透明度：使用双层结构
        styleElement.innerHTML = `
          body {
            position: relative;
          }
          body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100vw;
            height: 100vh;
            background-image: url('${imageUrl}');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            filter: blur(${blur}px);
            transform: scale(1.1);
            z-index: -9999;
            pointer-events: none;
            transition: opacity 0.2s ease-in-out;
          }
          body::after {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100vw;
            height: 100vh;
            background-color: rgba(255, 255, 255, ${1 - opacity / 100});
            z-index: -9998;
            pointer-events: none;
            transition: opacity 0.2s ease-in-out;
          }
        `;
      } else if (hasBlur && !needsOpacityLayer) {
        // 只有模糊，没有透明度
        styleElement.innerHTML = `
          body {
            position: relative;
          }
          body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100vw;
            height: 100vh;
            background-image: url('${imageUrl}');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            filter: blur(${blur}px);
            transform: scale(1.1);
            z-index: -9999;
            pointer-events: none;
            transition: opacity 0.2s ease-in-out;
          }
        `;
      } else {
        // 没有模糊：使用单层结构（可能有透明度）
        styleElement.innerHTML = `
          body {
            position: relative;
          }
          body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100vw;
            height: 100vh;
            background-image: url('${imageUrl}');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            opacity: ${opacity / 100};
            z-index: -9999;
            pointer-events: none;
            transition: opacity 0.2s ease-in-out;
          }
        `;
      }

      console.log('[Layout] 自定义背景已应用');
    };

    // 页面加载时检查并应用已保存的自定义背景
    const loadSavedBackground = async () => {
      // 检查是否已经有背景样式（避免重复加载）
      const existingStyle = document.getElementById('custom-background-style');
      if (existingStyle) {
        console.log('[Layout] 背景样式已存在，跳过加载');
        return;
      }

      try {
        const appearanceResult = await window.electronAPI.getAppearanceMode();
        if (appearanceResult.success && appearanceResult.mode === 'custom') {
          console.log('[Layout] 检测到自定义背景模式，触发应用');
          // 触发主进程重新发送背景数据
          await window.electronAPI.setAppearanceMode('custom');
        }
      } catch (error) {
        console.error('[Layout] 加载自定义背景失败:', error);
      }
    };

    loadSavedBackground();

    // 清除背景的函数
    const clearBackground = () => {
      console.log('[Layout] 清除自定义背景');
      const styleElement = document.getElementById('custom-background-style');
      if (styleElement) {
        styleElement.remove();
      }
    };

    // 监听背景配置变化
    const cleanup = window.electronAPI.onCustomBackgroundApply?.(applyCustomBackground);
    const clearCleanup = window.electronAPI.onClearCustomBackground?.(clearBackground);

    return () => {
      if (cleanup) cleanup();
      if (clearCleanup) clearCleanup();

      // 组件卸载时不清理背景样式，让它保持在DOM中
      // clearBackground();
    };
  }, []);

  // 监听并应用主题色
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    const applyThemeColor = (color: string) => {
      console.log('[Layout] 应用主题色:', color);

      // 创建或更新CSS变量
      const root = document.documentElement;

      // 将十六进制颜色转换为RGB值
      const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16)
        } : null;
      };

      const rgb = hexToRgb(color);
      if (rgb) {
        // 设置CSS变量（用于Tailwind和自定义样式）
        root.style.setProperty('--theme-color', color);
        root.style.setProperty('--theme-color-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);

        // 更新Tailwind的primary颜色
        // 注意：这需要覆盖Tailwind的默认primary颜色
        const styleElement = document.getElementById('theme-color-override') || document.createElement('style');
        styleElement.id = 'theme-color-override';

        // 计算悬停时稍微深一点的颜色
        const darkenColor = (hexColor: string, percent: number): string => {
          const num = parseInt(hexColor.slice(1), 16);
          const r = Math.max(0, Math.min(255, Math.floor((num >> 16) * (1 - percent))));
          const g = Math.max(0, Math.min(255, Math.floor(((num >> 8) & 0x00FF) * (1 - percent))));
          const b = Math.max(0, Math.min(255, Math.floor((num & 0x0000FF) * (1 - percent))));
          return `#${(0x1000000 + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        };

        // 计算浅色版本（用于悬停背景等）
        const lightenColor = (hexColor: string, percent: number): string => {
          const num = parseInt(hexColor.slice(1), 16);
          const r = Math.min(255, Math.floor((num >> 16) + (255 - (num >> 16)) * percent));
          const g = Math.min(255, Math.floor(((num >> 8) & 0x00FF) + (255 - ((num >> 8) & 0x00FF)) * percent));
          const b = Math.min(255, Math.floor((num & 0x0000FF) + (255 - (num & 0x0000FF)) * percent));
          return `#${(0x1000000 + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        };

        const hoverColor = darkenColor(color, 0.15);
        const lightColor = lightenColor(color, 0.92);
        const darkLightColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.05)`;

        styleElement.innerHTML = `
          :root {
            --primary: ${rgb.r} ${rgb.g} ${rgb.b};
            --primary-foreground: 255 255 255;
          }

          /* 主要颜色类 */
          .bg-primary,
          .bg-blue-500,
          .bg-blue-400,
          [data-state=checked].bg-blue-500,
          [data-state=active].data-\\[state\\=active\\]\\:bg-blue-500 {
            background-color: ${color} !important;
          }

          .hover\\:bg-blue-600:hover,
          .hover\\:bg-blue-500:hover {
            background-color: ${hoverColor} !important;
          }

          /* 不透明度背景色 - 用于选中节点 */
          .bg-blue-100\\/90 {
            background-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15) !important;
          }

          .dark .bg-blue-500\\/15,
          .dark\\:bg-blue-500\\/15:is(.dark *) {
            background-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15) !important;
          }

          /* 只覆盖特定的蓝色文本，不影响primary */
          .text-blue-500,
          .text-blue-600,
          .text-blue-400,
          .text-blue-200,
          .dark\\:text-blue-400:is(.dark *),
          .dark\\:text-blue-200:is(.dark *) {
            color: ${color} !important;
          }

          /* 悬停时的蓝色文本 */
          .hover\\:text-blue-200:hover,
          .dark\\:hover\\:text-blue-200:is(.dark *):hover,
          .dark [data-state=inactive].dark\\:data-\\[state\\=inactive\\]\\:hover\\:text-blue-200:hover {
            color: ${color} !important;
          }

          /* Tab选中等特定场景的primary文本 */
          [data-state=active].text-primary {
            color: ${color} !important;
          }

          /* Tab选中状态的白色文字 - 用于data-[state=active]:text-white */
          [data-state=active].data-\\[state\\=active\\]\\:text-white {
            color: white !important;
          }

          /* 边框颜色 - 只用于特定元素 */
          .border-blue-500,
          .border-blue-300,
          .border-l-blue-500,
          .dark\\:border-blue-400:is(.dark *),
          .dark\\:border-blue-500:is(.dark *),
          .dark\\:border-l-blue-400:is(.dark *) {
            border-color: ${color} !important;
          }

          /* 主要边框 - 只用于激活状态 */
          .bg-primary.border-primary {
            border-color: ${color} !important;
          }

          /* 渐变背景 */
          .from-blue-400,
          .from-blue-500 {
            --tw-gradient-from: ${color} var(--tw-gradient-from-position) !important;
            --tw-gradient-to: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0) var(--tw-gradient-to-position) !important;
            --tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to) !important;
          }

          .to-blue-500,
          .to-blue-600 {
            --tw-gradient-to: ${hoverColor} var(--tw-gradient-to-position) !important;
          }

          /* 焦点环 */
          .ring-primary,
          .ring-blue-500,
          .ring-2.ring-blue-500,
          .focus-visible\\:ring-blue-500\\/60:focus-visible,
          .focus-visible\\:ring-blue-400\\/60:focus-visible {
            --tw-ring-color: ${color} !important;
          }

          /* Slider accent color */
          .accent-blue-500,
          input[type="range"]::-webkit-slider-thumb {
            accent-color: ${color} !important;
          }

          /* Switch组件选中状态 */
          [data-state=checked]:is(.peer) {
            background-color: ${color} !important;
          }

          /* 悬停背景（浅色） */
          .hover\\:bg-blue-50\\/50:hover {
            background-color: ${lightColor} !important;
          }

          .dark\\:hover\\:bg-blue-900\\/5:is(.dark *):hover {
            background-color: ${darkLightColor} !important;
          }

          /* 活跃导航项 */
          .bg-primary.text-primary-foreground {
            background-color: ${color} !important;
            color: white !important;
          }

          /* 确保图标也是白色 */
          .bg-primary .text-primary-foreground,
          .text-primary-foreground svg {
            color: white !important;
          }

          /* Tab选中状态 */
          [data-state=active].border-blue-500,
          [data-state=active].text-blue-600 {
            border-color: ${color} !important;
            color: ${color} !important;
          }

          .dark [data-state=active].text-blue-400 {
            color: ${color} !important;
          }

          /* TabsTrigger选中状态 - 支持data-[state=active]:bg-primary */
          [data-state=active].data-\\[state\\=active\\]\\:bg-primary,
          [data-state=active][class*="data-[state=active]:bg-primary"] {
            background-color: ${color} !important;
          }

          /* TabsTrigger选中状态文字颜色 - 支持data-[state=active]:text-primary-foreground */
          [data-state=active].data-\\[state\\=active\\]\\:text-primary-foreground,
          [data-state=active][class*="data-[state=active]:text-primary-foreground"] {
            color: white !important;
          }
        `;

        if (!document.getElementById('theme-color-override')) {
          document.head.appendChild(styleElement);
        }

        console.log('[Layout] 主题色已应用');
      } else {
        console.error('[Layout] 无效的颜色值:', color);
      }
    };

    // 页面加载时应用已保存的主题色
    const loadSavedThemeColor = async () => {
      try {
        const colorResult = await window.electronAPI.getThemeColor();
        if (colorResult.success && colorResult.color) {
          console.log('[Layout] 加载保存的主题色:', colorResult.color);
          applyThemeColor(colorResult.color);
        }
      } catch (error) {
        console.error('[Layout] 加载主题色失败:', error);
      }
    };

    loadSavedThemeColor();

    // 监听主题色变化
    const cleanup = window.electronAPI.onThemeColorChanged?.(applyThemeColor);

    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const isActivePath = (href: string) => {
    if (!pathname) return false;
    if (pathname === href) return true;
    return href !== '/' && pathname.startsWith(href);
  };

  const getNavLinkClass = (href: string, collapsed: boolean) =>
    classNames(
      'group relative flex items-center rounded-lg text-[13px] font-medium transition-all duration-150',
      collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-3 py-2',
      isActivePath(href)
        ? 'bg-primary text-primary-foreground'
        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
    );

  const getIconWrapperClass = (href: string, collapsed: boolean) =>
    classNames(
      'flex h-6 w-6 flex-shrink-0 items-center justify-center',
      isActivePath(href)
        ? 'text-primary-foreground'
        : 'text-muted-foreground group-hover:text-foreground'
    );

  const isDashboard = !pathname || pathname === '/';
  const isPlainView =
    !pathname ||
    pathname === '/' ||
    pathname.startsWith('/nodes') ||
    pathname.startsWith('/match-rules') ||
    pathname.startsWith('/overrides') ||
    pathname.startsWith('/external-resources') ||
    pathname.startsWith('/subscriptions') ||
    pathname.startsWith('/connections') ||
    pathname.startsWith('/tools') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/providers') ||
    pathname.startsWith('/converter') ||
    pathname.startsWith('/logs') ||
    pathname.startsWith('/proxy-icon-settings');

  return (
    <>
      <div className="relative h-screen overflow-hidden bg-transparent">
        <TitleBar />

        <div className="relative z-10 mx-auto flex h-full w-full max-w-[1400px] min-w-0 gap-2 pl-1.5 pr-3 pb-6 pt-10 sm:gap-3 sm:pl-2 sm:pr-4 md:gap-3 md:pl-3 md:pr-5">
        {/* Sidebar - Desktop */}
        <aside
          className={classNames(
            'hidden md:flex h-full flex-col shrink-0 px-0 transition-[width] duration-300 ease-out',
            sidebarCollapsed ? 'w-[70px]' : 'w-[220px]'
          )}
        >
          <div
            className={classNames(
              'flex items-center px-3 pt-6 pb-4 transition-all duration-300',
              sidebarCollapsed ? 'justify-center' : 'gap-3'
            )}
          >
            <img src="/logo.png" alt="FlyClash Logo" className="h-8 w-8" />
            {!sidebarCollapsed && (
              <div className="leading-tight">
                <span className="block text-sm font-semibold text-foreground">FlyClash</span>
                <span className="text-xs text-muted-foreground">
                  {mounted ? t('layout.desktopClient') : '\u00A0'}
                </span>
              </div>
            )}
          </div>

          <div className="flex-1 px-3 pb-4">
            <nav className="flex flex-col gap-1">
              {menuItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={getNavLinkClass(item.href, sidebarCollapsed)}
                >
                  <span className={getIconWrapperClass(item.href, sidebarCollapsed)}>
                    {item.icon}
                  </span>
                  {!sidebarCollapsed && <span className="text-[13px]">{mounted ? item.name : '\u00A0'}</span>}
                  {sidebarCollapsed && <span className="sr-only">{mounted ? item.name : '\u00A0'}</span>}
                </Link>
              ))}
            </nav>
          </div>

          <div className="px-3 pb-4">
            <div
              className={classNames(
                'flex items-center gap-2 text-[11px] text-muted-foreground',
                sidebarCollapsed ? 'justify-center' : 'justify-between'
              )}
            >
              <div className="flex items-center gap-2">
                <span className="indicator-dot" />
                {!sidebarCollapsed && <span className="font-medium text-foreground">已连接</span>}
              </div>
              <span className="text-muted-foreground">v{appVersion}</span>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex h-full min-w-0 flex-1 flex-col gap-3 md:gap-4">
          {/* Mobile Navigation */}
          <div className="md:hidden">
            <div className="glass-panel flex items-center justify-between rounded-2xl px-4 py-3" data-hoverable="false">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                  <img src="/logo.png" alt="FlyClash Logo" className="h-5 w-5" />
                </div>
                <span className="text-sm font-semibold text-foreground">FlyClash</span>
              </div>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-muted-foreground hover:text-foreground"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              >
                {mobileMenuOpen ? <Cross1Icon className="h-4 w-4" /> : <HamburgerMenuIcon className="h-4 w-4" />}
              </button>
            </div>

            {mobileMenuOpen && (
              <div className="mt-2 glass-panel space-y-1 rounded-2xl px-2.5 py-2.5" data-hoverable="false">
                {menuItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={getNavLinkClass(item.href, false)}
                  >
                    <span className={getIconWrapperClass(item.href, false)}>
                      {item.icon}
                    </span>
                    <span className="text-[13px]">{mounted ? item.name : '\u00A0'}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div
            className={classNames(
              'flex flex-1 flex-col min-w-0 overflow-y-auto custom-scrollbar',
              { 'glass-panel card-surface rounded-2xl': !isPlainView }
            )}
            data-hoverable={!isPlainView ? 'false' : undefined}
          >
            <main className="relative flex-1 min-w-0">
              <div
                className={classNames(
                  'w-full min-w-0 py-5 sm:py-6 md:py-6',
                  isPlainView
                    ? 'pl-3 pr-2 sm:pl-4 sm:pr-3 md:pl-5 md:pr-3'
                    : 'mx-auto max-w-[1400px] pl-3 pr-2 sm:pl-4 sm:pr-3 md:pl-5 md:pr-3'
                )}
              >
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>

      {pendingUpdate && (
        <Dialog open={updateDialogOpen} onOpenChange={setUpdateDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('settings.updateAvailableTitle')}</DialogTitle>
              <DialogDescription>
                {t('settings.updateAvailableDesc', {
                  latest: releaseVersionLabel,
                  current: pendingUpdate.currentVersion,
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              {releasePublishedAt && (
                <p className="text-xs text-muted-foreground">
                  {t('settings.updatePublishedAt', { date: releasePublishedAt })}
                </p>
              )}

              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">
                  {t('settings.updateChangelog')}
                </h4>
                <div className="max-h-72 overflow-y-auto rounded-2xl bg-muted/30 p-4 text-left text-sm whitespace-pre-wrap font-mono text-foreground/90">
                  {pendingUpdate.body?.trim()
                    ? pendingUpdate.body.trim()
                    : t('settings.updateNoChangelog')}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setUpdateDialogOpen(false)}
                className="border border-blue-200 text-blue-600 hover:bg-blue-50 dark:border-blue-400/50 dark:text-blue-300 dark:hover:bg-blue-500/10"
              >
                {t('settings.updateLater')}
              </Button>
              <Button
                onClick={handleOpenReleasePage}
                className="bg-blue-500 hover:bg-blue-600 text-white"
              >
                {t('settings.updateViewRelease')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
