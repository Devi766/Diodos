import { uiText } from '@/i18n/ui-text';
/** Subscription URLs often contain credentials in their path as well as query. */
export function sanitizeSubscriptionMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { return `${new URL(raw).origin}/…`; }
    catch { return uiText('[订阅链接]'); }
  });
}

export function subscriptionErrorMessage(error: unknown, fallback = uiText("操作失败")): string {
  const message = error instanceof Error ? error.message
    : typeof error === 'string' ? error
    : error && typeof error === 'object' ? String((error as { error?: unknown; message?: unknown }).error ?? (error as { message?: unknown }).message ?? fallback)
    : fallback;
  if (message.includes('Tauri runtime is not available')) return uiText("订阅 API 不可用");
  if (/ECONNRESET|socket hang up/i.test(message)) return uiText("订阅连接被中断或重置（ECONNRESET），请检查网络或代理后重试");
  return sanitizeSubscriptionMessage(message);
}
