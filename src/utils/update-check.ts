export const RELEASES_PAGE_URL = 'https://github.com/GtxFury/FlyClash/releases';

const RELEASE_API_ENDPOINTS = [
  'https://api.github.com/repos/GtxFury/FlyClash/releases/latest',
  'https://mirror.ghproxy.com/https://api.github.com/repos/GtxFury/FlyClash/releases/latest',
  'https://gh.api.99988866.xyz/https://api.github.com/repos/GtxFury/FlyClash/releases/latest'
];
export const UPDATE_AVAILABLE_EVENT = 'flyclash-update-available';

export interface ReleaseInfo {
  version: string;
  displayVersion: string;
  body: string;
  url: string;
  name?: string;
  publishedAt?: string;
}

export interface UpdateEventDetail {
  release: ReleaseInfo;
  currentVersion: string;
}

export const normalizeVersion = (value?: string | null) => {
  if (!value) return '0.0.0';
  const cleaned = value.trim().replace(/^v/i, '');
  const [main] = cleaned.split(/[-+]/);
  return main || '0.0.0';
};

export const compareVersions = (a?: string | null, b?: string | null) => {
  const aParts = normalizeVersion(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const bParts = normalizeVersion(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i += 1) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }

  return 0;
};

export interface ReleaseFetchResult {
  release: ReleaseInfo | null;
  error?: string;
  source?: string;
}

export const fetchLatestRelease = async (): Promise<ReleaseFetchResult> => {
  const errors: string[] = [];

  for (const endpoint of RELEASE_API_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/vnd.github+json',
        },
        cache: 'no-store',
      });

      if (!response.ok) {
        const errorMessage = `HTTP ${response.status}`;
        errors.push(`${endpoint}: ${errorMessage}`);
        continue;
      }

      const data = await response.json();
      const tagName = data?.tag_name || data?.name || '';
      const release: ReleaseInfo = {
        version: normalizeVersion(tagName || data?.tag_name || data?.name),
        displayVersion: tagName || data?.name || '',
        body: data?.body || '',
        url: data?.html_url || (tagName ? `${RELEASES_PAGE_URL}/tag/${tagName}` : RELEASES_PAGE_URL),
        name: data?.name || '',
        publishedAt: data?.published_at || '',
      };

      return { release, source: endpoint };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${endpoint}: ${message}`);
    }
  }

  return {
    release: null,
    error: errors.join(' | ') || 'Unknown error',
  };
};

export const emitUpdateAvailableEvent = (release: ReleaseInfo, currentVersion: string) => {
  if (typeof window === 'undefined') return;
  const detail: UpdateEventDetail = { release, currentVersion };
  const event = new CustomEvent<UpdateEventDetail>(UPDATE_AVAILABLE_EVENT, { detail });
  window.dispatchEvent(event);
};
