const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * 在 macOS 上查找最佳的 .app 路径
 * @param {string} processPath - 进程可执行文件路径
 * @returns {string|null} 返回 .app 路径或 null
 */
function findBestAppPath(processPath) {
  if (!processPath.includes('.app')) {
    return null;
  }

  const parts = processPath.split(path.sep);
  const appPaths = [];

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('.app')) {
      const fullPath = parts.slice(0, i + 1).join(path.sep);
      appPaths.push(fullPath);
    }
  }

  if (appPaths.length === 0) {
    return null;
  }

  // 返回最外层的 .app 路径
  return appPaths[0];
}

/**
 * 获取进程图标的 Data URL
 * @param {string} processPath - 进程可执行文件路径
 * @returns {Promise<string>} 返回图标的 Data URL (base64)
 */
async function getIconDataURL(processPath) {
  if (!processPath) {
    return '';
  }

  // 处理 mihomo 内部连接
  if (processPath === 'mihomo') {
    processPath = app.getPath('exe');
  }

  // macOS 特殊处理：如果路径包含 .app，提取 .app 路径
  if (process.platform === 'darwin') {
    const appPath = findBestAppPath(processPath);
    if (appPath) {
      processPath = appPath;
    } else if (!processPath.endsWith('.app')) {
      // 如果不是 .app 路径，返回空字符串避免崩溃
      console.warn(`[macOS] 跳过非应用程序路径: ${processPath}`);
      return '';
    }
  }

  // 检查文件是否存在
  if (!fs.existsSync(processPath)) {
    console.warn(`图标提取失败：文件不存在 - ${processPath}`);
    return '';
  }

  try {
    // 使用 Electron 内置 API 获取文件图标
    // size 选项: 'small' (16x16), 'normal' (32x32), 'large' (48x48 on Windows, 128x128 on macOS)
    const icon = await app.getFileIcon(processPath, { size: 'large' });

    // 将 NativeImage 转换为 Data URL
    const dataURL = icon.toDataURL();

    return dataURL;
  } catch (error) {
    console.error(`获取图标失败 (${processPath}):`, error.message);
    return '';
  }
}

module.exports = {
  getIconDataURL
};

