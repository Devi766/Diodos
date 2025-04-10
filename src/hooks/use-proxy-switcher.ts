import { useState } from 'react';

/**
 * 节点切换钩子
 * 用于处理节点切换相关的逻辑
 */
export const useProxySwitcher = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 切换节点
   * @param nodeName 节点名称
   * @param groupName 分组名称，默认为GLOBAL
   */
  const switchNode = async (nodeName: string, groupName: string = 'GLOBAL') => {
    setIsLoading(true);
    setError(null);
    
    console.log(`[DEBUG] ====== 开始切换节点 ======`);
    console.log(`[DEBUG] 目标节点: ${nodeName}`);
    console.log(`[DEBUG] 目标组: ${groupName}`);
    
    try {
      // 直接使用Mihomo RESTful API
      // 1. 关闭现有连接以避免冲突
      try {
        console.log('[DEBUG] 步骤1: 尝试关闭所有现有连接...');
        const closeResponse = await fetch('http://127.0.0.1:9090/connections', {
          method: 'DELETE'
        });
        console.log(`[DEBUG] 关闭连接响应: ${closeResponse.status} ${closeResponse.statusText}`);
      } catch (err) {
        console.warn('[DEBUG] 关闭连接失败，继续执行:', err);
      }
      
      // 2. 切换节点
      const requestBody = { name: nodeName };
      console.log(`[DEBUG] 步骤2: 发送切换节点请求`);
      console.log(`[DEBUG] 请求URL: http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`);
      console.log(`[DEBUG] 请求方法: PUT`);
      console.log(`[DEBUG] 请求体: ${JSON.stringify(requestBody)}`);
      
      const response = await fetch(`http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      console.log(`[DEBUG] 切换节点响应状态: ${response.status} ${response.statusText}`);
      
      if (response.status === 204 || response.ok) {
        // 3. 验证节点是否切换成功
        console.log('[DEBUG] 步骤3: 等待200ms后验证节点是否切换成功');
        await new Promise(resolve => setTimeout(resolve, 200));
        
        console.log(`[DEBUG] 验证请求: GET /proxies/${encodeURIComponent(groupName)}`);
        const verifyResponse = await fetch(`http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`);
        const verifyData = await verifyResponse.json();
        
        console.log(`[DEBUG] 验证结果: 当前选中的节点是 ${verifyData.now}`);
        
        if (verifyData.now !== nodeName) {
          throw new Error(`节点切换验证失败: 期望 ${nodeName}, 实际 ${verifyData.now || '未知'}`);
        }
        
        // 不再通知主进程节点已变更，避免引起界面闪烁
        console.log(`[DEBUG] ====== 节点切换成功 ======`);
        return true;
      } else {
        let errorMessage = '节点切换失败';
        try {
          const errorData = await response.json();
          console.log(`[DEBUG] 错误响应内容:`, errorData);
          if (errorData && errorData.message) {
            errorMessage = errorData.message;
          }
        } catch (e) {
          // 如果JSON解析失败，使用HTTP状态作为错误信息
          errorMessage = `节点切换失败: ${response.status} ${response.statusText}`;
        }
        
        console.error(`[DEBUG] ====== 节点切换失败 ======`);
        console.error(`[DEBUG] 错误信息: ${errorMessage}`);
        setError(errorMessage);
        return false;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '节点切换失败';
      console.error(`[DEBUG] ====== 节点切换出错 ======`);
      console.error(`[DEBUG] 错误信息: ${errorMessage}`);
      console.error(`[DEBUG] 错误详情:`, err);
      setError(errorMessage);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 测试节点延迟
   * @param nodeName 节点名称
   * @param testUrl 测试URL，默认为Google的测试页面
   * @param timeout 超时时间，默认5000毫秒
   */
  const testNodeDelay = async (
    nodeName: string, 
    testUrl: string = 'http://www.gstatic.com/generate_204', 
    timeout: number = 5000
  ) => {
    try {
      console.log(`[DEBUG] 开始测试节点延迟: ${nodeName}`);
      console.log(`[DEBUG] 测试URL: ${testUrl}, 超时: ${timeout}ms`);
      
      // 使用Mihomo API进行测试
      const url = `http://127.0.0.1:9090/proxies/${encodeURIComponent(nodeName)}/delay?url=${encodeURIComponent(testUrl)}&timeout=${timeout}`;
      
      console.log(`[DEBUG] 发送延迟测试请求: GET ${url}`);
      const response = await fetch(url);
      
      console.log(`[DEBUG] 延迟测试响应: ${response.status} ${response.statusText}`);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`[DEBUG] 节点 ${nodeName} 延迟测试结果: ${data.delay}ms`);
        return data.delay;
      } else {
        try {
          const errorData = await response.text();
          console.error(`[DEBUG] 测试节点延迟失败: ${response.status} ${response.statusText}, 错误内容: ${errorData}`);
        } catch (e) {
          console.error(`[DEBUG] 测试节点延迟失败: ${response.status} ${response.statusText}`);
        }
        return -1;
      }
    } catch (err) {
      console.error('[DEBUG] 测试节点延迟出错:', err);
      return -1; // 返回-1表示测试失败
    }
  };

  return {
    switchNode,
    testNodeDelay,
    isLoading,
    error,
  };
}; 