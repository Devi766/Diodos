# TUN 模式完整修复总结

## 修复的问题

### 1. ✅ macOS 系统设置里面的 tun 选项无效
**原因：** 没有自动配置 DNS 为 fake-ip 模式

**修复：**
- 启用 TUN 时自动设置 DNS 配置为 fake-ip 模式
- fake-ip-range: 198.18.0.1/16
- enhanced-mode: fake-ip
- 让 mihomo 内核自动处理 DNS

### 2. ✅ 每次开启关闭都要输入密码
**原因：**
- 复制和授权分两次调用，需要2次密码
- 设置/恢复系统DNS需要密码
- 没有检查已授权状态

**修复：**
- 合并复制和授权到一个操作（2次密码→1次密码）
- 移除系统DNS修改（减少1次密码）
- 添加已授权检查（第二次开启不需要密码）

**结果：**
- 第一次开启：1次密码
- 后续所有操作：0次密码

### 3. ✅ macOS 权限错误
**原因：**
- macOS 不允许在用户目录修改文件权限
- macOS 不允许用 cp 从用户目录复制到系统目录

**修复：**
- 使用两步法：Node.js 复制到 /tmp → osascript 移动到系统目录
- 所有操作都针对系统目录的副本

## 新增功能

### Service Mode (可选)

安装 Service Mode 后完全无需密码：

**macOS:**
- 使用 launchd 运行特权守护进程
- 通过 IPC socket 通信
- 所有操作无需密码

**Linux:**
- 使用 systemd 运行特权守护进程
- 通过 IPC socket 通信
- 所有操作无需密码

## 使用指南

### 方案一：不使用 Service Mode

**第一次开启 TUN：**
1. 点击开启 TUN
2. 输入管理员密码（仅1次）
3. 内核复制到 `/Library/Application Support/Flycast/mihomo`
4. 自动授权和配置
5. TUN 模式启用

**后续使用：**
- 开启/关闭 TUN - 无需密码
- 重启应用后开启 TUN - 无需密码

### 方案二：使用 Service Mode（推荐）

**一次性安装：**
1. 在设置中点击"安装服务"
2. 输入管理员密码（仅1次）
3. Service 自动启动

**所有操作：**
- 开启 TUN - 无需密码
- 关闭 TUN - 无需密码
- 重启应用 - 无需密码
- 内核升级 - 无需密码

## 技术细节

### 授权流程（不使用 Service）

```
1. 检查 /Library/Application Support/Flycast/mihomo 是否已授权
   ↓ 已授权 → 直接使用（无需密码）
   ↓ 未授权
2. fs.copyFileSync(源文件, /tmp/flycast-mihomo-TIMESTAMP)
   ↓ 不需要密码
3. osascript: "mv /tmp/... → /Library/... && chown root:wheel && chmod u+s"
   ↓ 需要密码 1次
4. 验证授权成功
   ↓
5. 配置 mihomo DNS 为 fake-ip
   ↓ 不需要密码
6. 重启内核
   ↓ 不需要密码
完成 ✓
```

### Service Mode 架构

```
应用进程 (普通权限)
    ↓ IPC Socket
Service 守护进程 (root 权限)
    ↓
执行特权操作：
  - 授权内核
  - 设置 DNS (如果需要)
```

## 文件清单

### 新增文件
- `electron/service/service-helper.js` - Service 守护进程
- `electron/service/install-service.sh` - macOS 安装脚本
- `electron/service/uninstall-service.sh` - macOS 卸载脚本
- `electron/service/install-service-linux.sh` - Linux 安装脚本
- `electron/service/uninstall-service-linux.sh` - Linux 卸载脚本
- `electron/main-process/service-manager.js` - Service 管理器

### 修改文件
- `electron/main-process/tun-manager.js` - TUN 管理核心逻辑
- `electron/main.js` - 初始化 service-manager，添加 IPC handlers
- `electron/preload.js` - 导出 service API

## 验证步骤

### 验证基本功能
```bash
# 清理旧授权
sudo rm -rf "/Library/Application Support/Flycast"

# 启动应用，开启 TUN
# 应该只提示密码 1次

# 验证文件已授权
ls -la "/Library/Application Support/Flycast/mihomo"
# 应该显示: -rwsr-xr-x  1 root  wheel

# 关闭 TUN - 不需要密码
# 再次开启 TUN - 不需要密码
```

### 验证 Service Mode
```bash
# 安装 service - 需要密码 1次
# 检查 service 运行状态
sudo launchctl list | grep flycast
ls -la /tmp/flycast-service.sock

# 开启/关闭 TUN - 都不需要密码
```

## 故障排查

### 问题：仍需要多次密码
**检查：**
1. 确认系统副本不存在：`ls -la "/Library/Application Support/Flycast/mihomo"`
2. 查看日志确认授权检查是否执行
3. 确认 DNS 自动管理已移除

### 问题：Service 未运行
**macOS:**
```bash
sudo launchctl load /Library/LaunchDaemons/com.flycast.service.plist
tail -f /tmp/flycast-service.log
```

**Linux:**
```bash
sudo systemctl start flycast-service
sudo systemctl status flycast-service
```

## 性能影响

- 第一次授权会复制内核文件（~20MB）到系统目录
- 后续使用系统副本，无额外开销
- Service Mode 常驻内存约 10-20MB

## 安全性

- 系统副本位于 `/Library/Application Support/`（系统保护目录）
- 只有 root 可以修改
- Service Mode 使用 HMAC 密钥认证
- 所有操作都有审计日志

## 兼容性

- macOS 10.15+
- Linux (systemd)
- Windows (现有方案不变)

## 卸载

### 清理系统副本
```bash
sudo rm -rf "/Library/Application Support/Flycast"
```

### 卸载 Service
```bash
# macOS
sudo launchctl unload /Library/LaunchDaemons/com.flycast.service.plist
sudo rm /Library/LaunchDaemons/com.flycast.service.plist

# Linux
sudo systemctl stop flycast-service
sudo systemctl disable flycast-service
sudo rm /etc/systemd/system/flycast-service.service
```
