import { useState } from 'react';
import { mihomoClient } from '@/services/mihomo-client';

interface ApiOptions {
  host?: string;
  port?: string;
  secret?: string;
}

/**
 * 统一API请求钩子
 * 提供给前端组件使用，自动处理密钥和错误
 */
export const useMihomoApiRequest = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 发送请求到 mihomo API。内部固定走 Tauri mihomo IPC 插件。
   */
  const request = async <T = any>(
    endpoint: string,
    options: RequestInit = {},
    apiOptions?: ApiOptions
  ): Promise<{ data: T | null; success: boolean; status?: number }> => {
    setIsLoading(true);
    setError(null);

    try {
      void apiOptions;
      const response = await mihomoClient.request<T>(endpoint, options);
      const data = response.ok ? response.data : null;
      setIsLoading(false);

      if (!response.ok) {
        setError(`API请求失败: ${response.status} ${response.statusText} - ${response.text}`);
        return { data: null, success: false, status: response.status };
      }

      return { data, success: true, status: response.status };
    } catch (err) {
      setIsLoading(false);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`API请求出错: ${errorMessage}`);
      return { data: null, success: false };
    }
  };

  return {
    request,
    isLoading,
    error,
    clearError: () => setError(null)
  };
};
