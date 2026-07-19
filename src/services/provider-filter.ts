export type ProviderConfigKey = 'proxyProviders' | 'ruleProviders';

export const providerMap = (result: any) => {
  return result?.data?.providers ?? result?.providers ?? result?.data?.data?.providers;
};

export const configuredProviderNamesFromConfigOrder = (
  result: any,
  key: ProviderConfigKey,
): Set<string> | null => {
  const raw = result?.data?.[key] ?? result?.[key] ?? result?.data?.data?.[key];
  if (!Array.isArray(raw)) return null;

  return new Set(
    raw
      .map((name) => (typeof name === 'string' ? name.trim() : ''))
      .filter((name) => name.length > 0),
  );
};

export const getConfiguredProviderNames = async (
  key: ProviderConfigKey,
): Promise<Set<string> | null> => {
  if (typeof window === 'undefined') return null;
  const api = window.electronAPI as any;
  if (typeof api?.getConfigOrder !== 'function') return null;

  try {
    const result = await api.getConfigOrder();
    if (result?.success === false) return null;
    return configuredProviderNamesFromConfigOrder(result, key);
  } catch (error) {
    console.debug(`[ProviderFilter] Failed to read ${key} from config order`, error);
    return null;
  }
};

const groupLikeTypes = new Set([
  'select',
  'selector',
  'urltest',
  'url-test',
  'fallback',
  'loadbalance',
  'load-balance',
  'relay',
  'smart',
  'compatible',
  'direct',
  'reject',
  'pass',
]);

const normalizedText = (value: unknown): string => {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

const isProviderVehicleType = (value: unknown): boolean => {
  const vehicleType = normalizedText(value);
  return vehicleType === 'http' || vehicleType === 'file';
};

const providerName = (mapKey: string, provider: any): string => {
  return typeof provider?.name === 'string' && provider.name.trim()
    ? provider.name.trim()
    : mapKey;
};

const isLikelyProviderWhenConfigUnavailable = (
  provider: any,
  key: ProviderConfigKey,
): boolean => {
  const type = normalizedText(provider?.type);
  const vehicleType = normalizedText(provider?.vehicleType ?? provider?.vehicle_type);

  if (vehicleType) {
    return isProviderVehicleType(vehicleType);
  }

  if (groupLikeTypes.has(type) || groupLikeTypes.has(vehicleType)) {
    return false;
  }

  if (key === 'ruleProviders') {
    return (
      typeof provider?.ruleCount === 'number' ||
      typeof provider?.behavior === 'string' ||
      typeof provider?.format === 'string'
    );
  }

  return true;
};

export const filterProviderRecord = (
  providersRecord: Record<string, any>,
  key: ProviderConfigKey,
  configuredNames: Set<string> | null,
): Record<string, any> => {
  return Object.fromEntries(
    Object.entries(providersRecord).filter(([mapKey, provider]) => {
      const name = providerName(mapKey, provider);
      if (configuredNames) {
        return configuredNames.has(mapKey) || configuredNames.has(name);
      }

      return isLikelyProviderWhenConfigUnavailable(provider, key);
    }),
  );
};
