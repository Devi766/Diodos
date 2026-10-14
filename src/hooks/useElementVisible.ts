import { RefObject, useEffect, useState } from 'react';

// 元素位于视口内且页面处于前台时返回 true，用于暂停不可见卡片的逐帧动画
export function useElementVisible(ref: RefObject<Element | null>) {
  const [inViewport, setInViewport] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setInViewport(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const handleChange = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handleChange);
    return () => document.removeEventListener('visibilitychange', handleChange);
  }, []);

  return inViewport && pageVisible;
}
