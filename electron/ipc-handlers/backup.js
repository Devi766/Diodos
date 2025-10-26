/**
 * 备份与还原相关的IPC处理器
 */

const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const BackupManager = require('../backup/backup-manager');
const WebDAVClient = require('../backup/webdav-client');
const { BackupType } = require('../backup/backup-types');

module.exports = function registerBackupHandlers(context) {
  const dbManager = context.get('dbManager');
  const backupManager = new BackupManager(context);

  // ==================== 本地备份 ====================

  /**
   * 创建本地备份
   */
  ipcMain.handle('backup-create-local', async (event, backupType = 'CONFIG_ONLY') => {
    try {
      console.log(`[IPC] 创建本地备份, 类型: ${backupType}`);

      // 显示保存文件对话框
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: '保存备份',
        defaultPath: path.join(
          os.homedir(),
          'Downloads',
          `flyclash_backup_${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.zip`
        ),
        filters: [
          { name: 'ZIP文件', extensions: ['zip'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      });

      if (canceled || !filePath) {
        return { success: false, error: '用户取消' };
      }

      // 创建备份数据
      const backupData = await backupManager.createBackup(BackupType[backupType]);

      // 创建ZIP文件
      await backupManager.createBackupZip(backupData, filePath);

      console.log(`[IPC] 本地备份创建成功: ${filePath}`);
      return { success: true, filePath };
    } catch (error) {
      console.error('[IPC] 创建本地备份失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 还原本地备份
   */
  ipcMain.handle('backup-restore-local', async () => {
    try {
      console.log('[IPC] 还原本地备份');

      // 显示打开文件对话框
      const { filePaths, canceled } = await dialog.showOpenDialog({
        title: '选择备份文件',
        filters: [
          { name: 'ZIP文件', extensions: ['zip'] },
          { name: '所有文件', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (canceled || filePaths.length === 0) {
        return { success: false, error: '用户取消' };
      }

      const filePath = filePaths[0];

      // 读取备份数据
      const backupData = await backupManager.extractBackupZip(filePath);

      // 还原备份
      await backupManager.restoreBackup(backupData);

      console.log(`[IPC] 本地备份还原成功`);
      return { success: true };
    } catch (error) {
      console.error('[IPC] 还原本地备份失败:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== WebDAV备份 ====================

  /**
   * 测试WebDAV连接
   */
  ipcMain.handle('backup-webdav-test', async (event, config) => {
    try {
      console.log('[IPC] 测试WebDAV连接');

      const webdavClient = new WebDAVClient(config);
      const result = await webdavClient.testConnection();

      return { success: result };
    } catch (error) {
      console.error('[IPC] WebDAV连接测试失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 上传备份到WebDAV
   */
  ipcMain.handle('backup-webdav-upload', async (event, backupType = 'CONFIG_ONLY') => {
    try {
      console.log(`[IPC] 上传备份到WebDAV, 类型: ${backupType}`);

      // 获取WebDAV配置
      const config = {
        uri: dbManager.getSetting('webdav_uri', ''),
        username: dbManager.getSetting('webdav_username', ''),
        password: dbManager.getSetting('webdav_password', ''),
        backupDirectory: dbManager.getSetting('webdav_backup_dir', 'FlyClash'),
        fileName: dbManager.getSetting('webdav_backup_filename', 'flyclash_backup.zip')
      };

      if (!config.uri || !config.username || !config.password) {
        throw new Error('WebDAV配置不完整');
      }

      // 创建备份数据
      const backupData = await backupManager.createBackup(BackupType[backupType]);

      // 创建临时ZIP文件
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(tempDir, `flyclash_temp_${Date.now()}.zip`);
      await backupManager.createBackupZip(backupData, tempFilePath);

      // 上传到WebDAV（使用配置中的文件名）
      const webdavClient = new WebDAVClient(config);
      const uploadResult = await webdavClient.uploadBackup(tempFilePath, (uploaded, total, percentage) => {
        // 发送进度事件
        if (context.state.mainWindow && !context.state.mainWindow.isDestroyed()) {
          context.state.mainWindow.webContents.send('backup-upload-progress', { uploaded, total, percentage });
        }
      }, false); // 使用配置中的文件名

      // 删除临时文件
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      if (!uploadResult.success) {
        throw new Error('上传失败');
      }

      console.log('[IPC] WebDAV备份上传成功:', uploadResult.fileName);
      return { success: true, fileName: uploadResult.fileName };
    } catch (error) {
      console.error('[IPC] WebDAV备份上传失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 从WebDAV下载备份
   * @param {string} fileName - 可选的备份文件名，不提供则使用配置中的文件名
   */
  ipcMain.handle('backup-webdav-download', async (event, fileName = null) => {
    try {
      // 获取WebDAV配置
      const config = {
        uri: dbManager.getSetting('webdav_uri', ''),
        username: dbManager.getSetting('webdav_username', ''),
        password: dbManager.getSetting('webdav_password', ''),
        backupDirectory: dbManager.getSetting('webdav_backup_dir', 'FlyClash'),
        fileName: dbManager.getSetting('webdav_backup_filename', 'flyclash_backup.zip')
      };

      // 如果没有指定文件名，使用配置中的文件名
      const targetFileName = fileName || config.fileName;

      console.log('[IPC] 从WebDAV下载备份:', targetFileName);

      if (!config.uri || !config.username || !config.password) {
        throw new Error('WebDAV配置不完整');
      }

      // 创建临时文件路径
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(tempDir, `flyclash_download_${Date.now()}.zip`);

      // 从WebDAV下载（使用指定的文件名）
      const webdavClient = new WebDAVClient(config);
      const downloadSuccess = await webdavClient.downloadBackup(tempFilePath, (downloaded, total, percentage) => {
        // 发送进度事件
        if (context.state.mainWindow && !context.state.mainWindow.isDestroyed()) {
          context.state.mainWindow.webContents.send('backup-download-progress', { downloaded, total, percentage });
        }
      }, targetFileName); // 传递文件名参数

      if (!downloadSuccess) {
        throw new Error('下载失败');
      }

      // 读取备份数据
      const backupData = await backupManager.extractBackupZip(tempFilePath);

      // 还原备份
      await backupManager.restoreBackup(backupData);

      // 删除临时文件
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      console.log('[IPC] WebDAV备份下载并还原成功');
      return { success: true };
    } catch (error) {
      console.error('[IPC] WebDAV备份下载失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 列出WebDAV上的备份文件
   */
  ipcMain.handle('backup-webdav-list', async () => {
    try {
      console.log('[IPC] 列出WebDAV备份');

      // 获取WebDAV配置
      const config = {
        uri: dbManager.getSetting('webdav_uri', ''),
        username: dbManager.getSetting('webdav_username', ''),
        password: dbManager.getSetting('webdav_password', ''),
        backupDirectory: dbManager.getSetting('webdav_backup_dir', 'FlyClash'),
        fileName: dbManager.getSetting('webdav_backup_filename', 'flyclash_backup.zip')
      };

      if (!config.uri || !config.username || !config.password) {
        return { success: true, backups: [] };
      }

      const webdavClient = new WebDAVClient(config);
      const backups = await webdavClient.listBackups();

      return { success: true, backups };
    } catch (error) {
      console.error('[IPC] 列出WebDAV备份失败:', error);
      return { success: false, error: error.message, backups: [] };
    }
  });

  /**
   * 删除WebDAV上的备份文件
   */
  ipcMain.handle('backup-webdav-delete', async (event, fileName) => {
    try {
      console.log(`[IPC] 删除WebDAV备份: ${fileName}`);

      // 获取WebDAV配置
      const config = {
        uri: dbManager.getSetting('webdav_uri', ''),
        username: dbManager.getSetting('webdav_username', ''),
        password: dbManager.getSetting('webdav_password', ''),
        backupDirectory: dbManager.getSetting('webdav_backup_dir', 'FlyClash'),
        fileName: dbManager.getSetting('webdav_backup_filename', 'flyclash_backup.zip')
      };

      if (!config.uri || !config.username || !config.password) {
        throw new Error('WebDAV配置不完整');
      }

      const webdavClient = new WebDAVClient(config);
      const deleteSuccess = await webdavClient.deleteBackup(fileName);

      if (!deleteSuccess) {
        throw new Error('删除失败');
      }

      return { success: true };
    } catch (error) {
      console.error('[IPC] 删除WebDAV备份失败:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== WebDAV设置 ====================

  /**
   * 保存WebDAV设置
   */
  ipcMain.handle('backup-webdav-save-config', async (event, config) => {
    try {
      console.log('[IPC] 保存WebDAV设置');

      dbManager.setSetting('webdav_uri', config.uri || '');
      dbManager.setSetting('webdav_username', config.username || '');
      dbManager.setSetting('webdav_password', config.password || '');
      dbManager.setSetting('webdav_backup_dir', config.backupDirectory || 'FlyClash');
      dbManager.setSetting('webdav_backup_filename', config.fileName || 'flyclash_backup.zip');

      return { success: true };
    } catch (error) {
      console.error('[IPC] 保存WebDAV设置失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 获取WebDAV设置
   */
  ipcMain.handle('backup-webdav-get-config', async () => {
    try {
      const config = {
        uri: dbManager.getSetting('webdav_uri', ''),
        username: dbManager.getSetting('webdav_username', ''),
        password: dbManager.getSetting('webdav_password', ''),
        backupDirectory: dbManager.getSetting('webdav_backup_dir', 'FlyClash'),
        fileName: dbManager.getSetting('webdav_backup_filename', 'flyclash_backup.zip')
      };

      return { success: true, config };
    } catch (error) {
      console.error('[IPC] 获取WebDAV设置失败:', error);
      return { success: false, error: error.message, config: {} };
    }
  });

  console.log('[IPC] 备份处理器已注册');
};
