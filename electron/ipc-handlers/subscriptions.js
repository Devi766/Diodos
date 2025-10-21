module.exports = function registerSubscriptionHandlers(context) {
  const {
    ipcMain,
    fs,
    path,
    configDir,
    formatTraffic,
    getUserSettings,
    yaml,
    dbManager
  } = context;

  ipcMain.handle('save-subscription', async (event, url, content, customName, subscriptionInfo) => {
    try {
      console.log('保存订阅:', { url, customName });

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      let fileName;
      let name;

      if (customName) {
        const sanitized = customName.replace(/[/\\?%*:|"<>]/g, '_');
        fileName = `${sanitized}.yaml`;
        name = customName;
      } else if (url) {
        const urlObj = new URL(url);
        const host = urlObj.hostname.replace(/[/\\?%*:|"<>]/g, '_');
        const timestamp = Date.now();
        fileName = `${host}_${timestamp}.yaml`;
        name = host;
      } else {
        const timestamp = Date.now();
        fileName = `subscription_${timestamp}.yaml`;
        name = `subscription_${timestamp}`;
      }

      const filePath = path.join(configDir, fileName);

      // 保存YAML文件
      fs.writeFileSync(filePath, content, 'utf8');

      // 保存到数据库
      const subscriptionId = dbManager.addSubscription(name, filePath, url);

      // 保存订阅信息
      if (subscriptionInfo) {
        try {
          const usedTrafficBytes = parseTraffic(subscriptionInfo.usedTraffic);
          const remainingTrafficBytes = parseTraffic(subscriptionInfo.remainingTraffic);

          // 计算总流量 = 已用流量 + 剩余流量
          let totalTrafficBytes = null;
          if (usedTrafficBytes !== null && remainingTrafficBytes !== null) {
            totalTrafficBytes = usedTrafficBytes + remainingTrafficBytes;
          } else if (usedTrafficBytes !== null) {
            totalTrafficBytes = usedTrafficBytes;
          } else if (remainingTrafficBytes !== null) {
            totalTrafficBytes = remainingTrafficBytes;
          }

          const expiryTimestamp = subscriptionInfo.expiryDate ?
            new Date(subscriptionInfo.expiryDate).getTime() : null;

          dbManager.setSubscriptionInfo(
            subscriptionId,
            usedTrafficBytes,
            totalTrafficBytes,
            expiryTimestamp
          );
        } catch (error) {
          console.warn('保存订阅信息失败:', error);
        }
      }

      console.log('订阅保存成功:', filePath);
      return { success: true, filePath };
    } catch (error) {
      console.error('保存订阅失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-subscriptions', () => {
    try {
      const subscriptions = dbManager.getAllSubscriptions();

      return subscriptions.map((sub) => {
        // 格式化流量数据
        const usedTraffic = sub.used_traffic ? formatTraffic(sub.used_traffic) : null;
        const totalTraffic = sub.total_traffic ? formatTraffic(sub.total_traffic) : null;
        const remainingTraffic = (sub.total_traffic && sub.used_traffic) ?
          formatTraffic(Math.max(0, sub.total_traffic - sub.used_traffic)) : null;

        // 格式化到期日期
        const expiryDate = sub.expiry_timestamp ?
          new Date(sub.expiry_timestamp).toLocaleDateString() : null;

        return {
          name: sub.name,
          path: sub.file_path,
          usedTraffic,
          remainingTraffic,
          totalTraffic,
          expiryDate,
          lastUpdated: new Date(sub.updated_at).toLocaleString()
        };
      });
    } catch (error) {
      console.error('获取订阅列表失败:', error);
      return [];
    }
  });

  ipcMain.handle('delete-subscription', (event, filePath) => {
    try {
      // 从数据库删除
      dbManager.deleteSubscriptionByPath(filePath);

      // 删除YAML文件
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return true;
    } catch (error) {
      console.error(`Failed to delete ${filePath}:`, error);
      return false;
    }
  });

  ipcMain.handle('get-subscription-url', (event, filePath) => {
    try {
      const sub = dbManager.getSubscriptionByPath(filePath);
      return sub ? sub.url : null;
    } catch (error) {
      console.error('获取订阅URL失败:', error);
      return null;
    }
  });

  ipcMain.handle('edit-subscription', async (event, params) => {
    try {
      const { oldPath, newName, newUrl } = params;

      // 读取旧文件内容
      const content = fs.readFileSync(oldPath, 'utf8');

      // 生成新文件名
      const sanitized = newName.replace(/[/\\?%*:|"<>]/g, '_');
      const newFileName = `${sanitized}.yaml`;
      const newPath = path.join(configDir, newFileName);

      // 如果文件名改变了,需要重命名文件
      if (oldPath !== newPath) {
        // 检查新文件名是否已存在
        if (fs.existsSync(newPath)) {
          throw new Error('该配置名称已存在');
        }

        // 写入新文件
        fs.writeFileSync(newPath, content, 'utf8');

        // 删除旧文件
        fs.unlinkSync(oldPath);
      }

      // 更新数据库记录
      const updates = {
        name: newName
      };

      if (oldPath !== newPath) {
        updates.file_path = newPath;
      }

      if (newUrl !== undefined) {
        updates.url = newUrl;
      }

      dbManager.updateSubscriptionByPath(oldPath, updates);

      return { success: true, newPath };
    } catch (error) {
      console.error('编辑配置失败:', error);
      throw error;
    }
  });

  ipcMain.handle('fetch-subscription', async (event, subUrl) => {
    try {
      const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

      const userSettings = getUserSettings();
      const userAgent = context.security?.getSafeUserAgent
        ? context.security.getSafeUserAgent(userSettings['subscription-ua'], context.APP_VERSION)
        : userSettings['subscription-ua'] || 'FlyClash';

      const response = await fetch(subUrl, {
        headers: {
          'User-Agent': userAgent
        }
      });

      if (!response.ok) {
        throw new Error(`获取订阅失败: ${response.statusText}`);
      }

      const subscriptionInfo = {
        usedTraffic: response.headers.get('subscription-userinfo-upload')
          ? formatTraffic(parseInt(response.headers.get('subscription-userinfo-upload') || '0'))
          : null,
        remainingTraffic: response.headers.get('subscription-userinfo-total')
          ? formatTraffic(
              parseInt(response.headers.get('subscription-userinfo-total') || '0') -
                parseInt(response.headers.get('subscription-userinfo-download') || '0') -
                parseInt(response.headers.get('subscription-userinfo-upload') || '0')
            )
          : null,
        expiryDate: response.headers.get('subscription-userinfo-expire')
          ? new Date(parseInt(response.headers.get('subscription-userinfo-expire') || '0') * 1000).toLocaleDateString()
          : null
      };

      const subUserInfo = response.headers.get('subscription-userinfo');
      if (subUserInfo) {
        const parts = subUserInfo.split(';').map((part) => part.trim());
        const info = {};
        for (const part of parts) {
          const [key, value] = part.split('=');
          if (!key || !value) continue;
          info[key] = parseInt(value, 10);
        }

        const upload = info.upload || 0;
        const download = info.download || 0;
        const total = info.total || 0;
        const expire = info.expire || 0;

        if (!subscriptionInfo.usedTraffic) {
          subscriptionInfo.usedTraffic = formatTraffic(upload + download);
        }
        if (!subscriptionInfo.remainingTraffic) {
          subscriptionInfo.remainingTraffic = formatTraffic(Math.max(0, total - upload - download));
        }
        if (!subscriptionInfo.expiryDate && expire) {
          subscriptionInfo.expiryDate = new Date(expire * 1000).toLocaleDateString();
        }
      }

      console.log('订阅流量信息:', subscriptionInfo);

      const content = await response.text();

      return {
        success: true,
        content,
        subscriptionInfo
      };
    } catch (error) {
      console.error('获取订阅内容失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  ipcMain.handle('refresh-subscription', async (event, filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error('订阅文件不存在');
      }

      const getSubscriptionUrlHandler = async (targetPath) => {
        try {
          const sub = dbManager.getSubscriptionByPath(targetPath);
          if (!sub || !sub.url) {
            return { success: false, error: '未找到对应的订阅URL。请尝试删除并重新添加订阅。' };
          }
          return { success: true, url: sub.url };
        } catch (error) {
          console.error('获取订阅URL失败:', error);
          return { success: false, error: error.message };
        }
      };

      const urlResult = await getSubscriptionUrlHandler(filePath);
      if (!urlResult.success || !urlResult.url) {
        return { success: false, error: urlResult.error || '无法获取订阅URL' };
      }

      const subUrl = urlResult.url;
      console.log(`准备刷新订阅: ${filePath}, URL: ${subUrl}`);

      const isLocalFile = subUrl.startsWith('local:');
      if (isLocalFile) {
        console.log('本地导入的配置文件不需要刷新');
        return { success: true, message: '本地导入的配置文件不需要刷新' };
      }

      let validUrl = subUrl.trim();
      if (!validUrl.match(/^https?:\/\//i)) {
        console.log('URL缺少协议前缀，自动添加https://');
        validUrl = 'https://' + validUrl;
      }

      new URL(validUrl);

      const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

      const userSettings = getUserSettings();
      const userAgent = context.security?.getSafeUserAgent
        ? context.security.getSafeUserAgent(userSettings['subscription-ua'], context.APP_VERSION)
        : userSettings['subscription-ua'] || 'FlyClash';

      console.log(`使用User-Agent: ${userAgent}`);
      console.log(`开始请求订阅内容: ${validUrl}`);

      context.security?.logSecurityEvent?.(
        'subscription-refresh',
        {
          url: validUrl,
          filePath,
          userAgent
        },
        path.join(context.userDataPath, 'security.log')
      );

      const response = await fetch(validUrl, {
        headers: {
          'User-Agent': userAgent
        }
      });

      if (!response.ok) {
        throw new Error(`获取订阅失败: ${response.statusText}`);
      }

      const subscriptionInfo = {
        usedTraffic: response.headers.get('subscription-userinfo-upload')
          ? formatTraffic(parseInt(response.headers.get('subscription-userinfo-upload') || '0'))
          : null,
        remainingTraffic: response.headers.get('subscription-userinfo-total')
          ? formatTraffic(
              parseInt(response.headers.get('subscription-userinfo-total') || '0') -
                parseInt(response.headers.get('subscription-userinfo-download') || '0') -
                parseInt(response.headers.get('subscription-userinfo-upload') || '0')
            )
          : null,
        expiryDate: response.headers.get('subscription-userinfo-expire')
          ? new Date(parseInt(response.headers.get('subscription-userinfo-expire') || '0') * 1000).toLocaleDateString()
          : null
      };

      const subUserInfo = response.headers.get('subscription-userinfo');
      if (subUserInfo) {
        const parts = subUserInfo.split(';').map((part) => part.trim());
        const info = {};
        for (const part of parts) {
          const [key, value] = part.split('=' );
          if (!key || !value) continue;
          info[key] = parseInt(value, 10);
        }

        const upload = info.upload || 0;
        const download = info.download || 0;
        const total = info.total || 0;
        const expire = info.expire || 0;

        if (!subscriptionInfo.usedTraffic) {
          subscriptionInfo.usedTraffic = formatTraffic(upload + download);
        }
        if (!subscriptionInfo.remainingTraffic) {
          subscriptionInfo.remainingTraffic = formatTraffic(Math.max(0, total - upload - download));
        }
        if (!subscriptionInfo.expiryDate && expire) {
          subscriptionInfo.expiryDate = new Date(expire * 1000).toLocaleDateString();
        }
      }

      console.log('订阅流量信息:', subscriptionInfo);

      const content = await response.text();

      const backupPath = `${filePath}.bak`;
      fs.copyFileSync(filePath, backupPath);

      fs.writeFileSync(filePath, content, 'utf8');
      console.log('订阅刷新成功:', filePath);

      // 保存订阅信息到数据库
      try {
        const usedTrafficBytes = parseTraffic(subscriptionInfo.usedTraffic);
        const remainingTrafficBytes = parseTraffic(subscriptionInfo.remainingTraffic);

        // 计算总流量 = 已用流量 + 剩余流量
        let totalTrafficBytes = null;
        if (usedTrafficBytes !== null && remainingTrafficBytes !== null) {
          totalTrafficBytes = usedTrafficBytes + remainingTrafficBytes;
        } else if (usedTrafficBytes !== null) {
          totalTrafficBytes = usedTrafficBytes;
        } else if (remainingTrafficBytes !== null) {
          totalTrafficBytes = remainingTrafficBytes;
        }

        const expiryTimestamp = subscriptionInfo.expiryDate ?
          new Date(subscriptionInfo.expiryDate).getTime() : null;

        dbManager.setSubscriptionInfoByPath(
          filePath,
          usedTrafficBytes,
          totalTrafficBytes,
          expiryTimestamp
        );
      } catch (error) {
        console.warn('保存订阅信息失败:', error);
      }

      return { success: true, filePath, subscriptionInfo };
    } catch (error) {
      console.error('刷新订阅失败:', error);

      const backupPath = `${filePath}.bak`;
      if (fs.existsSync(backupPath)) {
        try {
          fs.copyFileSync(backupPath, filePath);
          console.log('已从备份恢复原始文件');
        } catch (restoreError) {
          console.error('从备份恢复失败:', restoreError);
        }
      }

      return { success: false, error: error.message };
    }
  });

  /**
   * 解析流量字符串为字节数
   * 例如: "1.23 GB" -> 1320702443
   */
  function parseTraffic(trafficStr) {
    if (!trafficStr || typeof trafficStr !== 'string') {
      return null;
    }

    const match = trafficStr.match(/^([\d.]+)\s*([A-Z]+)$/i);
    if (!match) {
      return null;
    }

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    const units = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024,
      'TB': 1024 * 1024 * 1024 * 1024
    };

    const multiplier = units[unit];
    if (!multiplier) {
      return null;
    }

    return Math.floor(value * multiplier);
  }
};
