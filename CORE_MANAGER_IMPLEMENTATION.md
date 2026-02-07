# 内核管理系统实现文档

## 概述

参考 Clash Party 的实现，为 FlyClash 添加了完整的内核版本管理和切换功能，支持多内核类型、自动更新检测、下载管理等功能。

## 功能特性

### 1. 多内核支持

支持以下内核类型：

- **Mihomo 稳定版** (`mihomo`)
  - 来源：MetaCubeX/mihomo Latest Release
  - 适用场景：日常使用，稳定可靠

- **Mihomo Alpha 版** (`mihomo-alpha`)
  - 来源：MetaCubeX/mihomo Prerelease-Alpha
  - 适用场景：体验最新特性

- **Mihomo Smart 内核** (`mihomo-smart`)
  - 来源：vernesong/mihomo
  - 特性：支持 AI 智能节点选择

- **指定版本** (`mihomo-specific`)
  - 支持用户指定特定版本的内核

### 2. 核心功能

#### 内核管理
- ✅ 查看当前使用的内核类型和版本
- ✅ 查看已安装的内核列表
- ✅ 下载新内核（支持进度显示）
- ✅ 切换内核类型
- ✅ 删除不需要的内核
- ✅ 检查内核更新

#### 自动化功能
- ✅ 自动检测当前内核版本
- ✅ 一键检查更新
- ✅ 下载进度实时显示
- ✅ 切换内核后自动重启服务

#### 跨平台支持
- ✅ Windows (x64, ia32, arm64)
- ✅ macOS (x64, arm64)
- ✅ Linux (x64, arm64)

## 技术实现

### 1. 架构设计

```
electron/main-process/core-manager.js    # 内核管理核心模块
├── CoreManager 类
│   ├── 内核配置管理
│   ├── 内核路径解析
│   ├── 版本检测
│   ├── GitHub Release 获取
│   ├── 内核下载
│   ├── 内核切换
│   └── 内核删除
```

### 2. 数据库字段

在 SQLite 数据库中添加以下设置字段：

- `core_type`: 当前内核类型 (mihomo/mihomo-alpha/mihomo-smart/mihomo-specific)
- `core_specific_version`: 指定版本号（仅用于 mihomo-specific）
- `core_custom_path`: 自定义内核路径

### 3. IPC 接口

#### 主进程 (main.js)

```javascript
// 获取当前内核配置
ipcMain.handle('core:get-current-config', async () => {...})

// 获取已安装的内核列表
ipcMain.handle('core:get-installed-cores', async () => {...})

// 检查内核更新
ipcMain.handle('core:check-update', async (event, coreType) => {...})

// 下载内核
ipcMain.handle('core:download-core', async (event, coreType) => {...})

// 切换内核
ipcMain.handle('core:switch-core', async (event, coreType, specificVersion) => {...})

// 删除内核
ipcMain.handle('core:delete-core', async (event, corePath) => {...})

// 设置自定义内核路径
ipcMain.handle('core:set-custom-path', async (event, customPath) => {...})
```

#### 渲染进程 (preload.js)

```javascript
window.electronAPI = {
  // 内核管理 API
  coreGetCurrentConfig: () => ipcRenderer.invoke('core:get-current-config'),
  coreGetInstalledCores: () => ipcRenderer.invoke('core:get-installed-cores'),
  coreCheckUpdate: (coreType) => ipcRenderer.invoke('core:check-update', coreType),
  coreDownloadCore: (coreType) => ipcRenderer.invoke('core:download-core', coreType),
  coreSwitchCore: (coreType, specificVersion) => ipcRenderer.invoke('core:switch-core', coreType, specificVersion),
  coreDeleteCore: (corePath) => ipcRenderer.invoke('core:delete-core', corePath),
  coreSetCustomPath: (customPath) => ipcRenderer.invoke('core:set-custom-path', customPath),
  onCoreDownloadProgress: (callback) => {...}
}
```

### 4. UI 组件

#### CoreManager.tsx

React 组件，提供完整的内核管理界面：

- 当前内核信息展示
- 内核类型选择卡片
- 下载进度显示
- 更新检查结果
- 已安装内核列表

### 5. 内核存储路径

```
{userData}/cores/
├── mihomo.exe              # 稳定版
├── mihomo-alpha.exe        # Alpha 版
├── mihomo-smart.exe        # Smart 内核
└── mihomo-{version}.exe    # 指定版本
```

## 使用流程

### 用户操作流程

1. **查看当前内核**
   - 打开设置 → 内核标签页
   - 查看当前使用的内核类型和版本

2. **下载新内核**
   - 选择想要的内核类型
   - 点击"下载"按钮
   - 等待下载完成（显示进度）

3. **切换内核**
   - 在已下载的内核中选择
   - 点击"切换"按钮
   - 系统自动重启内核服务

4. **检查更新**
   - 点击"检查更新"按钮
   - 查看是否有新版本
   - 一键下载更新

5. **删除内核**
   - 在已安装列表中找到不需要的内核
   - 点击"删除"按钮
   - 确认删除（当前使用的内核无法删除）

### 技术流程

1. **内核查找优先级**
   ```
   1. TUN 模式授权内核（macOS/Linux）
   2. CoreManager 管理的内核
   3. 用户自定义路径
   4. 默认内核路径
   5. 开发环境/生产环境回退路径
   ```

2. **内核下载流程**
   ```
   1. 获取 GitHub Release 信息
   2. 根据平台和架构筛选 asset
   3. 下载压缩包（.gz 或 .zip）
   4. 解压到 cores 目录
   5. 设置执行权限（Unix）
   6. 更新内核列表
   ```

