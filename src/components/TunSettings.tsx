import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import * as Toast from '@radix-ui/react-toast';
import { Cross2Icon } from '@radix-ui/react-icons';

interface TunConfig {
  device: string;
  stack: 'gvisor' | 'mixed' | 'system';
  autoRoute: boolean;
  autoRedirect: boolean;
  autoDetectInterface: boolean;
  dnsHijack: string[];
  strictRoute: boolean;
  routeExcludeAddress: string[];
  mtu: number;
  autoSetDNS?: boolean;
}

const TunSettings: React.FC = () => {
  const [config, setConfig] = useState<TunConfig>({
    device: process.platform === 'darwin' ? 'utun1500' : 'Mihomo',
    stack: 'mixed',
    autoRoute: true,
    autoRedirect: false,
    autoDetectInterface: true,
    dnsHijack: ['any:53'],
    strictRoute: false,
    routeExcludeAddress: [],
    mtu: 1500,
    autoSetDNS: process.platform === 'darwin',
  });
  const [loading, setLoading] = useState(false);
  const [changed, setChanged] = useState(false);

  // Toast 状态
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');

  useEffect(() => {
    loadConfig();
  }, []);

  const showToast = (title: string, description: string, type: 'success' | 'error') => {
    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(true);
  };

  const loadConfig = async () => {
    if (!window.electronAPI) return;

    try {
      const result = await window.electronAPI.getTunConfig();
      if (result.success && result.config) {
        setConfig(result.config);
      }
    } catch (error) {
      console.error('加载 TUN 配置失败:', error);
    }
  };

  const handleSave = async () => {
    if (!window.electronAPI) return;

    setLoading(true);
    try {
      const result = await window.electronAPI.saveTunConfig(config);
      if (result.success) {
        showToast('成功', 'TUN 配置已保存，重启服务后生效', 'success');
        setChanged(false);
      } else {
        showToast('错误', result.error || '未知错误', 'error');
      }
    } catch (error) {
      showToast('错误', String(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGrantPermissions = async () => {
    if (!window.electronAPI) return;

    setLoading(true);
    try {
      const result = await window.electronAPI.grantTunPermissions();
      if (result.success) {
        showToast('成功', result.message || 'TUN 模式权限已成功授予', 'success');
      } else {
        showToast('错误', result.error || '未知错误', 'error');
      }
    } catch (error) {
      showToast('错误', String(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = (updates: Partial<TunConfig>) => {
    setConfig({ ...config, ...updates });
    setChanged(true);
  };

  const handleExcludeAddressChange = (index: number, value: string) => {
    const newAddresses = [...config.routeExcludeAddress];
    if (value.trim() === '') {
      newAddresses.splice(index, 1);
    } else {
      newAddresses[index] = value;
    }
    updateConfig({ routeExcludeAddress: newAddresses });
  };

  const handleAddExcludeAddress = () => {
    updateConfig({
      routeExcludeAddress: [...config.routeExcludeAddress, ''],
    });
  };

  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const isWindows = process.platform === 'win32';

  return (
    <Toast.Provider swipeDirection="right">
      <div className="space-y-6">
        {/* 权限设置 */}
        {!isWindows && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
              TUN 模式权限
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
              {isMac && '在 macOS 上，TUN 模式需要授予内核 root 权限。点击下方按钮并输入管理员密码。'}
              {isLinux && '在 Linux 上，TUN 模式需要授予内核 root 权限。'}
            </p>
            <button
              className="py-1.5 px-3 text-sm rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleGrantPermissions}
              disabled={loading}
            >
              授予 TUN 模式权限
            </button>
          </div>
        )}

        {isWindows && (
          <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-xs text-yellow-800 dark:text-yellow-200">
              Windows 平台需要以管理员身份运行应用才能使用 TUN 模式
            </p>
          </div>
        )}

        {/* macOS DNS 设置 */}
        {isMac && (
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">自动设置 DNS</h3>
              <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">
                macOS 需要自动设置 DNS 以确保 TUN 模式正常工作
              </p>
            </div>
            <Switch
              checked={config.autoSetDNS}
              onCheckedChange={(checked) => updateConfig({ autoSetDNS: checked })}
            />
          </div>
        )}

        {/* 网络栈 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">网络栈</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            选择 TUN 模式使用的网络栈实现，推荐使用 Mixed 以获得最佳兼容性
          </p>
          <div className="flex gap-2">
            <button
              className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                config.stack === 'gvisor'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
              }`}
              onClick={() => updateConfig({ stack: 'gvisor' })}
            >
              gVisor
            </button>
            <button
              className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                config.stack === 'mixed'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
              }`}
              onClick={() => updateConfig({ stack: 'mixed' })}
            >
              Mixed（推荐）
            </button>
            <button
              className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                config.stack === 'system'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
              }`}
              onClick={() => updateConfig({ stack: 'system' })}
            >
              System
            </button>
          </div>
        </div>

        {/* 设备名称 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">设备名称</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            虚拟网卡的设备名称
          </p>
          <input
            type="text"
            className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={config.device}
            placeholder={isMac ? 'utun1500' : 'Mihomo'}
            onChange={(e) => updateConfig({ device: e.target.value })}
          />
        </div>

        {/* MTU */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">MTU</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            最大传输单元大小，默认 1500
          </p>
          <input
            type="number"
            className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={config.mtu}
            onChange={(e) => updateConfig({ mtu: parseInt(e.target.value) || 1500 })}
          />
        </div>

        {/* DNS 劫持 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">DNS 劫持</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            劫持的 DNS 地址，多个地址使用逗号分隔
          </p>
          <input
            type="text"
            className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={config.dnsHijack.join(', ')}
            placeholder="any:53"
            onChange={(e) =>
              updateConfig({
                dnsHijack: e.target.value.split(',').map((s) => s.trim()).filter(s => s),
              })
            }
          />
        </div>

        {/* 路由选项 */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">严格路由</h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">启用严格的路由规则</p>
          </div>
          <Switch
            checked={config.strictRoute}
            onCheckedChange={(checked) => updateConfig({ strictRoute: checked })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">自动路由</h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">自动配置系统路由表</p>
          </div>
          <Switch
            checked={config.autoRoute}
            onCheckedChange={(checked) => updateConfig({ autoRoute: checked })}
          />
        </div>

        {isLinux && (
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">自动重定向</h3>
              <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">
                自动重定向流量到 TUN（仅 Linux）
              </p>
            </div>
            <Switch
              checked={config.autoRedirect}
              onCheckedChange={(checked) => updateConfig({ autoRedirect: checked })}
            />
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">自动检测网卡</h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">自动检测默认网络接口</p>
          </div>
          <Switch
            checked={config.autoDetectInterface}
            onCheckedChange={(checked) => updateConfig({ autoDetectInterface: checked })}
          />
        </div>

        {/* 排除地址 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">排除地址</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            这些地址将不会通过 TUN 模式路由
          </p>
          <div className="space-y-2">
            {config.routeExcludeAddress.map((address, index) => (
              <div key={index} className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                  value={address}
                  placeholder="例如: 192.168.0.0/16"
                  onChange={(e) => handleExcludeAddressChange(index, e.target.value)}
                />
                <button
                  className="py-1.5 px-3 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:text-gray-200 dark:hover:bg-[#333333] transition-colors"
                  onClick={() => handleExcludeAddressChange(index, '')}
                >
                  删除
                </button>
              </div>
            ))}
            <button
              className="w-full py-1.5 px-3 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:text-gray-200 dark:hover:bg-[#333333] transition-colors"
              onClick={handleAddExcludeAddress}
            >
              + 添加排除地址
            </button>
          </div>
        </div>

        {/* 保存按钮 */}
        {changed && (
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              className="py-2 px-4 text-sm rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleSave}
              disabled={loading}
            >
              {loading ? '保存中...' : '保存配置'}
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              配置修改后需要重启服务才能生效
            </p>
          </div>
        )}
      </div>

      <Toast.Root
        open={toastOpen}
        onOpenChange={setToastOpen}
        className={`fixed bottom-4 right-4 p-4 rounded-md shadow-md ${
          toastType === 'success'
            ? 'bg-green-500 text-white'
            : 'bg-red-500 text-white'
        }`}
      >
        <Toast.Title className="font-medium">{toastTitle}</Toast.Title>
        <Toast.Description>{toastDescription}</Toast.Description>
        <Toast.Close asChild>
          <button
            className="absolute top-2 right-2 text-white"
            aria-label="Close"
          >
            <Cross2Icon />
          </button>
        </Toast.Close>
      </Toast.Root>

      <Toast.Viewport />
    </Toast.Provider>
  );
};

export default TunSettings;
