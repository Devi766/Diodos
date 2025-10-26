# 备份与还原功能实现说明

## 功能概述

FlyClash PC 现已支持与安卓端兼容的备份与还原功能，实现跨平台配置共享。

### 主要特性

1. **本地备份与还原**
   - 支持配置仅备份（CONFIG_ONLY）
   - 支持全量备份（FULL_BACKUP，包含所有设置）
   - 备份格式：ZIP压缩包，内含JSON数据
   - 与安卓端完全兼容

2. **WebDAV云备份**
   - 自动上传备份到WebDAV服务器
   - 支持从WebDAV下载并还原备份
   - 列出、删除远程备份
   - 实时进度显示

3. **跨平台兼容**
   - 桌面端可以还原安卓端的备份
   - 安卓端可以还原桌面端的备份
   - 统一的JSON数据结构

## 安装依赖

在 `flycast-ui` 目录下运行以下命令安装必要的npm包：

```bash
cd flycast-ui
npm install webdav adm-zip uuid
```

### 依赖包说明

- **webdav**: WebDAV客户端库，用于与WebDAV服务器通信
- **adm-zip**: ZIP文件处理库，用于创建和解压备份文件
- **uuid**: UUID生成库，用于配置唯一标识

## 文件结构

```
flycast-ui/electron/
├── backup/
│   ├── backup-types.js          # 备份数据类型定义（与安卓端兼容）
│   ├── backup-manager.js        # 备份管理器核心逻辑
│   └── webdav-client.js         # WebDAV客户端实现
├── ipc-handlers/
│   └── backup.js                # 备份相关IPC处理器
└── preload.js                   # 添加了备份API定义
```

## 数据结构

### 备份数据格式（与安卓端兼容）

```javascript
{
  "version": "1.2",
  "timestamp": 1704067200000,
  "backupType": "FULL_BACKUP",
  "activeProfile": "uuid-of-active-config",
  "importedProfiles": [
    {
      "uuid": "config-uuid",
      "name": "我的配置",
      "type": "URL",
      "source": "https://example.com/config.yaml",
      "interval": 86400,
      "upload": 0,
      "download": 0,
      "total": 10737418240,
      "expire": 1735689600000,
      "iconUrl": "",
      "createdAt": 1704067200000,
      "configContent": "# config.yaml content...",
      "providersContent": {}
    }
  ],
  "selections": [],
  "proxyIconConfig": null,
  "serviceSettings": null,
  "uiSettings": {
    "darkMode": "Auto",
    "userAgent": "FlyClash/Desktop/1.0.0"
  },
  "webDAVSettings": {
    "uri": "https://dav.example.com",
    "username": "user",
    "password": "pass",
    "backupDirectory": "FlyClash",
    "fileName": "flyclash_backup.zip"
  },
  "dashboardConfig": null,
  "trafficData": null,
  "overrideSettings": null
}
```

## API使用

### 前端调用示例

```typescript
// 创建本地备份
const result = await window.electronAPI.backupCreateLocal('FULL_BACKUP');
if (result.success) {
  console.log('备份已保存到:', result.filePath);
}

// 还原本地备份
const restoreResult = await window.electronAPI.backupRestoreLocal();

// 测试WebDAV连接
const testResult = await window.electronAPI.backupWebDAVTest({
  uri: 'https://dav.example.com',
  username: 'user',
  password: 'password',
  backupDirectory: 'FlyClash',
  fileName: 'flyclash_backup.zip'
});

// 上传到WebDAV
const uploadResult = await window.electronAPI.backupWebDAVUpload('CONFIG_ONLY');

// 从WebDAV下载并还原
const downloadResult = await window.electronAPI.backupWebDAVDownload();

// 列出WebDAV上的备份
const listResult = await window.electronAPI.backupWebDAVList();
console.log('远程备份:', listResult.backups);
```

## 跨平台兼容性

### 桌面端 → 安卓端

桌面端创建的备份可以直接在安卓端还原：
1. 桌面端创建备份（本地或WebDAV）
2. 将ZIP文件传输到安卓设备或使用WebDAV同步
3. 在安卓端的备份设置中选择还原

### 安卓端 → 桌面端

安卓端创建的备份可以直接在桌面端还原：
1. 安卓端创建备份（本地或WebDAV）
2. 将ZIP文件传输到桌面或使用WebDAV同步
3. 在桌面端的设置中选择还原备份

## 数据映射

### 配置文件映射

| 安卓端 | 桌面端 | 说明 |
|--------|--------|------|
| importedProfiles | subscriptions | 配置文件列表 |
| activeProfile (UUID) | configFilePath | 当前激活的配置 |
| configContent | .yaml文件 | 配置文件内容 |
| providersContent | providers/* | Provider文件 |

### 设置映射

| 安卓端 | 桌面端 | 说明 |
|--------|--------|------|
| uiSettings.darkMode | theme设置 | 主题模式 |
| webDAVSettings | webdav_*设置 | WebDAV配置 |
| dashboardConfig | dashboard_config | 仪表板布局 |
| overrideSettings | override设置 | 覆盖配置 |

## WebDAV服务器推荐

支持的WebDAV服务器：
- **坚果云**：https://dav.jianguoyun.com/dav/
- **Nextcloud**：自托管云存储
- **ownCloud**：自托管云存储
- **Seafile**：自托管云存储
- **Synology NAS**：群晖NAS的WebDAV功能

## 注意事项

1. **备份文件安全**
   - 备份文件包含完整的配置信息（包括订阅链接）
   - 如果是全量备份，还包含所有设置和WebDAV密码
   - 请妥善保管备份文件，不要分享给他人

2. **WebDAV密码存储**
   - WebDAV密码以明文形式存储在数据库中
   - 建议使用应用专用密码而不是主密码

3. **还原前建议**
   - 还原备份会覆盖现有配置
   - 建议在还原前先创建当前配置的备份

4. **版本兼容性**
   - 当前支持备份版本：1.2
   - 向后兼容旧版本的备份格式
   - 未来版本会持续保持兼容性

## 开发说明

### 添加新的备份字段

1. 在 `backup-types.js` 中添加新的字段定义
2. 在 `backup-manager.js` 中实现备份和还原逻辑
3. 确保与安卓端的字段保持一致
4. 更新本文档

### 测试

建议测试场景：
- [ ] 创建配置仅备份，还原验证
- [ ] 创建全量备份，还原验证
- [ ] WebDAV上传下载测试
- [ ] 跨平台备份还原测试（桌面端 ↔ 安卓端）
- [ ] 大文件备份测试（>10MB）
- [ ] 网络异常处理测试

## 故障排除

### WebDAV连接失败

1. 检查URI格式是否正确（需要包含https://）
2. 验证用户名和密码是否正确
3. 检查防火墙设置
4. 某些WebDAV服务器需要应用专用密码

### 备份文件损坏

1. 检查ZIP文件是否完整
2. 尝试手动解压查看backup.json
3. 确认文件没有在传输过程中损坏

### 还原失败

1. 检查备份版本是否兼容
2. 查看控制台日志获取详细错误信息
3. 确认配置目录有写入权限

## 后续改进计划

- [ ] 支持增量备份
- [ ] 备份文件加密
- [ ] 定时自动备份
- [ ] 备份历史管理
- [ ] 选择性还原（只还原部分配置）
- [ ] 备份压缩优化
