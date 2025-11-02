# TUN 模式内核路径修复

## 问题

开启 TUN 模式后没有效果，自定义的网卡名字没有出现。

### 根本原因

mihomo 启动时使用的是**未授权的原始内核**，而不是**已授权的系统副本**。

未授权的内核没有 root 权限和 setuid 位，无法创建 TUN 接口。

## 修复

修改 `electron/main-process/mihomo-service.js` 中的 `findMihomoExecutable()` 函数。

### 修改前

```javascript
function findMihomoExecutable() {
  // 直接返回用户目录的内核
  const preferredPath = context.getKernelExecutablePath();
  return preferredPath;
}
```

这会返回类似：
```
/Users/none/Documents/flyclash-pc/flycast-ui/extra/sidecar/mihomo
```

这个文件**没有** root 权限，**无法**创建 TUN 接口。

### 修改后

```javascript
function findMihomoExecutable() {
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  // 优先检查系统授权内核
  if (isMac || isLinux) {
    if (context.tunManager && typeof context.tunManager.getKernelPath === 'function') {
      const systemKernel = context.tunManager.getKernelPath();
      if (systemKernel && fs.existsSync(systemKernel)) {
        const stat = fs.statSync(systemKernel);
        const mode = stat.mode & 0o7777;
        const isSetuid = !!(mode & 0o4000);
        if (stat.uid === 0 && isSetuid) {
          console.log('[MihomoService] Using authorized system kernel:', systemKernel);
          return systemKernel;
        }
      }
    }
  }

  // 降级：使用原始内核（不能用于 TUN）
  const preferredPath = context.getKernelExecutablePath();
  return preferredPath;
}
```

现在会优先返回：
```
/Library/Application Support/Flycast/mihomo
```

这个文件**有** root 权限和 setuid 位，**可以**创建 TUN 接口。

## 工作流程

### 1. 授权阶段（点击授权按钮）

```
源文件: /Users/none/Documents/.../mihomo
           ↓ 复制到 /tmp
/tmp/flycast-mihomo-1234567890
           ↓ osascript 移动+授权
/Library/Application Support/Flycast/mihomo
  权限: -rwsr-xr-x  1 root  wheel
        ^^^
        setuid 位
```

### 2. 启动 TUN 模式

```
toggleTun(true)
  ↓ 保存 TUN 配置
  ↓ 调用 restartMihomo()
  ↓ restartMihomo() 调用 startMihomo()
  ↓ startMihomo() 调用 findMihomoExecutable()
  ↓ findMihomoExecutable() 返回系统授权内核
  ↓ 使用系统授权内核启动 mihomo
  ↓ mihomo 有 root 权限
  ↓ 成功创建 TUN 接口 ✓
```

### 3. 验证

```bash
# 检查进程使用的内核
ps aux | grep mihomo

# 应该看到:
/Library/Application Support/Flycast/mihomo -d ...

# 而不是:
/Users/none/Documents/.../mihomo -d ...
```

```bash
# 检查 TUN 接口
ifconfig | grep utun

# 应该看到:
utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
```

## 关于自定义网卡名字

### macOS

在 macOS 上，`device: utun` 是一个**前缀**，不是精确的接口名。

系统会自动分配编号，如：
- utun0 (系统保留)
- utun1 (系统保留)
- utun2 (可能被 VPN 使用)
- utun3 (mihomo 创建) ✓
- utun4, utun5, ...

**这是正常行为**，不影响功能。即使你配置了 `device: utun`，实际接口可能是 `utun3`。

如果你想指定编号：
```yaml
tun:
  device: utun5
```

但系统仍可能分配其他可用编号。

### Linux

在 Linux 上可以使用任意名字：
```yaml
tun:
  device: mihomo
```

这会创建名为 `mihomo` 的接口。

## 测试步骤

1. **清理旧授权**（如果之前授权过）：
   ```bash
   sudo rm -rf "/Library/Application Support/Flycast"
   ```

2. **启动应用，授权内核**：
   - 点击授权按钮
   - 输入密码（1次）
   - 等待授权完成

3. **验证授权成功**：
   ```bash
   ls -la "/Library/Application Support/Flycast/mihomo"
   # 应显示: -rwsr-xr-x  1 root  wheel
   ```

4. **开启 TUN 模式**：
   - 在设置中开启 TUN
   - 不需要密码

5. **验证内核路径**：
   - 查看应用日志，应该看到：
     ```
     [MihomoService] Using authorized system kernel: /Library/Application Support/Flycast/mihomo
     ```

6. **验证 TUN 接口**：
   ```bash
   ifconfig | grep utun
   # 应该看到 mihomo 创建的接口
   ```

7. **测试连接**：
   ```bash
   curl -v http://example.com
   # 流量应该经过 TUN 接口
   ```

## 故障排查

### 问题：日志显示使用的是原始内核
```
[MihomoService] Using preferred kernel: /Users/none/Documents/.../mihomo
```

**原因：** tunManager 未初始化或系统授权内核不存在

**解决：**
1. 确认 tun-manager.js 已在 main.js 中初始化
2. 确认授权已完成
3. 重启应用

### 问题：TUN 接口创建失败
```
[TUN] operation not permitted
```

**原因：** 使用的内核没有 root 权限

**解决：**
1. 检查进程：`ps aux | grep mihomo`
2. 确认使用的是系统授权内核
3. 如果不是，检查 findMihomoExecutable() 的返回值

### 问题：接口名不是自定义的名字（macOS）

**说明：** 这是正常的，macOS 会自动分配编号

**不影响功能**，TUN 模式仍然工作。

## 文件清单

### 修改的文件
- `electron/main-process/mihomo-service.js`
  - 修改 `findMihomoExecutable()` 函数
  - 优先返回系统授权内核

### 依赖的文件
- `electron/main-process/tun-manager.js`
  - 提供 `getKernelPath()` 方法
  - 返回已授权的系统内核路径

### 初始化顺序（main.js）
```javascript
// 必须按此顺序初始化
require('./main-process/service-manager')(context);  // 1. service
require('./main-process/tun-manager')(context);      // 2. tun-manager
require('./main-process/mihomo-service')(context);   // 3. mihomo (依赖 tun-manager)
```

## 总结

这个修复确保 mihomo 在 TUN 模式下使用**已授权的系统内核**，而不是**未授权的原始内核**。

只有已授权的内核才有足够的权限创建 TUN 接口。

现在 TUN 模式应该能正常工作了！
