/**
 * WebDAV客户端
 * 与安卓端保持兼容的WebDAV备份实现
 */

const { createClient } = require('webdav');
const fs = require('fs');

class WebDAVClient {
  /**
   * @param {Object} config - WebDAV配置
   * @param {string} config.uri - WebDAV服务器地址
   * @param {string} config.username - 用户名
   * @param {string} config.password - 密码
   * @param {string} config.backupDirectory - 备份目录（默认"FlyClash"）
   * @param {string} config.fileName - 备份文件名（默认"flyclash_backup.zip"）
   */
  constructor(config) {
    this.config = config;
    this.client = null;
    this.initClient();
  }

  /**
   * 初始化WebDAV客户端
   */
  initClient() {
    if (!this.config.uri || !this.config.username || !this.config.password) {
      throw new Error('WebDAV配置不完整');
    }

    this.client = createClient(this.config.uri, {
      username: this.config.username,
      password: this.config.password,
      maxContentLength: 1024 * 1024 * 100, // 100MB
      timeout: 300000 // 5分钟超时
    });

    console.log(`[WebDAVClient] 客户端已初始化: ${this.config.uri}`);
  }

  /**
   * 获取服务器URL（确保以/结尾）- 与安卓版本保持一致
   */
  getServerUrl() {
    const uri = this.config.uri || '';
    return uri.endsWith('/') ? uri : `${uri}/`;
  }

  /**
   * 获取备份目录名称
   */
  getBackupDir() {
    let dir = (this.config.backupDirectory || 'FlyClash').trim() || 'FlyClash';
    // 移除开头的斜杠（如果有）
    if (dir.startsWith('/')) {
      dir = dir.substring(1);
    }
    return dir;
  }

  /**
   * 获取备份目录路径（相对于WebDAV根目录）
   */
  getBackupDirectoryPath() {
    const dir = this.getBackupDir();
    // 确保路径以/开头，但不要双斜杠
    return `/${dir}`;
  }

  /**
   * 获取完整备份文件路径（相对于WebDAV根目录）
   * @param {string} fileName - 可选的文件名，不提供则使用配置中的默认名称
   */
  getBackupFilePath(fileName = null) {
    const dir = this.getBackupDir();
    const name = fileName || this.config.fileName || 'flyclash_backup.zip';
    // 确保路径格式正确
    return `/${dir}/${name}`;
  }

  /**
   * 生成带时间戳的备份文件名
   * @returns {string} 带时间戳的文件名，如 flyclash_backup_20251026_143022.zip
   */
  generateTimestampedFileName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');

