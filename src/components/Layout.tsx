import React, { useState, useEffect, useMemo, useCallback } from 'react';
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

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    const storedState = window.localStorage.getItem('flyclash-sidebar-collapsed');
    return storedState === 'true';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.7');
  const { hasProviders } = useProviderAvailability();

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
      { name: '控制面板', href: '/', icon: <DashboardIcon className="w-5 h-5" /> },
      { name: '节点管理', href: '/nodes', icon: <GlobeIcon className="w-5 h-5" /> },
      { name: '匹配规则', href: '/match-rules', icon: <FileTextIcon className="w-5 h-5" /> },
      { name: '配置覆写', href: '/overrides', icon: <MixerHorizontalIcon className="w-5 h-5" /> },
      { name: '外部资源', href: '/external-resources', icon: <LayersIcon className="w-5 h-5" /> },
      { name: '连接数据', href: '/connections', icon: <BarChartIcon className="w-5 h-5" /> },
      { name: '配置管理', href: '/subscriptions', icon: <ReaderIcon className="w-5 h-5" /> },
      { name: '实用工具', href: '/tools', icon: <GearIcon className="w-5 h-5" /> },
      { name: '日志', href: '/logs', icon: <InfoCircledIcon className="w-5 h-5" /> },
      { name: '系统设置', href: '/settings', icon: <GearIcon className="w-5 h-5" /> },
    ];

    if (hasProviders) {
      items.splice(7, 0, { name: '提供者', href: '/providers', icon: <CloudOutlineIcon className="w-5 h-5" /> });
    }

    return items;
  }, [hasProviders]);

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
    pathname.startsWith('/logs');

  return (
    <div className="relative h-screen overflow-hidden bg-transparent">
      <TitleBar />

      <div className="relative z-10 mx-auto flex h-full w-full max-w-[1400px] min-w-0 gap-2 pl-1.5 pr-3 pb-6 pt-10 sm:gap-3 sm:pl-2 sm:pr-4 md:gap-3 md:pl-3 md:pr-5">
        {/* Sidebar - Desktop */}
        <aside
          className={classNames(
            'hidden md:flex h-full flex-col shrink-0 border-r border-white/15 px-0 transition-[width] duration-300 ease-out backdrop-blur-xl dark:border-white/10',
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
                <span className="text-xs text-muted-foreground">桌面客户端</span>
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
                  {!sidebarCollapsed && <span className="text-[13px]">{item.name}</span>}
                  {sidebarCollapsed && <span className="sr-only">{item.name}</span>}
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
                    <span className="text-[13px]">{item.name}</span>
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
  );
}
