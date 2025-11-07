import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Toast from '@radix-ui/react-toast';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useMihomoAPI } from '../services/mihomo-api';
import { Switch } from './ui/switch';
import OverrideSettings, { OverrideSettingsRef } from './OverrideSettings';
import { Button } from './ui/button';
import TunSettings from './TunSettings';
import BackupSettings from './BackupSettings';
import { useTranslation } from 'react-i18next';
import { compareVersions, fetchLatestRelease, emitUpdateAvailableEvent } from '@/utils/update-check';

export default function Settings() {
  const { t, i18n } = useTranslation();
  const [startWithSystem, setStartWithSystem] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  const [autoCheckInitialized, setAutoCheckInitialized] = useState(false);
  const [theme, setTheme] = useState('system');
  const [language, setLanguage] = useState(i18n.language || 'zh-CN');
  const [appearanceMode, setAppearanceMode] = useState<'acrylic' | 'dynamic' | 'solid' | 'custom'>('dynamic');
  const [customBackground, setCustomBackground] = useState('');
  const [backgroundOpacity, setBackgroundOpacity] = useState(80);
  const [backgroundBlur, setBackgroundBlur] = useState(10);
  const [backgroundImageName, setBackgroundImageName] = useState(t('settings.notSelected'));
  const [themeColor, setThemeColor] = useState('#3b82f6'); // 默认蓝色
  const [customColor, setCustomColor] = useState('#3b82f6');
  const [appVersion, setAppVersion] = useState('');
  const [subscriptionUA, setSubscriptionUA] = useState('MihomoParty') ;
  const [kernelPath, setKernelPath] = useState('');
  const [kernelIsDefault, setKernelIsDefault] = useState(true);
  const [kernelExists, setKernelExists] = useState(true);
  const [supportsAdvancedBackdrop, setSupportsAdvancedBackdrop] = useState(true);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const isFirstRender = useRef(true);

  // Refs for override settings components
  const overrideSettingsRef = useRef<OverrideSettingsRef>(null);
  const [isSavingOverride, setIsSavingOverride] = useState(false);
  
  // Toast提示相关状态
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error' | 'info'>('success');

  const refreshKernelPath = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    try {
      const result = await window.electronAPI.getKernelPath();
      if (result && result.success) {
        setKernelPath(result.path || '');
        setKernelIsDefault(Boolean(result.isDefault));
        setKernelExists(result.exists !== false);
      }
    } catch (error) {
      console.error('获取内核路径失败:', error);
    }
  }, []);
  
  // 使用mihomo API
  let mihomoAPI = useMihomoAPI();

  // 在组件加载时获取保存的主题和应用版本号
  useEffect(() => {
    const fetchData = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
          // 获取API配置
          const apiConfigResult = await window.electronAPI.getApiConfig();
          if (apiConfigResult.success) {
            // 使用正确的API配置初始化mihomoAPI
            mihomoAPI = useMihomoAPI({
              host: apiConfigResult.controllerHost,
              port: apiConfigResult.controllerPort,
              secret: apiConfigResult.secret
            });
          }
          
          // 获取主题
          const themeResult = await window.electronAPI.getTheme();
          if (themeResult.success) {
            setTheme(themeResult.theme);
          }

          // 获取系统是否支持高级背景效果
          const backdropSupport = await window.electronAPI.supportsAdvancedBackdrop?.();
          const supportsAdvanced = backdropSupport?.success ? backdropSupport.supported : true;
          setSupportsAdvancedBackdrop(supportsAdvanced);

          const appearanceResult = await window.electronAPI.getAppearanceMode?.();
          if (appearanceResult?.success && appearanceResult.mode) {
            let mode = appearanceResult.mode as 'acrylic' | 'dynamic' | 'solid' | 'custom';
            // 如果系统不支持高级背景效果，且当前模式是 dynamic 或 acrylic，则改为 solid
            if (!supportsAdvanced && (mode === 'dynamic' || mode === 'acrylic')) {
              mode = 'solid';
              // 保存新的默认值
              await window.electronAPI.setAppearanceMode?.(mode);
            }
            setAppearanceMode(mode);
          } else if (!supportsAdvanced) {
            // 如果没有保存的外观模式且系统不支持高级背景，默认使用 solid
            setAppearanceMode('solid');
          }

          // 获取应用版本号
          const version = await window.electronAPI.getAppVersion();
          setAppVersion(version);
          
          // 获取开机启动状态
          const autoLaunchState = await window.electronAPI.getAutoLaunchState();
          setStartWithSystem(autoLaunchState);

          // 获取静默启动设置
          const silentStartResult = await window.electronAPI.getSilentStart();
          if (silentStartResult.success) {
            setSilentStart(silentStartResult.silentStart);
          }

          // 获取订阅UA设置
          const userSettings = await window.electronAPI.getProxySettings();
          if (userSettings.success && userSettings.settings && userSettings.settings['subscription-ua']) {
            setSubscriptionUA(userSettings.settings['subscription-ua']);
        }

        await refreshKernelPath();
      }
    } catch (error) {
      console.error('获取设置数据失败:', error);
    }
  };

    fetchData();

    // 监听主题变更事件
    const handleThemeChanged = async (_event: any, newTheme: string) => {
      // 获取当前保存的主题设置
      const themeResult = await window.electronAPI.getTheme();
      if (themeResult.success) {
        // 更新 theme state 为保存的设置值（可能是 'system'）
        setTheme(themeResult.theme);
      }

      // 更新文档的类名来应用实际主题
      if (newTheme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
      } else {
        document.documentElement.classList.add('light');
        document.documentElement.classList.remove('dark');
      }
    };

    // 监听服务重启事件
    const handleServiceRestarted = (result: {success: boolean, error?: string}) => {
      if (result.success) {
        showToast("服务已重启", "新设置已应用", "success");
      } else {
        showToast("服务重启失败", result.error || "未知错误", "error");
      }
    };

    // 添加事件监听器
    if (typeof window !== 'undefined' && window.electronAPI) {
      const removeThemeListener = window.electronAPI.onThemeChanged(handleThemeChanged);
      const removeServiceRestarted = window.electronAPI.onServiceRestarted(handleServiceRestarted);
      const removeAppearanceListener = window.electronAPI.onAppearanceModeChanged
        ? window.electronAPI.onAppearanceModeChanged((mode: 'acrylic' | 'dynamic' | 'solid' | 'custom') => {
            setAppearanceMode(mode);
          })
        : undefined;

      // 清理函数
      return () => {
        window.electronAPI?.removeThemeListener?.();
        if (typeof removeThemeListener === 'function') removeThemeListener();
        if (typeof removeServiceRestarted === 'function') removeServiceRestarted();
        if (typeof removeAppearanceListener === 'function') removeAppearanceListener();
      };
    }
    return undefined;
  }, [refreshKernelPath]);

  // 监听开机启动设置变化
  const updateAutoLaunch = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        // 使用新的API设置开机启动
        await window.electronAPI.setAutoLaunch(startWithSystem);
        console.log('开机启动设置已更新:', startWithSystem);
      } catch (error) {
        console.error('更新开机启动设置失败:', error);
        // 如果设置失败，可以恢复UI状态（可选）
        try {
          const currentState = await window.electronAPI.getAutoLaunchState();
          setStartWithSystem(currentState);
        } catch {}
      }
    }
  }, [startWithSystem]);

  // 监听静默启动设置变化
  const updateSilentStart = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        const result = await window.electronAPI.setSilentStart(silentStart);
        if (result.success) {
          console.log('静默启动设置已更新:', silentStart);
        } else {
          console.error('更新静默启动设置失败:', result.error);
        }
      } catch (error) {
        console.error('更新静默启动设置失败:', error);
      }
    }
  }, [silentStart]);

  useEffect(() => {
    let isMounted = true;

    const loadAutoCheckSetting = async () => {
      if (typeof window === 'undefined' || !window.electronAPI?.getSetting) {
        setAutoCheckInitialized(true);
        return;
      }

      try {
        const result = await window.electronAPI.getSetting('autoCheckUpdate', true);
        if (!isMounted) return;
        if (result.success) {
          setAutoCheckUpdate(result.value !== false);
        } else {
          setAutoCheckUpdate(true);
        }
      } catch (error) {
        console.error('加载自动检查更新设置失败:', error);
        if (isMounted) {
          setAutoCheckUpdate(true);
        }
      } finally {
        if (isMounted) {
          setAutoCheckInitialized(true);
        }
      }
    };

    loadAutoCheckSetting();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!autoCheckInitialized || typeof window === 'undefined' || !window.electronAPI?.setSetting) {
      return;
    }

    const saveSetting = async () => {
      try {
        await window.electronAPI.setSetting('autoCheckUpdate', autoCheckUpdate);
      } catch (error) {
        console.error('保存自动检查更新设置失败:', error);
      }
    };

    saveSetting();
  }, [autoCheckInitialized, autoCheckUpdate]);
  
  useEffect(() => {
    // 组件首次加载时不调用，只在状态变化时调用
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    updateAutoLaunch();
  }, [updateAutoLaunch]);

  useEffect(() => {
    // 组件首次加载时不调用，只在状态变化时调用
    if (isFirstRender.current) {
      return;
    }

    updateSilentStart();
  }, [updateSilentStart]);

  // 处理主题切换
  const handleThemeChange = async (newTheme: string) => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.setTheme(newTheme);
        if (result.success) {
          setTheme(newTheme);

          // 直接更新文档的类名来立即应用主题
          let actualTheme = newTheme;
          if (newTheme === 'system') {
            actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
          }

          if (actualTheme === 'dark') {
            document.documentElement.classList.add('dark');
            document.documentElement.classList.remove('light');
          } else {
            document.documentElement.classList.add('light');
            document.documentElement.classList.remove('dark');
          }
        }
      }
    } catch (error) {
      console.error('设置主题失败:', error);
    }
  };

  // 处理语言切换
  const handleLanguageChange = async (newLanguage: string) => {
    try {
      setLanguage(newLanguage);
      await i18n.changeLanguage(newLanguage);
      localStorage.setItem('language', newLanguage);
      showToast('成功', '语言设置已保存', 'success');
    } catch (error) {
      console.error('设置语言失败:', error);
      showToast('错误', `设置语言失败: ${error}`, 'error');
    }
  };

  const handleAppearanceModeChange = async (mode: 'acrylic' | 'dynamic' | 'solid' | 'custom') => {
    if (appearanceMode === mode) {
      return;
    }

    // 如果从自定义模式切换到其他模式，先清除自定义背景样式
    if (appearanceMode === 'custom' && mode !== 'custom') {
      const styleElement = document.getElementById('custom-background-style');
      if (styleElement) {
        styleElement.remove();
        console.log('[Settings] 已清除自定义背景样式');
      }
    }

    // 如果切换到自定义模式但没有背景图片，先切换模式让用户可以选择图片
    if (mode === 'custom' && !customBackground) {
      setAppearanceMode(mode);
      showToast('提示', '请选择背景图片并调整效果', 'success');
      return;
    }

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.setAppearanceMode) {
        const result = await window.electronAPI.setAppearanceMode(mode);
        if (result.success) {
          setAppearanceMode(mode);
          showToast('成功', '窗口背景效果已更新', 'success');
        } else {
          showToast('错误', result.error || '更新窗口背景失败', 'error');
        }
      }
    } catch (error) {
      console.error('设置外观失败:', error);
      showToast('错误', `设置窗口背景失败: ${error}`, 'error');
    }
  };

  // 选择背景图片
  const handleSelectBackground = async () => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.selectBackgroundImage();
        if (result.success && result.path && !result.canceled) {
          setCustomBackground(result.path);

          const fileName = result.path.split(/[\\/]/).pop() || '未知文件';
          setBackgroundImageName(fileName);

          // 保存配置并应用
          await handleSaveCustomBackground(result.path, backgroundOpacity, backgroundBlur, true);
        }
      }
    } catch (error) {
      console.error('选择背景图片失败:', error);
      showToast('错误', `选择背景图片失败: ${error}`, 'error');
    }
  };

  // 保存自定义背景配置
  const handleSaveCustomBackground = async (path?: string, opacity?: number, blur?: number, applyImmediately?: boolean) => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const imagePath = path || customBackground;
        if (!imagePath) {
          showToast('错误', '请先选择背景图片', 'error');
          return;
        }

        const result = await window.electronAPI.setCustomBackground({
          imagePath,
          opacity: opacity ?? backgroundOpacity,
          blur: blur ?? backgroundBlur
        });

        if (result.success) {
          if (applyImmediately) {
            showToast('成功', '背景图片已选择，正在应用...', 'success');
            // 立即应用自定义背景
            const applyResult = await window.electronAPI.setAppearanceMode('custom');
            if (applyResult.success) {
              showToast('成功', '自定义背景已应用', 'success');
            }
          } else {
            // 如果当前是自定义模式，自动应用更新
            if (appearanceMode === 'custom') {
              await window.electronAPI.setAppearanceMode('custom');
            }
          }
        } else {
          showToast('错误', result.error || '保存自定义背景失败', 'error');
        }
      }
    } catch (error) {
      console.error('保存自定义背景失败:', error);
      showToast('错误', `保存自定义背景失败: ${error}`, 'error');
    }
  };

  // 使用refs来存储最新的值，避免闭包问题
  const latestOpacityRef = useRef(backgroundOpacity);
  const latestBlurRef = useRef(backgroundBlur);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 同步refs
  useEffect(() => {
    latestOpacityRef.current = backgroundOpacity;
  }, [backgroundOpacity]);

  useEffect(() => {
    latestBlurRef.current = backgroundBlur;
  }, [backgroundBlur]);

  // 处理透明度变化
  const handleOpacityChange = (value: number) => {
    setBackgroundOpacity(value);
    latestOpacityRef.current = value;

    // 清除之前的定时器
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // 延迟保存，避免拖动滑块时频繁触发
    saveTimeoutRef.current = setTimeout(async () => {
      if (customBackground) {
        await handleSaveCustomBackground(undefined, latestOpacityRef.current, latestBlurRef.current);
      }
    }, 300);
  };

  // 处理模糊度变化
  const handleBlurChange = (value: number) => {
    setBackgroundBlur(value);
    latestBlurRef.current = value;

    // 清除之前的定时器
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // 延迟保存，避免拖动滑块时频繁触发
    saveTimeoutRef.current = setTimeout(async () => {
      if (customBackground) {
        await handleSaveCustomBackground(undefined, latestOpacityRef.current, latestBlurRef.current);
      }
    }, 300);
  };

  // 预设主题色
  const presetColors = [
    { name: '经典蓝', value: '#3b82f6' },
    { name: '天空蓝', value: '#0ea5e9' },
    { name: '紫罗兰', value: '#8b5cf6' },
    { name: '粉红色', value: '#ec4899' },
    { name: '翡翠绿', value: '#10b981' },
    { name: '橙黄色', value: '#f59e0b' },
    { name: '红宝石', value: '#ef4444' },
    { name: '靛青色', value: '#6366f1' },
  ];

  // 将hex颜色转换为HSL格式
  const hexToHSL = (hex: string) => {
    // 移除#号
    hex = hex.replace('#', '');

    // 转换为RGB
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

  // 处理主题色变化
  const handleThemeColorChange = async (color: string) => {
    setThemeColor(color);
    setCustomColor(color);
    applyThemeColor(color);

    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.setThemeColor(color);
        if (result.success) {
          showToast('成功', '主题色已更新', 'success');
        } else {
          showToast('错误', result.error || '设置主题色失败', 'error');
        }
      }
    } catch (error) {
      console.error('设置主题色失败:', error);
      showToast('错误', `设置主题色失败: ${error}`, 'error');
    }
  };

  // 获取用户设置
  useEffect(() => {
    const fetchUserSettings = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI) {
          const result = await window.electronAPI.getProxySettings();

          if (result.success && result.settings) {
            console.log('获取到的设置:', result.settings);
            if (result.settings['appearanceMode']) {
              setAppearanceMode(result.settings['appearanceMode'] as 'acrylic' | 'dynamic' | 'solid' | 'custom');
            }
          }

          // 获取自定义背景配置
          const bgResult = await window.electronAPI.getCustomBackground();
          if (bgResult.success && bgResult.config) {
            setCustomBackground(bgResult.config.imagePath);
            setBackgroundOpacity(bgResult.config.opacity);
            setBackgroundBlur(bgResult.config.blur);

            // 提取文件名
            const fileName = bgResult.config.imagePath.split(/[\\/]/).pop() || '未选择';
            setBackgroundImageName(fileName);
          }

          // 获取主题色配置
          const colorResult = await window.electronAPI.getThemeColor();
          if (colorResult.success && colorResult.color) {
            setThemeColor(colorResult.color);
            setCustomColor(colorResult.color);
            applyThemeColor(colorResult.color);
          }
        }
      } catch (error) {
        console.error('获取用户设置失败:', error);
      }
    };

    fetchUserSettings();
    refreshKernelPath();
  }, []);

  // 显示Toast提示
  const showToast = (title: string, description: string, type: 'success' | 'error' | 'info') => {
    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(true);
  };

  const handleManualUpdateCheck = async () => {
    if (typeof window === 'undefined' || isCheckingUpdate) {
      return;
    }

    try {
      setIsCheckingUpdate(true);
      const currentVersion = await window.electronAPI?.getAppVersion?.();

      if (!currentVersion) {
        showToast(t('settings.checkUpdate'), t('settings.updateCheckFailed', { error: t('common.unknown') }), 'error');
        return;
      }

      const { release: latestRelease, error: fetchError } = await fetchLatestRelease();

      if (!latestRelease) {
        showToast(
          t('settings.checkUpdate'),
          t('settings.updateCheckNetworkErrorDetailed', { error: fetchError || t('common.unknown') }),
          'error'
        );
        return;
      }

      if (compareVersions(latestRelease.version, currentVersion) > 0) {
        emitUpdateAvailableEvent(latestRelease, currentVersion);
      } else {
        showToast(t('settings.checkUpdate'), t('settings.updateUpToDate'), 'info');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(t('settings.checkUpdate'), t('settings.updateCheckFailed', { error: message }), 'error');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const toastStatusMap = {
    success: {
      className: 'bg-green-500/10 text-green-600 dark:text-green-400',
      icon: (
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
      ),
    },
    error: {
      className: 'bg-red-500/10 text-red-600 dark:text-red-400',
      icon: (
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      ),
    },
    info: {
      className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      icon: (
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 3a1.1 1.1 0 110 2.2A1.1 1.1 0 0110 5zm1 9H9V9h2v5z" />
        </svg>
      ),
    },
  } as const;

  const currentToastStatus = toastStatusMap[toastType];

  const handleSelectKernel = async () => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    try {
      const result = await window.electronAPI.selectKernelExecutable();

      if (result?.success) {
        await refreshKernelPath();
        const message = result.needsRestart
          ? '内核路径已更新，请重新启动内核以生效'
          : '内核路径已更新';
        showToast('成功', message, 'success');
      } else if (!result?.canceled) {
        showToast('错误', result?.error || '选择内核文件失败', 'error');
      }
    } catch (error) {
      console.error('选择内核文件失败:', error);
      showToast('错误', String(error), 'error');
    }
  };

  const handleResetKernel = async () => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    try {
      const result = await window.electronAPI.resetKernelPath();
      if (result?.success) {
        await refreshKernelPath();
        const message = result.needsRestart
          ? '已恢复默认内核，请重新启动内核以生效'
          : '已恢复默认内核';
        showToast('成功', message, 'success');
      } else {
        showToast('错误', result?.error || '恢复默认内核失败', 'error');
      }
    } catch (error) {
      console.error('恢复默认内核失败:', error);
      showToast('错误', String(error), 'error');
    }
  };

  // 保存主题设置
  const saveThemeSettings = async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        const result = await window.electronAPI.setTheme(theme);
        if (result.success) {
          showToast('成功', '主题设置已保存', 'success');
        } else {
          showToast('错误', `保存主题设置失败: ${result.error}`, 'error');
        }
      } catch (error) {
        console.error('保存主题设置失败:', error);
        showToast('错误', `保存主题设置失败: ${error}`, 'error');
      }
    }
  };

  return (
    <div>
      <Toast.Provider swipeDirection="right">

        <div className="bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm p-6">
          <Tabs.Root defaultValue="general" className="w-full">
            <Tabs.List className="flex border-b border-gray-200 dark:border-gray-600 mb-6">
              <Tabs.Trigger
                value="general"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                {t('settings.general')}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="kernel"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                {t('settings.proxy')}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="override"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                {t('settings.override')}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="tun"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                {t('settings.tun')}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="backup"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                {t('settings.backup')}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="about"
                className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
              >
                {t('settings.about')}
              </Tabs.Trigger>
            </Tabs.List>
            
            <Tabs.Content value="general" className="w-full">
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('settings.startWithSystem')}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">{t('settings.startWithSystemDesc')}</p>
                  </div>
                  <Switch
                    checked={startWithSystem}
                    onCheckedChange={setStartWithSystem}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('settings.silentStart')}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">{t('settings.silentStartDesc')}</p>
                  </div>
                  <Switch
                    checked={silentStart}
                    onCheckedChange={setSilentStart}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('settings.minimizeToTray')}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">{t('settings.minimizeToTrayDesc')}</p>
                  </div>
                  <Switch
                    checked={minimizeToTray}
                    onCheckedChange={setMinimizeToTray}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('settings.autoCheckUpdate')}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">{t('settings.autoCheckUpdateDesc')}</p>
                  </div>
                  <Switch
                    checked={autoCheckUpdate}
                    disabled={!autoCheckInitialized}
                    onCheckedChange={setAutoCheckUpdate}
                  />
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('settings.language')}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">{t('settings.languageDesc')}</p>
                  <select
                    className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                    value={language}
                    onChange={(e) => handleLanguageChange(e.target.value)}
                  >
                    <option value="zh-CN">{t('settings.simplifiedChinese')}</option>
                    <option value="en-US">{t('settings.english')}</option>
                  </select>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('settings.subscriptionUA')}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">{t('settings.subscriptionUADesc')}</p>
                  <select
                    className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                    value={subscriptionUA}
                    onChange={(e) => {
                      const newUA = e.target.value;
                      setSubscriptionUA(newUA);

                      // 使用专用API保存UA设置，不会重启服务
                      if (typeof window !== 'undefined' && window.electronAPI) {
                        window.electronAPI.saveUASettings(newUA)
                          .then(result => {
                            if (result.success) {
                              showToast(t('common.success'), t('toast.settingsSaved'), 'success');
                            } else {
                              showToast(t('common.error'), `${t('toast.settingsSaveFailed')}: ${result.error}`, 'error');
                            }
                          })
                          .catch(error => {
                            console.error('保存UA设置失败:', error);
                            showToast(t('common.error'), `${t('toast.settingsSaveFailed')}: ${error}`, 'error');
                          });
                      }
                    }}
                  >
                    <option value="FlyClash">FlyClash</option>
                    <option value="Clash">{t('settings.clashForWindows')}</option>
                    <option value="Mihomo">{t('settings.mihomo')}</option>
                    <option value="MihomoParty">{t('settings.clashMetaDefault')}</option>
                    <option value="Chrome">{t('settings.chromeBrowser')}</option>
                  </select>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('settings.theme')}</h3>
                  <div className="flex gap-2">
                    <button
                      className={`py-1.5 px-3 text-sm rounded-lg transition-all duration-300 transform hover:scale-105 ${
                        theme === 'light'
                          ? 'bg-gradient-to-r from-blue-400 to-blue-500 text-white shadow-md'
                          : 'bg-gradient-to-r from-gray-100 to-gray-200 dark:from-[#2a2a2a] dark:to-[#333333] text-gray-700 dark:text-gray-200 hover:shadow-md'
                      }`}
                      onClick={() => handleThemeChange('light')}
                    >
                      {t('settings.light')}
                    </button>
                    <button
                      className={`py-1.5 px-3 text-sm rounded-lg transition-all duration-300 transform hover:scale-105 ${
                        theme === 'dark'
                          ? 'bg-gradient-to-r from-blue-400 to-blue-500 text-white shadow-md'
                          : 'bg-gradient-to-r from-gray-100 to-gray-200 dark:from-[#2a2a2a] dark:to-[#333333] text-gray-700 dark:text-gray-200 hover:shadow-md'
                      }`}
                      onClick={() => handleThemeChange('dark')}
                    >
                      {t('settings.dark')}
                    </button>
                    <button
                      className={`py-1.5 px-3 text-sm rounded-lg transition-all duration-300 transform hover:scale-105 ${
                        theme === 'system'
                          ? 'bg-gradient-to-r from-blue-400 to-blue-500 text-white shadow-md'
                          : 'bg-gradient-to-r from-gray-100 to-gray-200 dark:from-[#2a2a2a] dark:to-[#333333] text-gray-700 dark:text-gray-200 hover:shadow-md'
                      }`}
                      onClick={() => handleThemeChange('system')}
                    >
                      {t('settings.system')}
                    </button>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('settings.appearanceMode')}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('settings.appearanceModeDesc')}</p>
                  <div className="flex flex-wrap gap-2">
                    {/* 如果系统支持高级背景效果，显示所有选项 */}
                    {supportsAdvancedBackdrop ? (
                      <>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'dynamic'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('dynamic')}
                        >
                          {t('settings.defaultMode')}
                        </button>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'acrylic'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('acrylic')}
                        >
                          {t('settings.dynamicBlur')}
                        </button>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'solid'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('solid')}
                        >
                          {t('settings.solidBackground')}
                        </button>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'custom'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('custom')}
                        >
                          {t('settings.customBackground')}
                        </button>
                      </>
                    ) : (
                      <>
                        {/* 不支持高级背景效果的系统（Win11以下和Linux）只显示纯色和自定义背景 */}
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'solid'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('solid')}
                        >
                          {t('settings.solidBackground')}
                        </button>
                        <button
                          className={`py-1.5 px-3 text-xs rounded-lg transition-colors ${
                            appearanceMode === 'custom'
                              ? 'bg-blue-500 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                          }`}
                          onClick={() => handleAppearanceModeChange('custom')}
                        >
                          {t('settings.customBackground')}
                        </button>
                      </>
                    )}
                  </div>

                  {/* 自定义背景配置 */}
                  {appearanceMode === 'custom' && (
                    <div className="mt-4 p-4 bg-gray-50 dark:bg-[#1f1f1f] rounded-lg space-y-4">
                      <div>
                        <label className="text-xs font-medium text-gray-700 dark:text-gray-200 mb-2 block">
                          {t('settings.backgroundImage')}
                        </label>
                        <div className="flex gap-2 items-center">
                          <span className="text-xs text-gray-500 dark:text-gray-400 flex-1 truncate">
                            {backgroundImageName}
                          </span>
                          <button
                            className="py-1.5 px-3 text-xs rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
                            onClick={handleSelectBackground}
                          >
                            {t('settings.selectImage')}
                          </button>
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                            {t('settings.opacity')}
                          </label>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {backgroundOpacity}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={backgroundOpacity}
                          onChange={(e) => handleOpacityChange(Number(e.target.value))}
                          className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                            {t('settings.blur')}
                          </label>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {backgroundBlur}px
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="50"
                          value={backgroundBlur}
                          onChange={(e) => handleBlurChange(Number(e.target.value))}
                          className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* 主题色设置 */}
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('settings.themeColor')}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('settings.themeColorDesc')}</p>

                  {/* 预设主题色 */}
                  <div className="grid grid-cols-4 gap-2 mb-3">
                    {presetColors.map((preset) => (
                      <button
                        key={preset.value}
                        className={`flex flex-col items-center p-2 rounded-lg transition-all hover:scale-105 ${
                          themeColor === preset.value
                            ? 'bg-gray-100 dark:bg-[#1f1f1f] ring-2 ring-blue-500'
                            : 'bg-gray-50 dark:bg-[#1a1a1a] hover:bg-gray-100 dark:hover:bg-[#1f1f1f]'
                        }`}
                        onClick={() => handleThemeColorChange(preset.value)}
                      >
                        <div
                          className="w-8 h-8 rounded-full mb-1 shadow-sm"
                          style={{ backgroundColor: preset.value }}
                        />
                        <span className="text-xs text-gray-600 dark:text-gray-300">
                          {preset.name}
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* 自定义颜色选择器 */}
                  <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-[#1f1f1f] rounded-lg">
                    <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                      {t('settings.customColor')}
                    </label>
                    <div className="flex items-center gap-3 flex-1">
                      {/* 圆形颜色选择器 */}
                      <label className="relative group cursor-pointer">
                        <input
                          type="color"
                          value={customColor}
                          onChange={(e) => handleThemeColorChange(e.target.value)}
                          className="absolute opacity-0 w-0 h-0"
                        />
                        <div
                          className="w-10 h-10 rounded-full border-2 border-white dark:border-gray-700 shadow-md transition-transform group-hover:scale-110"
                          style={{ backgroundColor: customColor }}
                        />
                      </label>
                      {/* 颜色值输入框 */}
                      <input
                        type="text"
                        value={customColor}
                        onChange={(e) => {
                          const value = e.target.value;
                          setCustomColor(value);
                          // 验证是否是有效的颜色值
                          if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
                            handleThemeColorChange(value);
                          }
                        }}
                        placeholder="#3b82f6"
                        className="flex-1 py-2 px-3 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="kernel" className="w-full">
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('settings.kernelPath')}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
                    {t('settings.kernelPathDesc')}
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      type="text"
                      className="flex-1 py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                      value={kernelPath}
                      readOnly
                      spellCheck={false}
                    />
                    <div className="flex gap-2">
                      <button
                        className="py-1.5 px-3 text-sm rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors shadow-sm"
                        onClick={handleSelectKernel}
                      >
                        {t('settings.selectKernel')}
                      </button>
                      <button
                        className={`py-1.5 px-3 text-sm rounded-lg transition-colors shadow-sm ${
                          kernelIsDefault && kernelExists
                            ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-[#2a2a2a] dark:text-gray-500'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:text-gray-200 dark:hover:bg-[#333333]'
                        }`}
                        onClick={handleResetKernel}
                        disabled={kernelIsDefault && kernelExists}
                      >
                        {t('settings.resetKernel')}
                      </button>
                    </div>
                  </div>
                  {!kernelExists && (
                    <p className="text-xs text-red-500 dark:text-red-400 mt-2">
                      {t('settings.kernelNotFoundMsg')}
                    </p>
                  )}
                  {kernelIsDefault && kernelExists && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      {t('settings.usingDefaultKernel')}
                    </p>
                  )}
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="override" className="w-full">
              <div className="space-y-8">
                <OverrideSettings ref={overrideSettingsRef} />

                {/* 统一保存按钮 */}
                <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-gray-700">
                  <Button
                    onClick={async () => {
                      setIsSavingOverride(true);
                      try {
                        await overrideSettingsRef.current?.saveConfig();
                        showToast('成功', '所有配置已保存并应用', 'success');
                      } catch (error) {
                        console.error('保存配置时出错:', error);
                        showToast('错误', '保存配置时出错: ' + error, 'error');
                      } finally {
                        setIsSavingOverride(false);
                      }
                    }}
                    disabled={isSavingOverride}
                    className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                  >
                    {isSavingOverride ? t('settings.saving') : t('settings.saveAllConfigs')}
                  </Button>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="tun" className="w-full">
              <TunSettings />
            </Tabs.Content>

            <Tabs.Content value="backup" className="w-full">
              <BackupSettings />
            </Tabs.Content>

            <Tabs.Content value="about" className="w-full">
              <div className="flex flex-col items-center text-center py-8">
                {/* Logo */}
                <div className="mb-4">
                  <img src="/logo.png" alt="FlyClash Logo" className="h-20 w-20" />
                </div>

                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">FlyClash</h2>
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{t('settings.versionLabel')}: v{appVersion || t('settings.loading')}</p>

                <div className="bg-gray-50 dark:bg-[#222222] p-4 rounded-md mb-6 text-left w-full max-w-lg">
                  <p className="text-sm text-gray-700 dark:text-gray-200 mb-2">
                    {t('settings.aboutDescription')}
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-200">
                   {t('settings.aboutFeatures')}
                  </p>
                </div>
                
                <div className="flex flex-wrap gap-3 w-full max-w-lg justify-center">
                  <a
                    className="flex items-center justify-center py-2 px-4 bg-gradient-to-r from-gray-200 to-gray-300 hover:from-gray-300 hover:to-gray-400 dark:from-gray-700 dark:to-gray-800 dark:hover:from-gray-600 dark:hover:to-gray-700 text-gray-800 dark:text-gray-200 rounded-lg transition-all duration-300 transform hover:scale-105 hover:shadow-lg"
                    href="https://t.me/flyclash"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('settings.clashProject')}
                  </a>
                  <a
                    className="flex items-center justify-center py-2 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-lg transition-all duration-300 transform hover:scale-105 hover:shadow-lg"
                    href="https://github.com/GtxFury/FlyClash"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('settings.flyclashProject')}
                  </a>
                  <Button
                    onClick={handleManualUpdateCheck}
                    disabled={isCheckingUpdate}
                    className="flex items-center justify-center py-2 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-lg transition-all duration-300 transform hover:scale-105 hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed text-sm font-medium"
                  >
                    {isCheckingUpdate ? t('settings.updateChecking') : t('settings.checkUpdate')}
                  </Button>
                </div>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </div>
        
        {/* Toast提示组件 */}
        <Toast.Root
          open={toastOpen}
          onOpenChange={setToastOpen}
          duration={3000}
          className="fixed bottom-6 right-6 w-80 rounded-2xl shadow-lg backdrop-blur-sm z-[9999] transition-all bg-white/95 dark:bg-[#2a2a2a]/95"
        >
          <div className="p-4">
            <div className="flex items-start gap-3">
              {/* 图标 */}
              <div className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${currentToastStatus.className}`}>
                {currentToastStatus.icon}
              </div>

              {/* 内容 */}
              <div className="flex-1 min-w-0">
                <Toast.Title className="text-sm font-semibold text-foreground mb-1">
                  {toastTitle}
                </Toast.Title>
                <Toast.Description className="text-xs text-muted-foreground">
                  {toastDescription}
                </Toast.Description>
              </div>

              {/* 关闭按钮 */}
              <Toast.Close asChild>
                <button
                  className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Close"
                >
                  <Cross2Icon className="w-4 h-4" />
                </button>
              </Toast.Close>
            </div>
          </div>
        </Toast.Root>
        
        <Toast.Viewport />
      </Toast.Provider>
    </div>
  );
} 
