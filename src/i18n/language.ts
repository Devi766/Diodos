export const DEFAULT_LANGUAGE = 'en-US';

/** Lightweight locale access for shared formatters without loading translation catalogs. */
export function getDocumentLocale(): string {
  return typeof document === 'undefined'
    ? DEFAULT_LANGUAGE
    : normalizeLanguage(document.documentElement.lang) || DEFAULT_LANGUAGE;
}

export function normalizeLanguage(value: string | null | undefined): 'en-US' | 'zh-CN' | undefined {
  if (value && /^en(?:[-_]|$)/i.test(value)) return 'en-US';
  if (value && /^zh(?:[-_]|$)/i.test(value)) return 'zh-CN';
  return undefined;
}

export function getInitialLanguage(storage?: Pick<Storage, 'getItem'>): string {
  try {
    return normalizeLanguage(storage?.getItem('language'))
      ?? normalizeLanguage(storage?.getItem('i18nextLng'))
      ?? DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}
