const { nativeTheme } = require('electron');

/**
 * 窗口背景效果管理模块
 *
 * 负责 macOS / Windows 平台的毛玻璃、Acrylic、Mica 等背景效果，
 * 以及自定义背景图片的应用。
 *
 * @param {Object} deps - 依赖注入
 * @param {Object} deps.state          - 共享状态
 * @param {Object} deps.dbManager      - 数据库管理器
 * @param {Function} deps.enableAcrylic - Windows Acrylic 效果函数
 * @param {boolean} deps.isWindows     - 是否 Windows 平台
 * @param {boolean} deps.isMac         - 是否 macOS 平台
 */
function createBackdropManager(deps) {
  const { state, dbManager, enableAcrylic, isWindows, isMac } = deps;

  const BACKDROP_REFRESH_DELAYS = [0, 24, 120, 480];

  function applyMacOSBackdrop(win) {
    if (!isMac || !win || win.isDestroyed?.()) {
      return;
    }

    const mode = state.appearanceMode || 'default';
    const isDark = nativeTheme.shouldUseDarkColors;

    console.log(`[macOS] 应用背景效果，模式: ${mode}, 深色模式: ${isDark}`);

    try {
      win.setVibrancy(null);
    } catch {}

    if (mode === 'solid') {
      const bgColor = isDark ? '#1a1a1a' : '#e5e7eb';
      win.setBackgroundColor(bgColor);
      console.log(`[macOS] 已应用纯色背景: ${bgColor}`);
      return;
    }

    win.setBackgroundColor('#00000000');
    const vibrancyMode = 'under-window';

    try {
      win.setVibrancy(vibrancyMode);
      console.log(`[macOS] 已启用毛玻璃效果: ${vibrancyMode}`);
    } catch (error) {
      console.warn(`[macOS] 毛玻璃效果 ${vibrancyMode} 不可用:`, error?.message || error);
      win.setBackgroundColor(isDark ? '#e60f172a' : '#fcffffff');
    }
  }
  function applyWindowsBackdrop(win) {
    if (!isWindows || !win || win.isDestroyed?.()) {
      return;
    }

    const mode = state.appearanceMode || 'dynamic';
    const isDark = nativeTheme.shouldUseDarkColors;

    try { win.setVibrancy(null); } catch {}
    try { win.setBackgroundMaterial('none'); } catch {}
    try { win.setBackgroundColor('#00000000'); } catch {}

    const applyTitleBarOverlay = () => {
      const overlayOptions = win.getTitleBarOverlayHeight ? win.getTitleBarOverlayOptions?.() : undefined;
      if (overlayOptions) {
        try {
          win.setTitleBarOverlay({
            color: '#00000000',
            symbolColor: isDark ? '#f3f4f6' : '#0f172a',
            height: overlayOptions.height ?? 48,
          });
        } catch (error) {
          console.warn('更新透明标题栏失败:', error?.message || error);
        }
      }
    };

    if (mode === 'solid') {
      applyTitleBarOverlay();
      win.setBackgroundColor(isDark ? '#1a1a1a' : '#e5e7eb');
      return;
    }

    const backgroundMaterials = mode === 'acrylic'
      ? ['acrylic', 'tabbed', 'mica', 'mica-alt']
      : ['tabbed', 'mica', 'mica-alt'];

    let materialApplied = false;
    for (const material of backgroundMaterials) {
      try {
        win.setBackgroundMaterial(material);
        materialApplied = true;
        console.log(`已启用背景材质: ${material}`);
        break;
      } catch (error) {
        console.warn(`背景材质 ${material} 不可用:`, error?.message || error);
      }
    }
    const vibrancyModes = mode === 'dynamic'
      ? ['appearance-based', 'light', 'medium-light', 'ultra-dark', 'sidebar', 'popover']
      : [];
    let vibrancyApplied = false;
    for (const vMode of vibrancyModes) {
      try {
        win.setVibrancy(vMode);
        vibrancyApplied = true;
        console.log(`已启用 Vibrancy 模式: ${vMode}`);
        break;
      } catch (error) {
        console.warn(`Vibrancy 模式 ${vMode} 不可用:`, error?.message || error);
      }
    }

    applyTitleBarOverlay();

    if (!materialApplied && !vibrancyApplied) {
      win.setBackgroundColor(isDark ? '#e60f172a' : '#fcffffff');
    }

    if (mode === 'acrylic') {
      try {
        const rgba = (alpha, r, g, b) => ((alpha & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
        const tint = isDark
          ? rgba(0xf0, 24, 32, 68)
          : rgba(0x99, 255, 255, 255);
        const success = enableAcrylic(win, { tintColor: tint, accentFlags: 2 });
        if (success) {
          console.log('已启用 Windows Acrylic 透明效果');
        }
      } catch (error) {
        console.warn('启用 Acrylic 效果失败:', error?.message || error);
      }
    }
  }

  function forceWindowsBackdropRepaint(win) {
    if (!isWindows || !win || win.isDestroyed?.()) {
      return;
    }

    if (state.appearanceMode === 'solid') {
      return;
    }

    const key = Symbol.for('flyclash.backdropNudgeCount');
    win[key] = (win[key] || 0) + 1;
    if (win[key] > 4) {
      return;
    }
    let bounds;
    try {
      bounds = win.getBounds();
    } catch (error) {
      console.warn('获取窗口尺寸失败:', error?.message || error);
      return;
    }

    const { x, y, width, height } = bounds;
    if (typeof width !== 'number' || typeof height !== 'number') {
      return;
    }

    try {
      win.setBounds({ x, y, width: width + 4, height: height + 2 }, false);
      setTimeout(() => {
        if (!win.isDestroyed?.()) {
          win.setBounds({ x, y, width, height }, false);
        }
      }, 40);
    } catch (error) {
      console.warn('触发窗口重绘失败:', error?.message || error);
    }
  }

  function refreshWindowsBackdrop(win, attempt = 0) {
    if (!isWindows || !win || win.isDestroyed?.()) {
      return;
    }

    const delay = BACKDROP_REFRESH_DELAYS[Math.min(attempt, BACKDROP_REFRESH_DELAYS.length - 1)];
    const timer = setTimeout(() => {
      if (win.isDestroyed?.()) {
        return;
      }

      try {
        applyWindowsBackdrop(win);
      } catch (error) {
        console.warn('刷新 Windows 背景材质失败:', error?.message || error);
      }

      if (attempt + 1 < BACKDROP_REFRESH_DELAYS.length) {
        refreshWindowsBackdrop(win, attempt + 1);
      }

      if (attempt >= 1) {
        forceWindowsBackdropRepaint(win);
      }
    }, delay);

    timer.unref?.();
  }
  function applyCustomBackground(win) {
    if (!win || win.isDestroyed?.()) {
      return;
    }

    try {
      const configStr = dbManager.getSetting('customBackground', null);
      if (!configStr) {
        console.warn('未找到自定义背景配置');
        return;
      }

      const config = JSON.parse(configStr);
      const { imagePath, opacity = 80, blur = 10 } = config;

      console.log('[自定义背景] 应用背景图片:', imagePath, '透明度:', opacity, '模糊度:', blur);

      try { win.setVibrancy(null); } catch {}
      try { win.setBackgroundMaterial?.('none'); } catch {}
      win.setBackgroundColor('#00000000');

      const fs = require('fs');
      const path = require('path');

      try {
        const imageBuffer = fs.readFileSync(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mimeTypes = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
          '.webp': 'image/webp'
        };
        const mimeType = mimeTypes[ext] || 'image/png';
        const base64Image = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

        if (win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send('apply-custom-background', {
            imageData: base64Image, opacity, blur
          });
          console.log('[自定义背景] 背景配置已发送到渲染进程');
        }
      } catch (readError) {
        console.error('[自定义背景] 读取图片文件失败:', readError);
        if (win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send('apply-custom-background', {
            imagePath, opacity, blur
          });
        }
      }
    } catch (error) {
      console.error('[自定义背景] 应用自定义背景失败:', error);
    }
  }

  return {
    applyMacOSBackdrop,
    applyWindowsBackdrop,
    forceWindowsBackdropRepaint,
    refreshWindowsBackdrop,
    applyCustomBackground,
  };
}

module.exports = { createBackdropManager };
