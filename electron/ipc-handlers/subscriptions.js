module.exports = function registerSubscriptionHandlers(context) {
  const {
    ipcMain,
    fs,
    path,
    configDir,
    formatTraffic,
    getUserSettings,
    yaml
  } = context;

  ipcMain.handle('save-subscription', async (event, url, content, customName, subscriptionInfo) => {
    try {
      console.log('保存订阅:', { url, customName });

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      let fileName;
      let urlRecordName;

      if (customName) {
        const sanitized = customName.replace(/[/\\?%*:|"<>]/g, '_');
        fileName = `${sanitized}.yaml`;
        urlRecordName = `${sanitized}.yaml`;
      } else if (url) {
        const urlObj = new URL(url);
        const host = urlObj.hostname.replace(/[/\\?%*:|"<>]/g, '_');
        const timestamp = Date.now();
        fileName = `${host}_${timestamp}.yaml`;
        urlRecordName = fileName;
      } else {
        fileName = `subscription_${Date.now()}.yaml`;
        urlRecordName = fileName;
      }

      const filePath = path.join(configDir, fileName);

      if (url) {
        try {
          const urlsPath = path.join(configDir, 'subscription_urls.json');
          let urlsData = {};

          if (fs.existsSync(urlsPath)) {
            urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
          }

          urlsData[urlRecordName] = url;
          fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2));
        } catch (error) {
          console.warn('保存订阅URL记录失败:', error);
        }
      }

      fs.writeFileSync(filePath, content, 'utf8');

      if (subscriptionInfo) {
        try {
          const infoPath = path.join(configDir, 'subscription_info.json');
          let infoData = {};

          if (fs.existsSync(infoPath)) {
            infoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          }

          infoData[fileName] = {
            ...subscriptionInfo,
            lastUpdated: new Date().toISOString()
          };

          fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2));
        } catch (error) {
          console.warn('保存订阅信息记录失败:', error);
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
      if (!fs.existsSync(configDir)) {
        return [];
      }

      const files = fs.readdirSync(configDir).filter((file) => file.endsWith('.yaml'));

      let subscriptionInfoData = {};
      const infoPath = path.join(configDir, 'subscription_info.json');
      if (fs.existsSync(infoPath)) {
        try {
          subscriptionInfoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        } catch (e) {
          console.error('读取订阅信息记录失败:', e);
        }
      }

      return files.map((file) => {
        const info = subscriptionInfoData[file] || {};
        return {
          name: file.replace(/\.yaml$/, ''),
          path: path.join(configDir, file),
          usedTraffic: info.usedTraffic || null,
          remainingTraffic: info.remainingTraffic || null,
          expiryDate: info.expiryDate || null,
          lastUpdated: info.lastUpdated ? new Date(info.lastUpdated).toLocaleString() : null
        };
      });
    } catch (error) {
      console.error('获取订阅列表失败:', error);
      return [];
    }
  });

  ipcMain.handle('delete-subscription', (event, filePath) => {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      console.error(`Failed to delete ${filePath}:`, error);
      return false;
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
          const urlsPath = path.join(configDir, 'subscription_urls.json');
          if (!fs.existsSync(urlsPath)) {
            fs.writeFileSync(urlsPath, JSON.stringify({}, null, 2), 'utf8');
            return { success: false, error: '未找到订阅URL记录。这可能是因为此订阅是在旧版本添加的，请尝试删除并重新添加订阅。' };
          }

          const urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
          const fileName = path.basename(targetPath);

          let url = urlsData[fileName];
          if (!url) {
            const fileNameOnly = fileName.replace(/\.yaml$/, '');
            for (const [key, value] of Object.entries(urlsData)) {
              const keyWithoutExt = key.replace(/\.yaml$/, '');
              if (keyWithoutExt === fileNameOnly) {
                url = value;
                urlsData[fileName] = value;
                fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2));
                break;
              }
            }
          }

          if (!url) {
            return { success: false, error: '未找到对应的订阅URL。请尝试删除并重新添加订阅。' };
          }

          return { success: true, url };
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

      try {
        const infoPath = path.join(configDir, 'subscription_info.json');
        let infoData = {};
        if (fs.existsSync(infoPath)) {
          infoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        }

        infoData[path.basename(filePath)] = {
          ...subscriptionInfo,
          lastUpdated: new Date().toISOString()
        };

        fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2));
      } catch (error) {
        console.warn('保存订阅信息记录失败:', error);
      }

      try {
        const infoPathPlural = path.join(configDir, 'subscriptions_info.json');
        fs.writeFileSync(infoPathPlural, fs.readFileSync(path.join(configDir, 'subscription_info.json')));
      } catch (e) {
        console.warn('保存subscriptions_info.json失败:', e);
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
};
