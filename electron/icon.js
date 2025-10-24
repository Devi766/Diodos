const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

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
  console.log(`[getIconDataURL] 开始获取图标, 原始路径: ${processPath}`);

  if (!processPath) {
    console.log('[getIconDataURL] 路径为空,返回空字符串');
    return '';
  }

  // 处理 mihomo 内部连接
  if (processPath === 'mihomo') {
    processPath = app.getPath('exe');
    console.log(`[getIconDataURL] mihomo 路径转换为: ${processPath}`);
  }

  // macOS 特殊处理：如果路径包含 .app，提取 .app 路径
  if (process.platform === 'darwin') {
    console.log(`[macOS] 处理路径: ${processPath}`);
    const appPath = findBestAppPath(processPath);
    if (appPath) {
      console.log(`[macOS] 找到 .app 路径: ${appPath}`);
      processPath = appPath;
    } else if (!processPath.endsWith('.app')) {
      // 如果不是 .app 路径，返回空字符串避免崩溃
      console.warn(`[macOS] 跳过非应用程序路径: ${processPath}`);
      return '';
    }
  }

  // 检查文件是否存在
  if (!fs.existsSync(processPath)) {
    console.warn(`[getIconDataURL] 图标提取失败：文件不存在 - ${processPath}`);
    return '';
  }

  console.log(`[getIconDataURL] 文件存在,准备获取图标: ${processPath}`);

  // macOS 上使用原生命令行工具获取图标
  if (process.platform === 'darwin') {
    try {
      console.log(`[macOS] 使用原生命令获取图标`);

      // 1. 从 Info.plist 获取图标文件名
      const plistPath = path.join(processPath, 'Contents', 'Info.plist');
      if (!fs.existsSync(plistPath)) {
        console.warn(`[macOS] Info.plist 不存在: ${plistPath}`);
        return '';
      }

      // 使用 plutil 读取 CFBundleIconFile
      const iconFileName = execSync(
        `plutil -extract CFBundleIconFile raw -o - "${plistPath}"`,
        { encoding: 'utf8' }
      ).trim();

      if (!iconFileName) {
        console.warn(`[macOS] 未找到 CFBundleIconFile`);
        return '';
      }

      console.log(`[macOS] 图标文件名: ${iconFileName}`);

      // 2. 查找 .icns 文件
      let icnsPath = path.join(processPath, 'Contents', 'Resources', iconFileName);
      if (!icnsPath.endsWith('.icns')) {
        icnsPath += '.icns';
      }

      if (!fs.existsSync(icnsPath)) {
        console.warn(`[macOS] icns 文件不存在: ${icnsPath}`);
        return '';
      }

      console.log(`[macOS] 找到 icns 文件: ${icnsPath}`);

      // 3. 创建临时 PNG 文件
      const tempPngPath = path.join(os.tmpdir(), `icon-${Date.now()}.png`);

      // 4. 使用 sips 转换 icns 到 png
      execSync(
        `sips -s format png "${icnsPath}" --out "${tempPngPath}" --resampleWidth 128`,
        { stdio: 'pipe' }
      );

      console.log(`[macOS] 成功转换为 PNG: ${tempPngPath}`);

      // 5. 读取 PNG 文件并转换为 Data URL
      const pngBuffer = fs.readFileSync(tempPngPath);
      const dataURL = `data:image/png;base64,${pngBuffer.toString('base64')}`;

      // 6. 删除临时文件
      fs.unlinkSync(tempPngPath);

      console.log(`[macOS] 成功获取图标, Data URL 长度: ${dataURL.length}`);
      return dataURL;

    } catch (error) {
      console.error(`[macOS] 获取图标失败:`, error.message);
      return '';
    }
  }

  // Windows 使用 app.getFileIcon
  try {
    // 使用 Electron 内置 API 获取文件图标
    // size 选项: 'small' (16x16), 'normal' (32x32), 'large' (48x48 on Windows, 128x128 on macOS)
    console.log(`[getIconDataURL] 调用 app.getFileIcon, size: large`);
    const icon = await app.getFileIcon(processPath, { size: 'large' });
    console.log(`[getIconDataURL] app.getFileIcon 成功返回`);

    // 将 NativeImage 转换为 Data URL
    const dataURL = icon.toDataURL();
    console.log(`[getIconDataURL] 成功转换为 Data URL, 长度: ${dataURL.length}`);

    return dataURL;
  } catch (error) {
    console.error(`[getIconDataURL] 获取图标失败 (${processPath}):`, error);
    console.error(`[getIconDataURL] 错误堆栈:`, error.stack);
    return '';
  }
}

module.exports = {
  getIconDataURL
};

