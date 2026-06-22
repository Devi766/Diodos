export type IpInfoSource = 'proxy' | 'direct' | 'browser';

export interface IpInfo {
  ip: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  isp?: string;
  org?: string;
  asn?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  isLocal?: boolean;
  source?: IpInfoSource;
}

type ServiceConfig = {
  getUrl: (preferredIp?: string) => string;
  parser: (data: any) => Partial<IpInfo> | null;
  skipBrowser?: boolean;
};

const USER_AGENT = 'FlyClash/1.0';
const DEFAULT_TIMEOUT = 8_000;

const services: ServiceConfig[] = [
  {
    getUrl: () => 'https://api.ipify.org?format=json',
    parser: (data: any) => {
      if (!data?.ip) return null;
      return { ip: data.ip };
    },
  },
  {
    getUrl: (ip) => (ip ? `https://ipwho.is/${ip}` : 'https://ipwho.is/'),
    skipBrowser: true,
    parser: (data: any) => {
      if (!data?.success) return null;
      return {
        ip: data.ip,
        country: data.country,
        countryCode: data.country_code,
        region: data.region,
        city: data.city,
        isp: data.connection?.isp || data.connection?.org,
        org: data.connection?.org,
        asn: data.connection?.asn ? `AS${data.connection.asn}` : undefined,
        timezone: data.timezone?.id,
        latitude: data.latitude,
        longitude: data.longitude,
      };
    },
  },
  {
    getUrl: () => 'https://api.ip.sb/geoip',
    parser: (data: any) => ({
      ip: data?.ip,
      country: data?.country,
      countryCode: data?.country_code,
      region: data?.region,
      city: data?.city,
      isp: data?.isp || data?.organization || data?.org,
      org: data?.organization || data?.org,
      asn: data?.asn ? `AS${data.asn}` : undefined,
      timezone: data?.timezone,
      latitude: data?.latitude,
      longitude: data?.longitude,
    }),
  },
  {
    getUrl: (ip) => (ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/'),
    parser: (data: any) => {
      if (data?.error) return null;
      return {
        ip: data?.ip,
        country: data?.country_name,
        countryCode: data?.country_code,
        region: data?.region,
        city: data?.city,
        isp: data?.org,
        org: data?.org,
        asn: data?.asn,
        timezone: data?.timezone,
        latitude: data?.latitude,
        longitude: data?.longitude,
      };
    },
  },
];

const parseData = (data: any) => {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

const responseError = (response: any, fallback: string) => {
  const data = response?.data;
  return (
    response?.error ||
    response?.statusText ||
    (typeof data === 'string' ? data : data?.message || data?.error) ||
    fallback
  );
};

const fetchJson = async (url: string, source: IpInfoSource) => {
  const headers = { 'User-Agent': USER_AGENT };
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  if (source === 'proxy' && typeof api?.fetchWithProxy === 'function') {
    const response = await api.fetchWithProxy({
      url,
      method: 'GET',
      headers,
      timeout: DEFAULT_TIMEOUT,
    });
    if (!response?.ok) {
      throw new Error(responseError(response, 'Proxy IP request failed'));
    }
    return parseData(response.data);
  }

  if (source === 'direct' && typeof api?.proxyFetch === 'function') {
    const response = await api.proxyFetch(url, {
      method: 'GET',
      headers,
      timeout: DEFAULT_TIMEOUT,
    });
    if (!response?.ok) {
      throw new Error(responseError(response, 'Direct IP request failed'));
    }
    return parseData(response.data);
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(response.statusText || 'Browser IP request failed');
  }
  return response.json();
};

const hasDisplayInfo = (info: Partial<IpInfo>) =>
  Boolean(info.isp || info.country || info.region || info.city);

const mergeInfo = (target: Partial<IpInfo>, source: Partial<IpInfo>) => {
  for (const [key, value] of Object.entries(source) as Array<[keyof IpInfo, IpInfo[keyof IpInfo]]>) {
    if (value !== undefined && value !== null && value !== '') {
      (target as Record<keyof IpInfo, IpInfo[keyof IpInfo]>)[key] = value;
    }
  }
};

const readIpWithSource = async (source: IpInfoSource): Promise<IpInfo> => {
  let aggregatedInfo: Partial<IpInfo> = {};
  let preferredIp: string | undefined;

  for (const service of services) {
    if (source === 'browser' && service.skipBrowser) {
      continue;
    }

    try {
      const data = await fetchJson(service.getUrl(preferredIp), source);
      const parsedInfo = service.parser(data);
      if (!parsedInfo) continue;

      if (parsedInfo.ip) {
        preferredIp = parsedInfo.ip.trim();
      }

      mergeInfo(aggregatedInfo, parsedInfo);
      if (preferredIp) {
        aggregatedInfo.ip = preferredIp;
      }

      if (aggregatedInfo.ip && hasDisplayInfo(aggregatedInfo)) {
        break;
      }
    } catch {
      continue;
    }
  }

  const ip = preferredIp ?? aggregatedInfo.ip;
  if (!ip) {
    throw new Error('All IP services failed');
  }

  return {
    ...aggregatedInfo,
    ip,
    source,
  };
};

export const fetchIpInfo = async (): Promise<IpInfo> => {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const sources: IpInfoSource[] = [];

  if (typeof api?.fetchWithProxy === 'function') {
    sources.push('proxy');
  }
  if (typeof api?.proxyFetch === 'function') {
    sources.push('direct');
  }
  sources.push('browser');

  let lastError: unknown;
  for (const source of sources) {
    try {
      return await readIpWithSource(source);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All IP services failed');
};
