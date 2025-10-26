import { useState, useEffect } from 'react';

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
      const handleThemeColorChanged = (_event: any, color: string) => {
        setThemeColor(color);
      };

      const removeListener = window.electronAPI.onThemeColorChanged?.(handleThemeColorChanged);

      return () => {
        if (typeof removeListener === 'function') {
          removeListener();
        }
      };
    }
  }, []);

  return themeColor;
};

