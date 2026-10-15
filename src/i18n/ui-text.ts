import i18n from './index';

export function getUiLocale(): string {
  return i18n.resolvedLanguage || i18n.language || 'en-US';
}

/** Source-keyed messages for legacy UI code. Never translate user data or API identifiers. */
export function uiText(source: string, values: Record<string, unknown> = {}): string {
  const locale = getUiLocale();
  const catalog = i18n.getResource(locale, 'translation', 'uiMessages') as Record<string, string> | undefined;
  const fallback = i18n.getResource('en-US', 'translation', 'uiMessages') as Record<string, string> | undefined;
  const lookup = (messages: Record<string, string> | undefined) =>
    messages && Object.prototype.hasOwnProperty.call(messages, source) ? messages[source] : undefined;
  const message = lookup(catalog) ?? lookup(fallback) ?? source;
  // A single pass keeps braces in filenames, URLs, and error messages literal.
  return message.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match);
}
