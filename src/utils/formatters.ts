/**
 * 格式化字节大小为可读的格式
 * @param bytes 字节数
 * @returns 人类可读的大小字符串，如 1.2 MB
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  // 保留两位小数，去除末尾的0
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 格式化时间间隔为可读的格式
 * @param ms 毫秒时间
 * @returns 人类可读的时间字符串，如 2小时 30分钟
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '刚刚';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}天 ${hours % 24}小时`;
  } else if (hours > 0) {
    return `${hours}小时 ${minutes % 60}分钟`;
  } else if (minutes > 0) {
    return `${minutes}分钟 ${seconds % 60}秒`;
  } else {
    return `${seconds}秒`;
  }
} 