const { app } = require('electron');
const fs = require('fs');
const path = require('path');

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

