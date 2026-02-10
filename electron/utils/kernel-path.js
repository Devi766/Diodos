'use strict';

/**
 * Kernel path resolution module
 * Manages locating, loading, saving, and clearing the Mihomo kernel executable path.
 */

const path = require('path');
const fs = require('fs');

/**
 * Create a kernel path manager.
 * @param {object} deps
 * @param {object} deps.app - Electron app module
 * @param {object} deps.context - Shared context object
 * @param {string} deps.userDataPath - User data directory path
 */
function createKernelPathManager({ app, context, userDataPath }) {
  const kernelPreferenceFile = path.join(userDataPath, 'kernel-config.json');

  // 根据平台和架构生成内核候选列表
  function getDefaultKernelCandidates() {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
      if (arch === 'x64' || arch === 'amd64') {
        return [
          'mihomo-windows-amd64-compatible.exe',
          'mihomo-windows-amd64.exe',
          'mihomo.exe'
        ];
      } else if (arch === 'ia32' || arch === 'x86') {
        return [
          'mihomo-windows-386.exe',
          'mihomo.exe'
        ];
      } else if (arch === 'arm64') {
        return [
          'mihomo-windows-arm64.exe',
          'mihomo.exe'
        ];
      }
      return ['mihomo.exe'];
    } else if (platform === 'darwin') {
      if (arch === 'arm64') {
        return [
          'mihomo-darwin-arm64-compatible',
          'mihomo-darwin-arm64',
          'mihomo-darwin-universal',
          'mihomo'
        ];
      } else if (arch === 'x64') {
        return [
          'mihomo-darwin-amd64-compatible',
          'mihomo-darwin-amd64',
          'mihomo-darwin-universal',
          'mihomo'
        ];
      }
      return ['mihomo-darwin-universal', 'mihomo'];
    } else if (platform === 'linux') {
      if (arch === 'x64' || arch === 'amd64') {
        return [
          'mihomo-linux-amd64-compatible',
          'mihomo-linux-amd64',
          'mihomo'
        ];
      } else if (arch === 'arm64') {
        return [
          'mihomo-linux-arm64',
          'mihomo'
        ];
      } else if (arch === 'ia32' || arch === 'x86') {
        return [
          'mihomo-linux-386',
          'mihomo'
        ];
      }
      return ['mihomo'];
    }

    // 未知平台,返回通用候选
    return ['mihomo'];
  }

  function unique(array) {
    return Array.from(new Set(array.filter(Boolean)));
  }

  function resolveDefaultKernelPath() {
    const isWin = process.platform === 'win32';
    const genericName = `mihomo${isWin ? '.exe' : ''}`;

    const candidateRoots = unique([
      path.join(process.resourcesPath ?? '', 'sidecar'),
      path.join(app.getAppPath(), 'extra', 'sidecar'),
      path.join(__dirname, '../../extra/sidecar'),
      path.join(process.cwd(), 'extra/sidecar'),
      // 兼容旧版本的 cores 目录
      path.join(app.getAppPath(), 'cores'),
      path.join(process.resourcesPath ?? '', 'cores'),
      path.join(__dirname, '../../cores'),
      path.join(process.cwd(), 'cores')
    ]);

    const kernelCandidates = getDefaultKernelCandidates();

    for (const root of candidateRoots) {
      try {
        if (!root || !fs.existsSync(root)) {
          continue;
        }

        // 优先查找通用名称的内核
        const genericPath = path.join(root, genericName);
        if (fs.existsSync(genericPath)) {
          console.log(`找到内核: ${genericPath} (平台: ${process.platform}, 架构: ${process.arch})`);
          return genericPath;
        }

        // 然后查找平台特定的内核
        for (const candidate of kernelCandidates) {
          const candidatePath = path.join(root, candidate);
          if (fs.existsSync(candidatePath)) {
            console.log(`找到内核: ${candidatePath} (平台: ${process.platform}, 架构: ${process.arch})`);
            return candidatePath;
          }
        }

        // 如果没有找到匹配的候选,尝试查找任何 mihomo 文件
        const files = fs.readdirSync(root);
        const fallback = files.find((file) => {
          const lower = file.toLowerCase();
          return lower.includes('mihomo') && (
            process.platform === 'win32' ? lower.endsWith('.exe') : !lower.includes('.')
          );
        });
        if (fallback) {
          console.log(`使用备用内核: ${path.join(root, fallback)}`);
          return path.join(root, fallback);
        }
      } catch (error) {
        console.warn('搜索默认内核路径失败:', error?.message || error);
      }
    }

    return null;
  }

  function loadKernelPreference() {
    try {
      if (fs.existsSync(kernelPreferenceFile)) {
        const data = JSON.parse(fs.readFileSync(kernelPreferenceFile, 'utf8'));
        context.kernelPreference = data;
        return data || {};
      }
    } catch (error) {
      console.warn('读取内核配置失败:', error?.message || error);
    }
    context.kernelPreference = {};
    return {};
  }

  function saveKernelPreference(preference) {
    try {
      fs.writeFileSync(kernelPreferenceFile, JSON.stringify(preference ?? {}, null, 2), 'utf8');
      context.kernelPreference = preference ?? {};
    } catch (error) {
      console.error('保存内核配置失败:', error);
      throw error;
    }
  }

  function clearKernelPreference() {
    try {
      if (fs.existsSync(kernelPreferenceFile)) {
        fs.unlinkSync(kernelPreferenceFile);
      }
    } catch (error) {
      console.warn('清除内核配置失败:', error?.message || error);
    }
    context.kernelPreference = {};
  }

  function getKernelExecutablePath() {
    const preference = context.kernelPreference || loadKernelPreference();
    const customPath = preference?.customPath ? String(preference.customPath).trim() : '';
    if (customPath) {
      return customPath;
    }
    return resolveDefaultKernelPath();
  }

  return {
    kernelPreferenceFile,
    resolveDefaultKernelPath,
    loadKernelPreference,
    saveKernelPreference,
    clearKernelPreference,
    getKernelExecutablePath,
  };
}

module.exports = { createKernelPathManager };
