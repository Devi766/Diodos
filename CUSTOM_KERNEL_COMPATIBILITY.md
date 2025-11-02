# 自定义内核兼容性说明

## 对自定义内核功能的影响

### ✅ 不影响自定义内核功能

修改后的代码**完全兼容**自定义内核功能：

- **TUN 模式关闭时**：使用用户自定义的内核路径
- **TUN 模式开启时**：使用系统授权的内核（必需）

## 内核选择逻辑

### 修改后的逻辑

```javascript
function findMihomoExecutable() {
  const tunEnabled = dbManager.getSetting('tunModeEnabled', false);

  // 1. TUN 模式启用时，必须使用系统授权内核
  if ((isMac || isLinux) && tunEnabled) {
    const systemKernel = tunManager.getKernelPath();
    if (systemKernel 已授权) {
      return systemKernel;  // /Library/Application Support/Flycast/mihomo
    }
    // 如果未授权，警告并降级
  }

  // 2. TUN 模式关闭，或系统内核未授权时，使用自定义内核
  const preferredPath = getKernelExecutablePath();
  if (preferredPath) {
    return preferredPath;  // 用户自定义路径
  }

  // 3. 没有自定义路径，使用默认路径
  return defaultKernelPath;
}
```

### 场景说明

#### 场景1: TUN 模式关闭 + 自定义内核

```
用户配置: /Users/xxx/my-mihomo/mihomo
TUN 模式: 关闭
结果: 使用 /Users/xxx/my-mihomo/mihomo ✓
```

**完全正常**，使用用户自定义的内核。

#### 场景2: TUN 模式开启 + 已授权

```
用户配置: /Users/xxx/my-mihomo/mihomo
TUN 模式: 开启
系统内核: /Library/Application Support/Flycast/mihomo (已授权)
结果: 使用系统授权内核 ✓
```

**必须如此**，因为 TUN 需要 root 权限。

#### 场景3: TUN 模式开启 + 未授权

```
用户配置: /Users/xxx/my-mihomo/mihomo
TUN 模式: 开启
系统内核: 不存在或未授权
结果:
  - 警告: "TUN enabled but system kernel not authorized"
  - 降级使用: /Users/xxx/my-mihomo/mihomo
  - TUN 创建失败 ✗ (没有权限)
```

**会有问题**，提示用户需要授权。

#### 场景4: 没有自定义内核

```
用户配置: 无
TUN 模式: 关闭
结果: 使用默认内核路径 ✓
```

**正常行为**。

## 为什么 TUN 模式必须使用系统授权内核？

### 权限要求

TUN 接口的创建需要：
1. **root 权限** (uid = 0)
2. **setuid 位** (chmod u+s)

### 用户目录的限制

macOS 安全机制：
```bash
# 在用户目录 - 即使用 sudo 也不允许
sudo chown root:wheel /Users/xxx/mihomo
# ✗ Operation not permitted

# 在系统目录 - 允许
sudo chown root:wheel /Library/Application\ Support/Flycast/mihomo
# ✓ 成功
```

因此，**必须将内核复制到系统目录并授权**。

## 自定义内核 + TUN 模式的最佳实践

### 选项1: 使用系统授权内核 + 自动同步（推荐）

**步骤：**
1. 将你的自定义内核设置为默认内核
2. 在应用中点击"授权"
3. 系统会将你的内核复制到系统目录并授权
4. TUN 模式使用系统授权的副本
5. 非 TUN 模式使用你的原始内核

**自动同步功能：**
- 每次开启TUN时自动检测自定义内核是否更新
- 如果安装了Service Mode：自动同步，无需密码 ✓
- 如果未安装Service Mode：提示重新授权，需要1次密码

**优点：**
- 简单，一键授权
- TUN 模式完全功能
- 自定义内核功能不受影响
- **新增**：自动检测内核更新
- **新增**：Service Mode下无密码自动同步

**缺点：**
- TUN 模式使用的是副本，不是原始文件
- 更新自定义内核后需要重新授权（但有Service Mode时自动完成）

### 选项2: 不使用 TUN 模式

**步骤：**
1. 使用你的自定义内核
2. 不开启 TUN 模式
3. 使用系统代理或其他代理模式

**优点：**
- 完全使用自定义内核
- 无需授权

**缺点：**
- 无法使用 TUN 模式

### 选项3: 手动授权自定义内核路径

**步骤：**
```bash
# 如果你的自定义内核在用户目录
# 需要先复制到系统目录
sudo mkdir -p "/Library/Application Support/Flycast"
sudo cp /Users/xxx/my-mihomo/mihomo "/Library/Application Support/Flycast/mihomo"
sudo chown root:wheel "/Library/Application Support/Flycast/mihomo"
sudo chmod u+s "/Library/Application Support/Flycast/mihomo"
```

**优点：**
- 灵活控制

**缺点：**
- 需要手动操作
- 每次更新内核都要重复

## 更新自定义内核时

### 如果使用 TUN 模式

#### 方案A: 安装了Service Mode（推荐，完全自动）

更新步骤：
1. 更新你的自定义内核文件
   ```bash
   cp /path/to/new/mihomo /Users/xxx/my-mihomo/mihomo
   ```
2. 在应用中开启TUN模式
3. **系统自动检测并同步**（无需密码）✓
4. 日志显示：`[TunManager] Custom kernel auto-synced`

#### 方案B: 未安装Service Mode（半自动）

更新步骤：
1. 更新你的自定义内核文件
2. 在应用中开启TUN模式
3. **系统检测到更新，提示重新授权**
4. 点击授权按钮，输入密码（1次）
5. 同步完成 ✓

#### 方案C: 手动同步（不推荐）

```bash
sudo cp /path/to/new/mihomo "/Library/Application Support/Flycast/mihomo"
sudo chown root:wheel "/Library/Application Support/Flycast/mihomo"
sudo chmod u+s "/Library/Application Support/Flycast/mihomo"
```

### 如果不使用 TUN 模式

更新步骤：
1. 更新你的自定义内核文件
2. 重启应用

无需其他操作。

## 验证当前使用的内核

### 检查日志

应用日志会显示：

**TUN 模式开启时：**
```
[MihomoService] TUN mode enabled, using authorized system kernel: /Library/Application Support/Flycast/mihomo
```

**TUN 模式关闭时：**
```
[MihomoService] Using preferred kernel: /Users/xxx/my-mihomo/mihomo
```

### 检查进程

```bash
ps aux | grep mihomo
```

会显示实际使用的内核路径。

## 总结

| 模式 | 使用的内核 | 影响 |
|------|-----------|------|
| TUN 关闭 | 用户自定义内核 | ✅ 无影响 |
| TUN 开启 | 系统授权内核 | ⚠️ 必须使用系统副本 |

**结论**：
- 自定义内核功能**完全保留**
- TUN 模式需要使用系统授权副本（**技术限制**）
- 两者可以共存，自动切换

如果你主要使用自定义内核且不需要 TUN 模式，**完全不受影响**。
