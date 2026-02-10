'use strict';

/**
 * Formatting utility functions
 * Provides human-readable formatting for traffic bytes and speed values.
 */

function formatTraffic(bytes) {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;

  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }

  return `${size.toFixed(2)} ${units[i]}`;
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === 0) return '0 B/s';

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let speed = bytesPerSecond;

  while (speed >= 1024 && i < units.length - 1) {
    speed /= 1024;
    i++;
  }

  return `${speed.toFixed(2)} ${units[i]}`;
}

module.exports = { formatTraffic, formatSpeed };