3. **内核切换流程**
   ```
   1. 检查目标内核是否存在
   2. 保存内核配置到数据库
   3. 停止当前运行的内核
   4. 使用新内核路径启动
   5. 更新 UI 状态
   ```

## 国际化支持

### 中文翻译 (zh-CN.json)

```json
{
  "core": {
    "currentCore": "当前内核",
    "type": "类型",
    "version": "版本",
    "stable": "稳定版",
    "alpha": "Alpha 预发布版",
    "smart": "Smart 智能内核",
    "checkUpdate": "检查更新",
    "download": "下载",
    "switch": "切换",
    "delete": "删除"
  }
}
```

### 英文翻译 (en-US.json)

```json
{
  "core": {
    "currentCore": "Current Kernel",
    "type": "Type",
    "version": "Version",
    "stable": "Stable",
    "alpha": "Alpha Prerelease",
    "smart": "Smart Kernel",
    "checkUpdate": "Check Update",
    "download": "Download",
    "switch": "Switch",
    "delete": "Delete"
  }
}
```

## 文件清单

### 新增文件

1. `electron/main-process/core-manager.js` - 内核管理核心模块
2. `src/components/CoreManager.tsx` - 内核管理 UI 组件
3. `CORE_MANAGER_IMPLEMENTATION.md` - 本文档

### 修改文件

1. `electron/main.js` - 添加 IPC 处理程序
2. `electron/preload.js` - 暴露内核管理 API
3. `electron/main-process/mihomo-service.js` - 修改内核查找逻辑
4. `src/components/Settings.tsx` - 集成 CoreManager 组件
5. `src/types/electron.d.ts` - 添加类型定义
6. `src/i18n/locales/zh-CN.json` - 添加中文翻译
7. `src/i18n/locales/en-US.json` - 添加英文翻译

## 依赖项

所有必需的依赖项已存在于项目中：

- `adm-zip`: ^0.5.16 - 用于解压 .zip 文件
- `https`: Node.js 内置 - 用于下载文件
- `better-sqlite3`: 已存在 - 用于数据库操作

## 安全考虑

1. **下载验证**
   - 仅从官方 GitHub Releases 下载
   - 使用 HTTPS 确保传输安全

2. **权限管理**
   - Unix 系统自动设置执行权限 (0o755)
   - Windows 无需额外权限设置

3. **路径安全**
   - 所有内核存储在用户数据目录
   - 防止路径遍历攻击

4. **错误处理**
   - 完善的错误捕获和提示
   - 下载失败自动清理临时文件

## 测试建议

### 功能测试

1. **内核下载测试**
   - [ ] 测试稳定版下载
   - [ ] 测试 Alpha 版下载
   - [ ] 测试 Smart 内核下载
   - [ ] 测试下载进度显示
   - [ ] 测试下载失败处理

2. **内核切换测试**
   - [ ] 测试切换到不同内核类型
   - [ ] 测试切换后服务自动重启
   - [ ] 测试切换失败回滚

3. **更新检查测试**
   - [ ] 测试有更新时的提示
   - [ ] 测试已是最新版本的提示
   - [ ] 测试网络错误处理

4. **内核删除测试**
   - [ ] 测试删除未使用的内核
   - [ ] 测试无法删除当前使用的内核
   - [ ] 测试删除确认对话框

### 跨平台测试

- [ ] Windows 10/11 (x64)
- [ ] macOS (Intel)
- [ ] macOS (Apple Silicon)
- [ ] Linux (Ubuntu/Debian)

### 边界情况测试

- [ ] 网络断开时的行为
- [ ] 磁盘空间不足时的处理
- [ ] GitHub API 限流处理
- [ ] 并发下载处理

## 未来改进方向

1. **功能增强**
   - [ ] 支持内核版本历史记录
   - [ ] 支持内核配置文件管理
   - [ ] 支持内核性能监控
   - [ ] 支持内核日志分析

2. **用户体验**
   - [ ] 添加内核对比功能
   - [ ] 添加内核推荐系统
   - [ ] 优化下载速度（镜像源）
   - [ ] 添加下载暂停/恢复功能

3. **技术优化**
   - [ ] 实现增量更新
   - [ ] 添加内核签名验证
   - [ ] 优化内核存储空间
   - [ ] 实现内核缓存机制

## 常见问题

### Q: 如何回退到旧版本内核？

A: 如果之前下载过旧版本，可以在"已安装的内核"列表中直接切换。如果已删除，需要重新下载。

### Q: 内核下载失败怎么办？

A: 检查网络连接，确保可以访问 GitHub。如果问题持续，可以手动下载内核并使用"自定义内核路径"功能。

### Q: Smart 内核和普通内核有什么区别？

A: Smart 内核来自 vernesong/mihomo，支持基于 AI 模型的智能节点选择功能，可以自动选择最优节点。

### Q: 可以同时安装多个内核吗？

A: 可以。系统支持同时安装多个不同类型的内核，并可以随时切换。

### Q: 切换内核会影响现有配置吗？

A: 不会。切换内核只改变内核程序本身，所有配置文件、订阅、覆写等设置都会保留。

## 贡献指南

如需改进内核管理功能，请遵循以下步骤：

1. Fork 项目仓库
2. 创建功能分支
3. 提交代码并编写测试
4. 提交 Pull Request

## 许可证

本功能遵循 FlyClash 项目的许可证。

## 联系方式

- GitHub Issues: https://github.com/FlyClash/FlyClash/issues
- Telegram 群组: [链接]

---

**版本**: 1.0.0
**最后更新**: 2026-02-06
**作者**: FlyClash Team
