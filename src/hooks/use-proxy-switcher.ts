import { useState } from 'react';

/**
 * Hook for handling proxy node switching operations.
 */
export const useProxySwitcher = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Switch the active proxy node within a group.
   * @param nodeName - Target node name
   * @param groupName - Proxy group name (defaults to GLOBAL)
   */
  const switchNode = async (nodeName: string, groupName: string = 'GLOBAL') => {
    setIsLoading(true);
    setError(null);

    try {
      // Close existing connections to avoid stale state
      try {
        await window.electronAPI!.requestMihomoAPI('/connections', { method: 'DELETE' });
      } catch {
        // Non-fatal; proceed even if closing connections fails
      }

      const response = await window.electronAPI!.requestMihomoAPI(`/proxies/${encodeURIComponent(groupName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nodeName })
      });

      if (response.status === 204 || response.ok) {
        // Allow the core to settle before verifying
        await new Promise(resolve => setTimeout(resolve, 200));

        const verifyResponse = await window.electronAPI!.requestMihomoAPI(`/proxies/${encodeURIComponent(groupName)}`);
        const verifyData = await verifyResponse.json();

        if (verifyData.now !== nodeName) {
          throw new Error(`Node switch verification failed: expected "${nodeName}", got "${verifyData.now ?? 'unknown'}"`);
        }

        return true;
      } else {
        let errorMessage = 'Failed to switch node';
        try {
          const errorData = await response.json();
          if (errorData?.message) {
            errorMessage = errorData.message;
          }
        } catch {
          errorMessage = `Failed to switch node: ${response.status} ${response.statusText}`;
        }

        setError(errorMessage);
        return false;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to switch node';
      console.error('[ProxySwitcher] Switch failed:', err);
      setError(errorMessage);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Test the latency of a proxy node.
   * @param nodeName - Node name to test
   * @param testUrl - URL to use for the latency test
   * @param timeout - Timeout in milliseconds
   * @returns Delay in ms, or -1 on failure
   */
  const testNodeDelay = async (
    nodeName: string,
    testUrl: string = 'http://www.gstatic.com/generate_204',
    timeout: number = 5000
  ) => {
    try {
      const urlPath = `/proxies/${encodeURIComponent(nodeName)}/delay?url=${encodeURIComponent(testUrl)}&timeout=${timeout}`;
      const response = await window.electronAPI!.requestMihomoAPI(urlPath);

      if (response.ok) {
        const data = await response.json();
        return data.delay;
      } else {
        return -1;
      }
    } catch {
      return -1;
    }
  };

  return {
    switchNode,
    testNodeDelay,
    isLoading,
    error,
  };
};
