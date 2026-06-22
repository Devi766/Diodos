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

  document.body.classList.remove(...PLATFORM_BODY_CLASSES);

  if (platform === 'win32') {
    document.body.classList.add('platform-windows');
  } else if (platform === 'darwin') {
    document.body.classList.add('platform-darwin');
  } else if (platform === 'linux') {
    document.body.classList.add('platform-linux');
  }

  document.body.dataset.platform = platform;
};

