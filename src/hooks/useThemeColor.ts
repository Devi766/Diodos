import { useState, useEffect } from 'react';

const normalizeThemeColorPayload = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { color?: unknown; detail?: { color?: unknown } };
    if (typeof record.color === 'string') return record.color;
    if (typeof record.detail?.color === 'string') return record.detail.color;
  }
  return null;
};

export const useThemeColor = () => {
  const [themeColor, setThemeColor] = useState('#3b82f6'); // 默认蓝色

  useEffect(() => {
    // 获取初始主题色
    const fetchThemeColor = async () => {
      if (typeof window !== 'undefined' && window.electronAPI) {
        try {
          const result = await window.electronAPI.getThemeColor();
          if (result.success && result.color) {
            setThemeColor(result.color);
          }
        } catch (error) {
          console.error('获取主题色失败:', error);
        }
      }
    };

    fetchThemeColor();

    // 监听主题色变更
    if (typeof window !== 'undefined' && window.electronAPI) {
      const handleThemeColorChanged = (eventOrColor: unknown, maybeColor?: unknown) => {
        const color = normalizeThemeColorPayload(maybeColor) || normalizeThemeColorPayload(eventOrColor);
        if (color) {
          setThemeColor(color);
        }
      };

      const removeListener = window.electronAPI.onThemeColorChanged?.(handleThemeColorChanged);
      const handleLocalThemeColorChanged = (event: Event) => {
        const color = normalizeThemeColorPayload(event);
        if (color) {
          setThemeColor(color);
        }
      };
      window.addEventListener('theme-color-updated', handleLocalThemeColorChanged);

      return () => {
        if (typeof removeListener === 'function') {
          removeListener();
        }
        window.removeEventListener('theme-color-updated', handleLocalThemeColorChanged);
      };
    }
  }, []);

  return themeColor;
};

