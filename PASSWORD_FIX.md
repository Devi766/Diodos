# 密码输入次数修复

## 问题

用户报告开启 TUN 模式需要输入 3 次密码：
1. 复制文件到系统目录 - 1次密码
2. 授权文件 - 1次密码
3. 设置系统DNS - 1次密码

关闭 TUN 也需要密码（恢复DNS），再次开启还需要密码。

## 修复

### 1. 合并复制和授权操作（减少2次密码到1次）

**之前：**
```javascript
// 第一个 osascript 调用 - 需要密码
await execFilePromise('osascript', ['-e', moveScript]);

// 第二个 osascript 调用 - 需要密码
await execFilePromise('osascript', ['-e', authScript]);
```

**现在：**
```javascript
// 单个 osascript 调用 - 只需要1次密码
const combinedScript = `do shell script "
  mkdir -p '${escTargetDir}' &&
  mv -f '${escTmp}' '${escTarget}' &&
  xattr -d com.apple.quarantine '${escTarget}' 2>/dev/null || true &&
  chown root:wheel '${escTarget}' &&
  chmod u+s '${escTarget}'
" with administrator privileges`;
await execFilePromise('osascript', ['-e', combinedScript]);
```

### 2. 检查已授权状态（第二次开启不需要密码）

**新增检查：**
```javascript
const existingProbe = await probeAuthorization(systemPath);
if (existingProbe.ok) {
  console.log('[TunManager] System kernel already authorized, no password needed');
  return { success: true, message: 'Kernel already authorized' };
}
```

如果系统副本已经授权（第一次已完成），直接返回成功，不需要密码。

### 3. 移除系统DNS管理（减少1次密码）

**移除的代码：**
```javascript
// 移除 - 这需要密码
await setSystemDns('223.6.6.6');

// 移除 - 这也需要密码
await restoreSystemDns();
```

**原因：**
- mihomo 的 TUN 模式会自动处理 DNS
- 不需要手动修改系统 DNS 设置
- 避免需要管理员权限的操作

**保留的配置：**
```javascript
// 保留 - 配置 mihomo 使用 fake-ip
updatePayload.dns = {
  enable: true,
  ipv6: ipv6,
  'enhanced-mode': 'fake-ip',
  'fake-ip-range': '198.18.0.1/16',
  ...currentDns
};
```

## 修复后的密码需求

### 第一次开启 TUN：
1. 复制到 /tmp - **不需要密码**
2. 移动+授权 - **需要密码 1次** ✓
3. 配置 DNS - **不需要密码**
4. 重启内核 - **不需要密码**

**总计：1次密码**

### 第二次开启 TUN：
1. 检查已授权 - **不需要密码**
2. 直接使用 - **不需要密码**

**总计：0次密码**

### 关闭 TUN：
1. 停止内核 - **不需要密码**

**总计：0次密码**

### 再次开启 TUN：
1. 检查已授权 - **不需要密码**
2. 直接使用 - **不需要密码**

**总计：0次密码**

## 建议

如果想完全避免密码输入，建议安装 Service Mode：

```bash
# 安装 service（需要密码1次）
# 在设置中点击"安装服务"

# 之后所有操作都无需密码：
- 开启 TUN - 无需密码
- 关闭 TUN - 无需密码
- 再次开启 - 无需密码
```

Service Mode 会在后台持久运行，通过 IPC 与应用通信，所有特权操作都由 service 处理。

## 验证

测试步骤：
1. 清理旧的授权：`sudo rm -rf "/Library/Application Support/Flycast"`
2. 启动应用
3. 开启 TUN - 应该只提示输入密码 **1次**
4. 关闭 TUN - **不需要密码**
5. 再次开启 TUN - **不需要密码**
6. 多次开关 TUN - 都**不需要密码**

## 文件修改

- `electron/main-process/tun-manager.js`
  - 合并复制和授权到一个 osascript 调用
  - 添加已授权状态检查
  - 移除系统 DNS 管理代码