    const timestamp = `${year}${month}${day}_${hour}${minute}${second}`;
    return `flyclash_backup_${timestamp}.zip`;
  }

  /**
   * 测试连接
   * @returns {Promise<boolean>} 是否连接成功
   */
  async testConnection() {
    try {
      console.log('[WebDAVClient] 测试连接...');

      // 尝试获取根目录信息
      await this.client.stat('/');

      console.log('[WebDAVClient] 连接测试成功');
      return true;
    } catch (error) {
      console.error('[WebDAVClient] 连接测试失败:', error.message);
      return false;
    }
  }

  /**
   * 上传备份文件
   * @param {string} localFilePath - 本地文件路径
   * @param {Function} onProgress - 进度回调 (bytesUploaded, totalBytes, percentage)
   * @param {boolean} useTimestamp - 是否使用时间戳文件名（默认true）
   * @returns {Promise<{success: boolean, fileName: string}>} 上传结果和实际文件名
   */
  async uploadBackup(localFilePath, onProgress = null, useTimestamp = true) {
    try {
      console.log('[WebDAVClient] 开始上传备份...');

      // 读取本地文件
      const fileBuffer = fs.readFileSync(localFilePath);
      const totalBytes = fileBuffer.length;
      console.log(`[WebDAVClient] 文件大小: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

      // 生成文件名（带时间戳或固定名称）
      const fileName = useTimestamp ? this.generateTimestampedFileName() : (this.config.fileName || 'flyclash_backup.zip');
      // 构建相对路径（webdav库需要相对路径）
      const remotePath = this.getBackupFilePath(fileName);
      console.log(`[WebDAVClient] 上传到: ${remotePath}`);

      // 确保备份目录存在（在上传前检查）
      const dirPath = this.getBackupDirectoryPath();
      try {
        const dirExists = await this.client.exists(dirPath);
        if (!dirExists) {
          console.log(`[WebDAVClient] 创建目录: ${dirPath}`);
          await this.client.createDirectory(dirPath, { recursive: true });
        }
      } catch (dirError) {
        console.warn('[WebDAVClient] 检查/创建目录失败，尝试直接上传:', dirError.message);
        // 忽略目录创建错误，尝试直接上传
      }

      // 模拟进度（webdav库不直接支持进度回调）
      if (onProgress) {
        onProgress(0, totalBytes, 0);
      }

      // 使用webdav库上传
      await this.client.putFileContents(remotePath, fileBuffer, {
        contentLength: totalBytes,
        overwrite: true
      });

      if (onProgress) {
        onProgress(totalBytes, totalBytes, 100);
      }

      console.log('[WebDAVClient] 上传成功');
      return { success: true, fileName };
    } catch (error) {
      console.error('[WebDAVClient] 上传失败:', error);
      throw error;
    }
  }

  /**
   * 下载备份文件
   * @param {string} localFilePath - 本地保存路径
   * @param {Function} onProgress - 进度回调 (bytesDownloaded, totalBytes, percentage)
   * @param {string} fileName - 可选的远程文件名，不提供则下载最新的备份
   * @returns {Promise<boolean>} 是否下载成功
   */
  async downloadBackup(localFilePath, onProgress = null, fileName = null) {
    try {
      console.log('[WebDAVClient] 开始下载备份...');

      let remotePath;

      // 如果没有指定文件名，下载最新的备份
      if (!fileName) {
        const backups = await this.listBackups();
        if (backups.length === 0) {
          console.warn('[WebDAVClient] 没有找到任何备份文件');
          throw new Error('没有找到任何备份文件');
        }
        // 取最新的备份（列表已按时间排序）
        fileName = backups[0].name;
        console.log(`[WebDAVClient] 未指定文件名，下载最新备份: ${fileName}`);
      }

      remotePath = this.getBackupFilePath(fileName);
      console.log(`[WebDAVClient] 下载自: ${remotePath}`);

      // 检查文件是否存在
      const exists = await this.client.exists(remotePath);
      if (!exists) {
        console.warn('[WebDAVClient] 备份文件不存在');
        throw new Error(`备份文件不存在: ${fileName}`);
      }

      // 获取文件信息
      const stat = await this.client.stat(remotePath);
      const totalBytes = stat.size;
      console.log(`[WebDAVClient] 文件大小: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

      if (onProgress) {
        onProgress(0, totalBytes, 0);
      }

      // 下载文件（使用 buffer 模式确保完整性）
      const fileBuffer = await this.client.getFileContents(remotePath, {
        format: 'binary'
      });

      // 验证下载的文件大小
      const downloadedSize = Buffer.isBuffer(fileBuffer) ? fileBuffer.length : fileBuffer.byteLength;
      console.log(`[WebDAVClient] 下载字节数: ${downloadedSize}, 预期: ${totalBytes}`);

      if (downloadedSize !== totalBytes) {
        console.warn(`[WebDAVClient] 文件大小不匹配！下载: ${downloadedSize}, 预期: ${totalBytes}`);
        // 不抛出错误，因为某些WebDAV服务器的stat可能不准确
        // 但记录警告以便调试
      }

      // 保存到本地
      fs.writeFileSync(localFilePath, fileBuffer);

      // 验证保存的文件大小
      const savedStats = fs.statSync(localFilePath);
      console.log(`[WebDAVClient] 保存文件大小: ${savedStats.size} 字节`);

      if (savedStats.size === 0) {
        throw new Error('保存的文件大小为0，下载可能失败');
      }

      if (onProgress) {
        onProgress(totalBytes, totalBytes, 100);
      }

      console.log(`[WebDAVClient] 下载成功: ${localFilePath}`);
      return true;
    } catch (error) {
      console.error('[WebDAVClient] 下载失败:', error);
      throw error;
    }
  }

  /**
   * 列出所有备份文件
   * @returns {Promise<Array>} 备份文件列表
   */
  async listBackups() {
    try {
      console.log('[WebDAVClient] 列出备份文件...');

      const dirPath = this.getBackupDirectoryPath();

      // 检查目录是否存在
      const exists = await this.client.exists(dirPath);
      if (!exists) {
        console.log('[WebDAVClient] 备份目录不存在');
        return [];
      }

      // 列出目录内容
      const contents = await this.client.getDirectoryContents(dirPath);

      // 筛选.zip文件
      const backups = contents
        .filter(item => item.type === 'file' && item.filename.endsWith('.zip'))
        .map(item => ({
          name: item.basename,
          size: item.size,
          lastModified: item.lastmod,
          path: item.filename
        }))
        .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

      console.log(`[WebDAVClient] 找到 ${backups.length} 个备份文件`);
      return backups;
    } catch (error) {
      console.error('[WebDAVClient] 列出备份失败:', error);
      return [];
    }
  }

  /**
   * 删除备份文件
   * @param {string} fileName - 文件名
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteBackup(fileName) {
    try {
      console.log(`[WebDAVClient] 删除备份: ${fileName}`);

      const dirPath = this.getBackupDirectoryPath();
      const filePath = `${dirPath}/${fileName}`;

      const exists = await this.client.exists(filePath);
      if (!exists) {
        console.warn(`[WebDAVClient] 文件不存在: ${filePath}`);
        return false;
      }

      await this.client.deleteFile(filePath);

      console.log('[WebDAVClient] 删除成功');
      return true;
    } catch (error) {
      console.error('[WebDAVClient] 删除失败:', error);
      throw error;
    }
  }



  /**
   * 确保目录存在（不存在则创建）
   */
  async ensureDirectoryExists(dirPath) {
    try {
      const exists = await this.client.exists(dirPath);
      if (!exists) {
        console.log(`[WebDAVClient] 创建目录: ${dirPath}`);
        await this.client.createDirectory(dirPath, { recursive: true });
      }
    } catch (error) {
      console.error('[WebDAVClient] 创建目录失败:', error);
      throw error;
    }
  }

  /**
   * 获取备份文件信息
   * @param {string} fileName - 文件名
   * @returns {Promise<Object|null>} 文件信息
   */
  async getBackupInfo(fileName) {
    try {
      const dirPath = this.getBackupDirectoryPath();
      const filePath = `${dirPath}/${fileName}`;

      const exists = await this.client.exists(filePath);
      if (!exists) {
        return null;
      }

      const stat = await this.client.stat(filePath);
      return {
        name: fileName,
        size: stat.size,
        lastModified: stat.lastmod,
        path: filePath
      };
    } catch (error) {
      console.error('[WebDAVClient] 获取文件信息失败:', error);
      return null;
    }
  }
}

module.exports = WebDAVClient;
