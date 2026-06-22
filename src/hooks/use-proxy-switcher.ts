import { useState } from 'react';
import { mihomoClient } from '@/services/mihomo-client';

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
        await mihomoClient.closeAllConnections();
      } catch {
        // Non-fatal; proceed even if closing connections fails
      }

      await mihomoClient.selectNodeForGroup(groupName, nodeName);

      {
        // Allow the core to settle before verifying
        await new Promise(resolve => setTimeout(resolve, 200));

        const verifyData: any = await mihomoClient.getProxyByName(groupName);

        if (verifyData?.now !== nodeName) {
          throw new Error(`Node switch verification failed: expected "${nodeName}", got "${verifyData.now ?? 'unknown'}"`);
        }

        return true;
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
      const data = await mihomoClient.delayProxyByName(nodeName, testUrl, timeout);
      return data.delay;
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
