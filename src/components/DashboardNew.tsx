import React, { useState, useEffect } from 'react';
import {
  PlayIcon,
  StopIcon,
  ReloadIcon,
  DownloadIcon,
  UploadIcon,
  ClockIcon,
  GlobeIcon,
  ActivityLogIcon,
  BarChartIcon
} from '@radix-ui/react-icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export default function DashboardNew() {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [tunEnabled, setTunEnabled] = useState(false);
  const [connectionCount, setConnectionCount] = useState(73);
  const [upSpeed, setUpSpeed] = useState(10);
  const [downSpeed, setDownSpeed] = useState(131);
  const [latency, setLatency] = useState(9);
  const [currentNode, setCurrentNode] = useState('Home');
  const [outboundMode, setOutboundMode] = useState('Rule-Based Proxy');
  const [externalIP, setExternalIP] = useState('203.0.113.1');

  // Format bytes to human readable
  const formatBytes = (bytes: number, decimals = 1) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-5">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Activity</h1>
          <p className="text-sm text-muted-foreground mt-1">Monitor your network activity in real-time</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/30">
            <div className="indicator-dot" />
            <span className="text-xs font-medium text-foreground">System Proxy</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/30">
            <div className="indicator-dot" />
            <span className="text-xs font-medium text-foreground">Enhanced Mode</span>
          </div>
        </div>
      </div>

      {/* Network Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="metric-card">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Network</div>
          <div className="text-xl font-bold text-foreground mb-1">{currentNode}</div>
          <div className="text-xs text-muted-foreground">Current Profile</div>
        </div>

        <div className="metric-card">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Profile</div>
          <div className="text-xl font-bold text-foreground mb-1">macOS</div>
          <div className="text-xs text-muted-foreground">Active Configuration</div>
        </div>

        <div className="metric-card">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Outbound Mode</div>
          <div className="text-base font-semibold text-foreground mb-1">{outboundMode}</div>
          <div className="text-xs text-muted-foreground">Routing Strategy</div>
        </div>

        <div className="metric-card">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">External IP</div>
          <div className="text-xl font-bold text-foreground mb-1 font-mono">{externalIP}</div>
          <div className="text-xs text-muted-foreground">Public Address</div>
        </div>
      </div>

      {/* Latency and Speed Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Latency Card */}
        <div className="metric-card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <ClockIcon className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Internet Latency</h3>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold text-foreground metric-value">{latency}</span>
                <span className="text-lg text-muted-foreground">ms</span>
              </div>
            </div>
            <button className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent/50 text-accent-foreground hover:bg-accent transition-colors">
              Diagnostics
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-border/50">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Router</div>
              <div className="text-sm font-semibold text-foreground">≤1 <span className="text-xs text-muted-foreground">ms</span></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">DNS</div>
              <div className="text-sm font-semibold text-foreground">6 <span className="text-xs text-muted-foreground">ms</span></div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Proxy</div>
              <div className="text-sm font-semibold text-foreground">260 <span className="text-xs text-muted-foreground">ms</span></div>
            </div>
          </div>
        </div>

        {/* Speed Card */}
        <div className="metric-card">
          <div className="space-y-4">
            {/* Upload */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <UploadIcon className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Upload</span>
                </div>
                <span className="text-xs text-muted-foreground">2.0 MB/s</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-foreground metric-value">{upSpeed}</span>
                <span className="text-base text-muted-foreground">KB/s</span>
              </div>
            </div>

            {/* Download */}
            <div className="pt-4 border-t border-border/50">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <DownloadIcon className="w-4 h-4 text-cyan-500" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Download</span>
                </div>
                <span className="text-xs text-muted-foreground">9.2 MB/s</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-foreground metric-value">{downSpeed}</span>
                <span className="text-base text-muted-foreground">KB/s</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Active Connections and Traffic */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Active Connections */}
        <div className="metric-card">
          <div className="flex items-center gap-2 mb-3">
            <ActivityLogIcon className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Active Connection</h3>
          </div>
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-5xl font-bold text-foreground metric-value">{connectionCount}</span>
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse ml-2" />
          </div>

          <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-border/50">
            <div>
              <div className="text-2xl font-bold text-foreground">16</div>
              <div className="text-xs text-muted-foreground mt-1">Processes</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-foreground">0</div>
              <div className="text-xs text-muted-foreground mt-1">Devices</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-foreground">2</div>
              <div className="text-xs text-muted-foreground mt-1">DHCP Devices</div>
            </div>
          </div>
        </div>

        {/* Total Traffic */}
        <div className="metric-card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <BarChartIcon className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Traffic</h3>
            </div>
            <div className="flex gap-2">
              <button className={cn(
                "px-3 py-1 text-xs font-medium rounded-lg transition-colors",
                "bg-primary text-primary-foreground"
              )}>
                Today
              </button>
              <button className={cn(
                "px-3 py-1 text-xs font-medium rounded-lg transition-colors",
                "bg-accent/30 text-foreground hover:bg-accent/50"
              )}>
                Month
              </button>
            </div>
          </div>

          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-4xl font-bold text-foreground metric-value">729</span>
            <span className="text-lg text-muted-foreground">MB</span>
          </div>

          <div className="space-y-3 mt-4 pt-4 border-t border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-blue-500/20 border border-blue-500" />
                <span className="text-xs text-muted-foreground">Direct</span>
              </div>
              <span className="text-sm font-semibold text-foreground">178 <span className="text-xs text-muted-foreground">MB</span></span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-cyan-500/20 border border-cyan-500" />
                <span className="text-xs text-muted-foreground">Proxy</span>
              </div>
              <span className="text-sm font-semibold text-foreground">551 <span className="text-xs text-muted-foreground">MB</span></span>
            </div>
          </div>
        </div>
      </div>

      {/* Traffic by Client */}
      <div className="metric-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Traffic by Client</h3>
          <div className="flex gap-2">
            <button className="px-3 py-1 text-xs font-medium rounded-lg bg-primary text-primary-foreground">Client</button>
            <button className="px-3 py-1 text-xs font-medium rounded-lg bg-accent/30 text-foreground hover:bg-accent/50">Domain</button>
            <button className="px-3 py-1 text-xs font-medium rounded-lg bg-accent/30 text-foreground hover:bg-accent/50">Policy</button>
          </div>
        </div>

        <div className="space-y-3">
          {[
            { name: 'Arc', traffic: '211.9 MB', color: 'text-purple-500' },
            { name: 'Cursor', traffic: '170.6 MB', color: 'text-slate-700 dark:text-slate-300' },
            { name: 'Spark', traffic: '144.2 MB', color: 'text-blue-500' },
            { name: 'Dropbox', traffic: '40.6 MB', color: 'text-blue-600' },
            { name: 'Telegram', traffic: '34.2 MB', color: 'text-sky-500' }
          ].map((client, index) => (
            <div key={index} className="flex items-center justify-between p-3 rounded-lg bg-accent/20 hover:bg-accent/30 transition-colors">
              <div className="flex items-center gap-3">
                <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", client.color.replace('text-', 'bg-') + '/10')}>
                  <GlobeIcon className={cn("w-4 h-4", client.color)} />
                </div>
                <span className="text-sm font-medium text-foreground">{client.name}</span>
              </div>
              <span className="text-sm font-semibold text-foreground">{client.traffic}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
