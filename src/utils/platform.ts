export type RuntimePlatform = 'win32' | 'darwin' | 'linux' | 'unknown';

export const PLATFORM_BODY_CLASSES = [
  'platform-windows',
  'platform-darwin',
  'platform-linux',
] as const;

export const normalizeRuntimePlatform = (value: unknown): RuntimePlatform => {
  if (typeof value !== 'string') return 'unknown';

  const platform = value.toLowerCase();
  if (platform.includes('win')) return 'win32';
  if (platform.includes('darwin') || platform.includes('mac')) return 'darwin';
  if (platform.includes('linux')) return 'linux';

  return 'unknown';
};

export const getBrowserPlatform = (): RuntimePlatform => {
  if (typeof navigator === 'undefined') return 'unknown';

  const navWithUAData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = normalizeRuntimePlatform(
    `${navWithUAData.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`
  );

  return platform;
};

export const getRuntimePlatform = async (): Promise<RuntimePlatform> => {
  if (typeof window !== 'undefined') {
    try {
      const apiPlatform = await window.electronAPI?.getPlatform?.();
      const normalized = normalizeRuntimePlatform(apiPlatform);
      if (normalized !== 'unknown') return normalized;
    } catch (error) {
      console.warn('[Platform] Failed to query runtime platform:', error);
    }
  }

  return getBrowserPlatform();
};

export const applyPlatformBodyClass = (platform: RuntimePlatform) => {
  if (typeof document === 'undefined') return;

  const roots = [document.documentElement, document.body].filter(Boolean);
  for (const root of roots) {
    root.classList.remove(...PLATFORM_BODY_CLASSES);
  }

  let platformClass: (typeof PLATFORM_BODY_CLASSES)[number] | null = null;
  if (platform === 'win32') {
    platformClass = 'platform-windows';
  } else if (platform === 'darwin') {
    platformClass = 'platform-darwin';
  } else if (platform === 'linux') {
    platformClass = 'platform-linux';
  }

  if (platformClass) {
    for (const root of roots) {
      root.classList.add(platformClass);
    }
  }

  document.body.dataset.platform = platform;
  document.documentElement.dataset.platform = platform;
};

