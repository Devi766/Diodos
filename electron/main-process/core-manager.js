/**
 * 内核管理模块
 * 支持多内核版本管理、下载、切换
 * 提供统一的内核管理能力
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { pipeline } = require('stream');
const { promisify } = require('util');

const streamPipeline = promisify(pipeline);

/**
 * 内核类型定义
 */
const CoreType = {
  MIHOMO: 'mihomo',              // 稳定版 (MetaCubeX/mihomo Latest Release)
  MIHOMO_ALPHA: 'mihomo-alpha',  // Alpha 预发布版 (Prerelease-Alpha)
  MIHOMO_SMART: 'mihomo-smart',  // Smart 内核 (vernesong/mihomo)
  MIHOMO_SPECIFIC: 'mihomo-specific' // 用户指定的特定版本
};

/**
 * GitHub 仓库配置
 */
const GITHUB_REPOS = {
  [CoreType.MIHOMO]: {
    owner: 'MetaCubeX',
    repo: 'mihomo',
    prerelease: false
  },
  [CoreType.MIHOMO_ALPHA]: {
    owner: 'MetaCubeX',
    repo: 'mihomo',
    prerelease: true,
    tag: 'Prerelease-Alpha'
  },
  [CoreType.MIHOMO_SMART]: {
    owner: 'vernesong',
    repo: 'mihomo',
    prerelease: true,
    tag: 'Prerelease-Alpha'
  },
  [CoreType.MIHOMO_SPECIFIC]: {
    owner: 'MetaCubeX',
    repo: 'mihomo',
    prerelease: false
  }
};

const VERSION_CACHE_EXPIRE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

class CoreManager {
  constructor(context) {
    this.context = context;
    this.dbManager = context.dbManager;
    this.userDataPath = app.getPath('userData');
    this.coresDir = path.join(this.userDataPath, 'cores');

    // 确保 cores 目录存在
    if (!fs.existsSync(this.coresDir)) {
      fs.mkdirSync(this.coresDir, { recursive: true });
    }

    this.versionCache = new Map();
  }

  /**
   * 获取当前内核配置
   */
  getCurrentCoreConfig() {
    const coreType = this.dbManager?.getSetting('core_type', CoreType.MIHOMO) || CoreType.MIHOMO;
    const specificVersion = this.dbManager?.getSetting('core_specific_version', null);
    const customPath = this.dbManager?.getSetting('core_custom_path', null);

    return {
      coreType,
      specificVersion,
      customPath
    };
  }

  /**
   * 设置当前内核类型
   */
  setCurrentCoreType(coreType, specificVersion = null) {
    this.dbManager?.setSetting('core_type', coreType);
    if (coreType === CoreType.MIHOMO_SPECIFIC) {
      this.dbManager?.setSetting('core_specific_version', specificVersion || null);
    } else {
      this.dbManager?.setSetting('core_specific_version', null);
    }
    console.log('[CoreManager] 内核类型已设置:', coreType, specificVersion);
  }

  /**
   * 获取内核可执行文件路径
   */
  getCorePath(coreType = null, specificVersion = null) {
    const config = this.getCurrentCoreConfig();
    const type = coreType || config.coreType;
    const version = specificVersion || config.specificVersion;
    const hasExplicitSelection = coreType !== null || specificVersion !== null;

    // 如果设置了自定义路径，优先使用
    if (!hasExplicitSelection && config.customPath && fs.existsSync(config.customPath)) {
      return config.customPath;
    }

    const isWin = process.platform === 'win32';
    const ext = isWin ? '.exe' : '';

    // 根据内核类型返回路径
    if (type === CoreType.MIHOMO_SPECIFIC && version) {
      return path.join(this.coresDir, `mihomo-${version}${ext}`);
    }

    if (type === CoreType.MIHOMO_SMART) {
      return path.join(this.coresDir, `mihomo-smart${ext}`);
    }

    if (type === CoreType.MIHOMO_ALPHA) {
      return path.join(this.coresDir, `mihomo-alpha${ext}`);
    }

    // 默认稳定版
    return path.join(this.coresDir, `mihomo${ext}`);
  }

