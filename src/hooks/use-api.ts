import { useState } from 'react';

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
   * 发送请求到mihomo API
   * 首先尝试使用electronAPI.requestMihomoAPI
   * 如果electronAPI不可用，则使用备用的fetch方法
   */
  const request = async <T = any>(
    endpoint: string,
    options: RequestInit = {},
    apiOptions?: ApiOptions
  ): Promise<{ data: T | null; success: boolean; status?: number }> => {
    setIsLoading(true);
    setError(null);

    try {
      // 尝试使用electronAPI
      if (window.electronAPI?.requestMihomoAPI) {
        const response = await window.electronAPI.requestMihomoAPI(endpoint, options);
        const data = response.ok ? await response.json() : null;
        
        setIsLoading(false);
        
        if (!response.ok) {
          const errorText = await response.text().catch(() => '未知错误');
          setError(`API请求失败: ${response.status} ${response.statusText} - ${errorText}`);
          return { data: null, success: false, status: response.status };
        }
        
        return { data, success: true, status: response.status };
      } 
      
      // 备用方法：直接使用fetch
      console.warn('electronAPI不可用，使用备用fetch方法');
      
      // 使用提供的API选项或获取默认值
      const host = apiOptions?.host || '127.0.0.1';
      const port = apiOptions?.port || '9090';
      const secret = apiOptions?.secret || '';
      
      // 构建完整URL
      const url = endpoint.startsWith('http') 
        ? endpoint 
        : `http://${host}:${port}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
      
      // 准备请求头
      const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
      
      // 如果有密钥，添加认证头
      if (secret) {
        headers['Authorization'] = `Bearer ${secret}`;
      }
      
      // 发送请求
      const response = await fetch(url, {
        ...options,
        headers
      });
      
      const data = response.ok ? await response.json() : null;
      
      setIsLoading(false);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => '未知错误');
        setError(`API请求失败: ${response.status} ${response.statusText} - ${errorText}`);
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