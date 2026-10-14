import { useEffect, useState } from 'react';

const readIsDark = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

// 跟随根节点上的 dark 类名，供 canvas 等无法使用 dark: 样式的场景取色
export function useIsDarkMode() {
  const [isDark, setIsDark] = useState(readIsDark);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(readIsDark()));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    setIsDark(readIsDark());
    return () => observer.disconnect();
  }, []);

  return isDark;
}