  /**
   * 获取内核版本信息
   */
  async getCoreVersion(corePath) {
    try {
      if (!fs.existsSync(corePath)) {
        return null;
      }

      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync(corePath, ['-v'], { timeout: 5000 });

      // 解析版本信息
      // 输出格式: Mihomo Meta v1.18.0 linux arm64 with go1.21.5 ...
      const match = stdout.match(/Mihomo.*?\sv([0-9A-Za-z.-]+)/i);
      if (match) {
        return match[1];
      }

      return null;
    } catch (error) {
      console.error('[CoreManager] 获取内核版本失败:', error);
      return null;
    }
  }

  getVersionCacheKey(coreType, limit) {
    return `${coreType}:${limit}`;
  }

  clearVersionCache(coreType = null) {
    if (!coreType) {
      this.versionCache.clear();
      return;
    }

    for (const key of this.versionCache.keys()) {
      if (key.startsWith(`${coreType}:`)) {
        this.versionCache.delete(key);
      }
    }
  }

  /**
   * 获取 GitHub Release 信息
   */
  async getLatestRelease(coreType) {
    const repoConfig = GITHUB_REPOS[coreType];
    if (!repoConfig) {
      throw new Error(`不支持的内核类型: ${coreType}`);
    }

    const { owner, repo, prerelease, tag } = repoConfig;

    try {
      if (tag) {
        // 优先获取特定标签 release，不存在时回退到 releases 列表匹配
        try {
          const taggedRelease = await this.fetchJSON(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`);
          if (taggedRelease) {
            return taggedRelease;
          }
        } catch (error) {
          console.warn('[CoreManager] 标签 release 获取失败，尝试回退匹配:', error?.message || error);
        }

        const releases = await this.fetchJSON(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`);
        if (Array.isArray(releases)) {
          const matched = releases.find((r) => r.tag_name === tag || r.name === tag);
          return matched || null;
        }
        return null;
      }

      if (prerelease) {
        // 获取所有 releases，筛选 prerelease
        const releases = await this.fetchJSON(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`);
        if (Array.isArray(releases)) {
          const release = releases.find((r) => r.prerelease) || releases[0];
          return release || null;
        }
        return null;
      }

      // 获取最新 stable release；若仓库没有 stable，则回退到 releases 列表首项
      try {
        return await this.fetchJSON(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
      } catch (error) {
        const msg = String(error?.message || error || '');
        if (!/Not Found|HTTP 404/i.test(msg)) {
          throw error;
        }

        const releases = await this.fetchJSON(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`);
        if (!Array.isArray(releases)) {
          return null;
        }
        return releases.find((r) => !r.prerelease) || releases[0] || null;
      }
    } catch (error) {
      console.error('[CoreManager] 获取 Release 信息失败:', error);
      throw error;
    }
  }

  /**
   * 获取所有可用版本列表
   */
  async getAvailableVersions(coreType, limit = 20, forceRefresh = false) {
    const repoConfig = GITHUB_REPOS[coreType];
    if (!repoConfig) {
      throw new Error(`不支持的内核类型: ${coreType}`);
    }

    const { owner, repo } = repoConfig;
    const cacheKey = this.getVersionCacheKey(coreType, limit);

    if (!forceRefresh && this.versionCache.has(cacheKey)) {
      const cacheData = this.versionCache.get(cacheKey);
      if (Date.now() - cacheData.timestamp < VERSION_CACHE_EXPIRE_MS) {
        return cacheData.versions;
      }
    }

    try {
      // 获取所有 releases
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
      console.log('[CoreManager] 获取版本列表:', apiUrl);
      const data = await this.fetchJSON(apiUrl);

      if (!Array.isArray(data)) {
        console.error('[CoreManager] API 返回数据格式错误:', data);
        return [];
      }

      console.log(`[CoreManager] 获取到 ${data.length} 个版本`);

      let releases = [];

      // 根据内核类型筛选版本
      if (coreType === CoreType.MIHOMO || coreType === CoreType.MIHOMO_SPECIFIC) {
        // 稳定版：只显示非 prerelease
        releases = data.filter(r => !r.prerelease).slice(0, limit);
        console.log(`[CoreManager] 稳定版筛选后: ${releases.length} 个`);
      } else if (coreType === CoreType.MIHOMO_ALPHA) {
        // Alpha 版本：显示所有版本（包括稳定版和预发布版）
        // 这样用户可以选择任何版本
        releases = data.slice(0, limit);
        console.log(`[CoreManager] Alpha 版本: ${releases.length} 个`);
      } else if (coreType === CoreType.MIHOMO_SMART) {
        // Smart 内核：显示所有版本
        releases = data.slice(0, limit);
        console.log(`[CoreManager] Smart 内核: ${releases.length} 个版本`);
      }

      // 转换为版本列表
      const versions = releases.map(release => ({
        version: release.tag_name.replace(/^v/, ''),
        tagName: release.tag_name,
        name: release.name,
        publishedAt: release.published_at,
        prerelease: release.prerelease,
        body: release.body
      }));

      this.versionCache.set(cacheKey, {
        versions,
        timestamp: Date.now()
      });

      console.log('[CoreManager] 返回版本列表前3个:', versions.slice(0, 3).map(v => `${v.version} (${v.prerelease ? 'pre' : 'stable'})`));
      return versions;
    } catch (error) {
      console.error('[CoreManager] 获取版本列表失败:', error);
      throw error;
    }
  }

  findDownloadAsset(release) {
    const { pattern } = this.getDownloadAssetName();
    return release.assets.find(a => pattern.test(a.name));
  }

  getArchiveTypeFromName(name = '') {
    const normalized = String(name).toLowerCase();
    if (normalized.endsWith('.zip')) return 'zip';
    if (normalized.endsWith('.gz')) return 'gz';
    return '';
  }

  validateArchiveFile(filePath, archiveName = '') {
    const expectedType = this.getArchiveTypeFromName(archiveName);
    const stat = fs.statSync(filePath);
    if (!stat.size) {
      throw new Error('下载文件为空，可能下载失败或被拦截');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, 0);
      const isZip = header[0] === 0x50 && header[1] === 0x4b;
      const isGz = header[0] === 0x1f && header[1] === 0x8b;

      if (!expectedType) {
        return;
      }

      if (expectedType === 'zip' && !isZip) {
        throw new Error('下载内容不是有效 ZIP 文件，可能被代理/网关替换');
      }

      if (expectedType === 'gz' && !isGz) {
        throw new Error('下载内容不是有效 GZIP 文件，可能被代理/网关替换');
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  async downloadReleaseAsset(release, coreType, version, onProgress) {
    const asset = this.findDownloadAsset(release);
    if (!asset) {
      throw new Error(`未找到适合当前平台的内核文件 (${process.platform}-${process.arch})`);
    }

    console.log('[CoreManager] 下载文件:', asset.name);
    const tempFile = path.join(this.coresDir, `${asset.name}.tmp`);

    try {
      await this.downloadFile(asset.browser_download_url, tempFile, onProgress);
      this.validateArchiveFile(tempFile, asset.name);
      const extractedPath = await this.extractCore(tempFile, coreType, version, asset.name);

      if (process.platform !== 'win32') {
        fs.chmodSync(extractedPath, 0o755);
      }

      console.log('[CoreManager] 内核下载完成:', extractedPath);

      return {
        success: true,
        version,
        path: extractedPath
      };
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  /**
   * 下载指定版本的内核
   */
  async downloadSpecificVersion(coreType, version, onProgress) {
    const repoConfig = GITHUB_REPOS[coreType];
    if (!repoConfig) {
      throw new Error(`不支持的内核类型: ${coreType}`);
    }

    const { owner, repo } = repoConfig;

    try {
      console.log('[CoreManager] 下载指定版本:', coreType, version);

      // 获取指定版本的 Release 信息
      // 仅对纯数字版本补 v 前缀，避免把 Prerelease-Alpha 变成 vPrerelease-Alpha
      const isSemverLike = /^\d+(\.\d+){1,3}([-.].+)?$/i.test(version);
      const tagName = version.startsWith('v') || !isSemverLike ? version : `v${version}`;
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tagName}`;
      const release = await this.fetchJSON(apiUrl);

      if (!release) {
        throw new Error(`未找到版本 ${version}`);
      }

      console.log('[CoreManager] 找到版本:', release.tag_name);
      this.clearVersionCache(coreType);
      return await this.downloadReleaseAsset(release, coreType, version, onProgress);

    } catch (error) {
      console.error('[CoreManager] 下载指定版本失败:', error);
      throw error;
    }
  }

  /**
   * 获取下载 URL
   */
  getDownloadAssetName() {
    const platform = process.platform;
    const arch = process.arch;

    let osName, archName;

    // 平台映射
    if (platform === 'win32') {
      osName = 'windows';
    } else if (platform === 'darwin') {
      osName = 'darwin';
    } else if (platform === 'linux') {
      osName = 'linux';
    } else {
      throw new Error(`不支持的平台: ${platform}`);
    }

    // 架构映射
    if (arch === 'x64') {
      archName = 'amd64';
    } else if (arch === 'arm64') {
      archName = 'arm64';
    } else if (arch === 'ia32') {
      archName = '386';
    } else {
      throw new Error(`不支持的架构: ${arch}`);
    }

    // 文件名格式: mihomo-{os}-{arch}-{version}.gz 或 .zip
    const ext = platform === 'win32' ? '.zip' : '.gz';
    return {
      pattern: new RegExp(`mihomo-${osName}-${archName}(-compatible)?-.*${ext}$`, 'i'),
      osName,
      archName,
      ext
    };
  }

  /**
   * 下载内核
   */
  async downloadCore(coreType, onProgress) {
    try {
      console.log('[CoreManager] 开始下载内核:', coreType);

      // 获取 Release 信息
      const release = await this.getLatestRelease(coreType);
      if (!release) {
        throw new Error('未找到可用的 Release');
      }

      const version = release.tag_name.replace(/^v/, '');
      console.log('[CoreManager] 找到版本:', version);
      this.clearVersionCache(coreType);
      return await this.downloadReleaseAsset(release, coreType, version, onProgress);

    } catch (error) {
      console.error('[CoreManager] 下载内核失败:', error);
      throw error;
    }
  }

  /**
   * 解压内核文件
   */
  async extractCore(archivePath, coreType, version, archiveName = '') {
    const isWin = process.platform === 'win32';
    const ext = isWin ? '.exe' : '';

    let targetName;
    if (coreType === CoreType.MIHOMO_SPECIFIC) {
      targetName = `mihomo-${version}${ext}`;
    } else if (coreType === CoreType.MIHOMO_SMART) {
      targetName = `mihomo-smart${ext}`;
    } else if (coreType === CoreType.MIHOMO_ALPHA) {
      targetName = `mihomo-alpha${ext}`;
    } else {
      targetName = `mihomo${ext}`;
    }

    const targetPath = path.join(this.coresDir, targetName);

    const normalizedName = String(archiveName || archivePath).toLowerCase();
    let archiveType = '';

    if (normalizedName.endsWith('.gz')) {
      archiveType = 'gz';
    } else if (normalizedName.endsWith('.zip')) {
      archiveType = 'zip';
    } else {
      // 兜底：根据文件头识别压缩格式，避免临时文件后缀导致误判
      let fd;
      try {
        fd = fs.openSync(archivePath, 'r');
        const header = Buffer.alloc(4);
        fs.readSync(fd, header, 0, 4, 0);

        if (header[0] === 0x1f && header[1] === 0x8b) {
          archiveType = 'gz';
        } else if (header[0] === 0x50 && header[1] === 0x4b) {
          archiveType = 'zip';
        }
      } catch (error) {
        console.warn('[CoreManager] 识别压缩格式失败:', error?.message || error);
      } finally {
        if (typeof fd === 'number') {
          try {
            fs.closeSync(fd);
          } catch {}
        }
      }
    }

    if (archiveType === 'gz') {
      // 解压 .gz 文件
      const zlib = require('zlib');
      const gunzip = zlib.createGunzip();
      const source = fs.createReadStream(archivePath);
      const destination = fs.createWriteStream(targetPath);

      await streamPipeline(source, gunzip, destination);
    } else if (archiveType === 'zip') {
      // 解压 .zip 文件
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(archivePath);
      const zipEntries = zip.getEntries();

      // 查找内核文件
      const coreEntry = zipEntries.find(entry =>
        entry.entryName.toLowerCase().includes('mihomo') &&
        (entry.entryName.endsWith('.exe') || !entry.entryName.includes('.'))
      );

      if (!coreEntry) {
        throw new Error('压缩包中未找到内核文件');
      }

      // 解压到目标路径
      fs.writeFileSync(targetPath, coreEntry.getData());
    } else {
      throw new Error(`不支持的压缩格式: ${archiveName || archivePath}`);
    }

    return targetPath;
  }

  /**
   * 下载文件
   */
  async downloadFile(url, destPath, onProgress, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      let settled = false;
      let totalSize = 0;
      let downloadedSize = 0;

      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (error) {
          try { file.close(); } catch {}
          if (fs.existsSync(destPath)) {
            try { fs.unlinkSync(destPath); } catch {}
          }
          reject(error);
        } else {
          resolve();
        }
      };

      const request = https.get(url, {
        headers: {
          'User-Agent': 'FlyClash'
        },
        timeout: REQUEST_TIMEOUT_MS
      }, (response) => {
        // 处理重定向
        if ([301, 302, 307, 308].includes(response.statusCode)) {
          if (redirectCount >= MAX_REDIRECTS) {
            file.close();
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            return finish(new Error('下载失败: 重定向次数过多'));
          }

          if (!response.headers.location) {
            file.close();
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            return finish(new Error('下载失败: 重定向地址为空'));
          }

          file.close();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          return this.downloadFile(response.headers.location, destPath, onProgress, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          return finish(new Error(`下载失败: HTTP ${response.statusCode}`));
        }

        totalSize = parseInt(response.headers['content-length'], 10) || 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (onProgress && totalSize) {
            const progress = (downloadedSize / totalSize) * 100;
            onProgress(progress, downloadedSize, totalSize);
          }
        });

        response.on('aborted', () => {
          finish(new Error('下载连接被中断'));
        });

        response.on('error', (err) => {
          finish(err);
        });

        response.on('end', () => {
          if (totalSize > 0 && downloadedSize !== totalSize) {
            finish(new Error(`下载不完整: ${downloadedSize}/${totalSize}`));
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          if (totalSize > 0 && downloadedSize !== totalSize) {
            return finish(new Error(`下载不完整: ${downloadedSize}/${totalSize}`));
          }
          file.close();
          if (onProgress && totalSize) {
            onProgress(100, totalSize, totalSize);
          }
          finish();
        });
      });

      request.on('timeout', () => {
        request.destroy();
        finish(new Error('下载超时'));
      });

      request.on('error', (err) => {
        finish(err);
      });

      file.on('error', (err) => {
        finish(err);
      });
    });
  }

  /**
   * 获取 JSON 数据
   */
  async fetchJSON(url) {
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: {
        'User-Agent': 'FlyClash',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
        },
        timeout: REQUEST_TIMEOUT_MS
      }, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            try {
              const json = JSON.parse(data);
              const message = json && json.message ? json.message : `HTTP ${response.statusCode}`;
              return reject(new Error(`请求失败: ${message}`));
            } catch {
              return reject(new Error(`请求失败: HTTP ${response.statusCode}`));
            }
          }

          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (error) {
            reject(new Error('解析 JSON 失败'));
          }
        });
      })
        .on('timeout', function onTimeout() {
          this.destroy(new Error('请求超时'));
        })
        .on('error', reject);
    });
  }

  /**
   * 检查内核更新
   */
  async checkCoreUpdate(coreType) {
    try {
      const corePath = this.getCorePath(coreType);
      const currentVersion = await this.getCoreVersion(corePath);
      const release = await this.getLatestRelease(coreType);

      if (!release) {
        return { hasUpdate: false };
      }

      const latestVersion = release.tag_name.replace(/^v/, '');

      return {
        hasUpdate: currentVersion !== latestVersion,
        currentVersion,
        latestVersion,
        releaseInfo: {
          name: release.name,
          body: release.body,
          publishedAt: release.published_at
        }
      };
    } catch (error) {
      console.error('[CoreManager] 检查更新失败:', error);
      throw error;
    }
  }

  /**
   * 切换内核
   */
  async switchCore(coreType, specificVersion = null) {
    try {
      console.log('[CoreManager] 切换内核:', coreType, specificVersion);

      if (coreType === CoreType.MIHOMO_SPECIFIC && !specificVersion) {
        throw new Error('请先选择具体版本');
      }

      // 检查内核文件是否存在
      const corePath = this.getCorePath(coreType, specificVersion);
      if (!fs.existsSync(corePath)) {
        throw new Error('内核文件不存在，请先下载');
      }

      // 保存配置
      this.setCurrentCoreType(coreType, specificVersion);
      this.dbManager?.setSetting('core_custom_path', null);

      // 重启内核服务
      if (this.context.mihomoService && typeof this.context.mihomoService.restartMihomo === 'function') {
        const configPath = this.context.state?.configFilePath;
        if (configPath) {
          await this.context.mihomoService.restartMihomo(configPath);
        }
      }

      return { success: true };
    } catch (error) {
      console.error('[CoreManager] 切换内核失败:', error);
      throw error;
    }
  }

  /**
   * 获取已安装的内核列表
   */
  getInstalledCores() {
    const cores = [];
    const isWin = process.platform === 'win32';
    const ext = isWin ? '.exe' : '';

    if (!fs.existsSync(this.coresDir)) {
      return cores;
    }

    const files = fs.readdirSync(this.coresDir);

    for (const file of files) {
      if (file.startsWith('mihomo') && (isWin ? file.endsWith('.exe') : !file.includes('.'))) {
        const filePath = path.join(this.coresDir, file);
        const stats = fs.statSync(filePath);
        const baseName = isWin ? file.slice(0, -4) : file;

        let coreType = CoreType.MIHOMO;
        let version = null;

        if (baseName === 'mihomo-smart') {
          coreType = CoreType.MIHOMO_SMART;
        } else if (baseName === 'mihomo-alpha') {
          coreType = CoreType.MIHOMO_ALPHA;
        } else if (baseName.startsWith('mihomo-')) {
          coreType = CoreType.MIHOMO_SPECIFIC;
          version = baseName.slice('mihomo-'.length) || null;
        }

        cores.push({
          type: coreType,
          version,
          path: filePath,
          size: stats.size,
          modifiedAt: stats.mtime
        });
      }
    }

    cores.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    return cores;
  }

  /**
   * 删除内核
   */
  deleteCore(corePath) {
    try {
      const resolvedCorePath = path.resolve(corePath);
      const allowedPrefix = path.resolve(this.coresDir) + path.sep;
      if (!resolvedCorePath.startsWith(allowedPrefix)) {
        return { success: false, error: '仅允许删除内核目录下的文件' };
      }

      if (fs.existsSync(resolvedCorePath)) {
        fs.unlinkSync(resolvedCorePath);
        console.log('[CoreManager] 内核已删除:', resolvedCorePath);
        return { success: true };
      }
      return { success: false, error: '文件不存在' };
    } catch (error) {
      console.error('[CoreManager] 删除内核失败:', error);
      throw error;
    }
  }
}

module.exports = function initCoreManager(context) {
  const coreManager = new CoreManager(context);
  context.coreManager = coreManager;

  return coreManager;
};

module.exports.CoreType = CoreType;
