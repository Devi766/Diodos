# 自定义内核 + TUN 模式使用指南

## 功能说明

现在可以**同时使用自定义内核和TUN模式**，系统会自动处理内核同步。

## 工作原理

### 自动同步机制

```
用户自定义内核路径: /Users/xxx/my-mihomo/mihomo
                    ↓ 授权时复制
系统授权副本:       /Library/Application Support/Flycast/mihomo
                    ↓ TUN模式使用此副本（有root权限）
```

### 智能检测

每次开启TUN模式时，系统会自动检测：

1. **检查自定义内核是否更新**
   - 对比用户内核和系统副本的内容
   - 检测文件大小、修改时间

2. **自动同步**（如果安装了Service Mode）
   - 无需密码自动同步到系统目录
   - 更新授权权限

3. **提示用户**（如果未安装Service Mode）
   - 提示"检测到自定义内核已更新，请重新授权"
   - 点击授权按钮，输入1次密码即可

## 使用场景

### 场景1: 首次配置

**步骤：**
1. 在设置中配置自定义内核路径
   ```
   /Users/xxx/my-mihomo/mihomo
   ```

2. 点击"授权"按钮
   - 输入管理员密码（1次）
   - 系统自动复制到 `/Library/Application Support/Flycast/mihomo`
   - 自动设置root权限和setuid位

3. 开启TUN模式
   - 无需密码
   - 使用的是你自定义内核的授权副本

### 场景2: 更新自定义内核

**步骤：**
1. 更新你的自定义内核文件
   ```bash
   cp /path/to/new-mihomo /Users/xxx/my-mihomo/mihomo
   ```

2. 开启TUN模式

3. **如果安装了Service Mode：**
   - 自动检测更新 ✓
   - 自动同步到系统目录（无需密码）✓
   - 日志显示：`[TunManager] Custom kernel auto-synced`

4. **如果未安装Service Mode：**
   - 自动检测更新 ✓
   - 提示："检测到自定义内核已更新，请重新授权"
   - 点击授权，输入密码（1次）
   - 同步完成 ✓

### 场景3: 频繁更新内核（推荐Service Mode）

如果你经常更新自定义内核，建议安装Service Mode：

**一次性设置：**
```bash
# 在应用设置中点击"安装服务"
# 输入管理员密码（仅1次）
```

**后续更新内核：**
```bash
# 1. 更新自定义内核
cp /path/to/new-mihomo /Users/xxx/my-mihomo/mihomo

# 2. 开启TUN模式
# 自动同步，无需任何密码 ✓
```

## 内核选择逻辑

### TUN模式关闭

```javascript
使用: 用户自定义内核
路径: /Users/xxx/my-mihomo/mihomo
权限: 普通权限即可
```

### TUN模式开启

```javascript
使用: 系统授权副本（自定义内核的副本）
路径: /Library/Application Support/Flycast/mihomo
权限: root + setuid（创建TUN接口必需）
```

## 检测逻辑

系统通过以下方式检测内核更新：

```javascript
function checkKernelUpdate() {
  // 1. 对比文件内容（字节级对比）
  const sourceContent = fs.readFileSync(customKernelPath);
  const systemContent = fs.readFileSync(systemKernelPath);

  if (sourceContent.compare(systemContent) !== 0) {
    // 检测到更新
    return { needsUpdate: true };
  }

  return { needsUpdate: false };
}
```

## 日志说明

### 正常情况（内核未更新）

```
[TunManager] Toggling TUN to enabled, checking authorization...
[TunManager] Authorization probe result: { ok: true, issues: [] }
[TunManager] Authorization check passed, proceeding to enable TUN
```

### 检测到更新（有Service Mode）

```
[TunManager] Kernel update detected: {
  source: { path: '/Users/xxx/my-mihomo/mihomo', size: 20971520, mtime: ... },
  system: { path: '/Library/Application Support/Flycast/mihomo', size: 20971520, mtime: ... }
}
[TunManager] Auto-syncing custom kernel to system directory...
[TunManager] Using service mode for password-free sync
[TunManager] Kernel synced successfully via service
[TunManager] Custom kernel auto-synced
```

### 检测到更新（无Service Mode）

```
[TunManager] Kernel update detected: { ... }
[TunManager] Custom kernel updated, manual authorization required
UI提示: "检测到自定义内核已更新，请重新授权以同步到系统目录"
```

## 优势

### 方案对比

| 方案 | 使用体验 | 密码次数 | 自动同步 |
|------|---------|---------|---------|
| 不使用自定义内核 | 使用内置内核 | 第一次1次 | - |
| 自定义内核（无TUN） | 直接使用 | 0次 | 不需要 |
| 自定义内核+TUN（无Service） | 更新后需授权 | 每次更新1次 | ✗ |
| 自定义内核+TUN（有Service） | 完全自动 | 0次 | ✓ |

### 使用自定义内核的优势

1. **版本控制**
   - 可以使用特定版本的mihomo
   - 可以使用alpha/beta版本
   - 可以使用自己编译的版本

2. **快速更新**
   - 不需要等应用更新
   - 直接替换内核文件即可

3. **多配置测试**
   - 可以维护多个内核版本
   - 随时切换不同版本

## 故障排查

### 问题：TUN模式启动失败

**检查：**
```bash
# 1. 确认系统副本存在且已授权
ls -la "/Library/Application Support/Flycast/mihomo"
# 应显示: -rwsr-xr-x  1 root  wheel

# 2. 确认自定义内核路径正确
# 在应用设置中查看配置的路径

# 3. 查看应用日志
# 检查是否有权限错误
```

### 问题：更新内核后TUN模式不工作

**原因：** 系统副本未同步

**解决：**
1. 如果有Service Mode：重启应用，系统会自动同步
2. 如果无Service Mode：点击授权按钮重新授权

### 问题：每次更新都要输密码

**解决：** 安装Service Mode

```bash
# 在应用设置中
1. 点击"安装服务"
2. 输入管理员密码（仅1次）
3. 后续更新内核，开启TUN时自动同步，无需密码
```

## 最佳实践

### 推荐配置

```
自定义内核路径: /Users/xxx/.mihomo/mihomo
Service Mode: 已安装
TUN模式: 开启
```

### 更新流程

```bash
# 1. 下载新版mihomo
wget https://github.com/MetaCubeX/mihomo/releases/download/xxx/mihomo-darwin-amd64

# 2. 替换你的自定义内核
mv mihomo-darwin-amd64 /Users/xxx/.mihomo/mihomo
chmod +x /Users/xxx/.mihomo/mihomo

# 3. 在应用中开启TUN
# 系统自动检测更新并同步（无需密码）

# 4. 验证
ps aux | grep mihomo
# 确认使用的是系统副本
```

## 总结

通过自动检测和同步机制：

- ✅ **支持自定义内核**
- ✅ **支持TUN模式**
- ✅ **自动检测更新**
- ✅ **智能同步**（有Service Mode时无需密码）
- ✅ **友好提示**（无Service Mode时提示用户）

**两全其美：既能自定义内核，又能使用TUN模式！**
