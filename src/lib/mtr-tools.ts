import { createRouteTraceRunner, type RouteSnapshot } from './route-trace';

// 工具页和仪表盘使用独立会话，手动测试其他目标不会覆盖节点入口卡片
export const mtrToolRunner = createRouteTraceRunner();

export function normalizeMtrTarget(raw: string): string {
  const value = raw.trim().replace(/\.$/, '');
  if (!value || value.length > 253 || /[\s/@?#\\]/.test(value)) throw new Error('invalid_target');
  if (value.includes(':')) throw new Error(/^[0-9a-f:]+$/i.test(value) ? 'ipv6_only' : 'invalid_target');
  if (/^[\d.]+$/.test(value)) {
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value) || value.split('.').some(part => Number(part) > 255)) throw new Error('invalid_target');
    return value.split('.').map(Number).join('.');
  }
  let domain: string;
  try { domain = new URL(`https://${value}`).hostname; } catch { throw new Error('invalid_target'); }
  if (domain.split('.').some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) throw new Error('invalid_target');
  return domain.toLowerCase();
}

export function createMtrReport(snapshot: RouteSnapshot, labels: string[]): string {
  const rows = snapshot.hops.map(hop => [hop.ttl, hop.ip || '*', hop.sent, hop.received, `${Math.round(hop.loss)}%`,
    hop.avg?.toFixed(1) ?? '', hop.min?.toFixed(1) ?? '', hop.max?.toFixed(1) ?? '',
    [hop.geo?.country, hop.geo?.city, hop.geo?.isp].filter(Boolean).join(' / ')]);
  return [`MTR: ${snapshot.requestedTarget || snapshot.node || ''} (${snapshot.target || ''})`, labels.join('\t'),
    ...rows.map(row => row.map(value => String(value).replace(/[\t\r\n]/g, ' ')).join('\t'))].join('\n');
}
