# TUN 模式调试指南

## 问题：开启 TUN 模式后没有效果，网卡没有出现

### 检查步骤

#### 1. 检查内核是否已授权

```bash
# 检查系统副本是否存在且已授权
ls -la "/Library/Application Support/Flycast/mihomo"

# 应该显示:
# -rwsr-xr-x  1 root  wheel  [size]  [date]  mihomo
#  ^^^
#  这个 's' 表示 setuid 位已设置
```

如果文件不存在或权限不对，在应用中点击"授权"按钮。

#### 2. 检查 TUN 配置是否保存

```bash
# 查看数据库中的 TUN 配置
# 数据库文件位置: ~/Library/Application Support/flycast-ui/app.db
# 或者查看 user-settings.yaml

cat ~/Library/Application Support/flycast-ui/user-settings.yaml | grep -A 10 tun
```

应该看到类似：
```yaml
tun:
  enable: true
  device: utun  # 或你的自定义名字
  stack: system
  auto-route: true
  auto-detect-interface: true
  dns-hijack:
    - any:53
  mtu: 1500
```

#### 3. 检查 mihomo 是否使用了正确的内核

查看应用日志，应该看到：
```
[MihomoService] Using authorized system kernel: /Library/Application Support/Flycast/mihomo
```

而不是：
```
[MihomoService] Using preferred kernel: /Users/none/Documents/.../mihomo
```

#### 4. 检查 mihomo 进程

```bash
# 查看 mihomo 进程
ps aux | grep mihomo

# 应该看到进程使用的是系统副本:
# /Library/Application Support/Flycast/mihomo -d ...
```

#### 5. 检查 TUN 接口

```bash
# macOS: 检查 utun 接口
ifconfig | grep utun

# 应该看到类似:
# utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
# utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500

# 如果你自定义了设备名，检查是否存在
ifconfig -a | grep [你的设备名]
```

**注意**：macOS 上，即使配置了 `device: utun`，实际创建的接口名可能是 `utun3`、`utun4` 等，这是正常的。`utun` 只是前缀。

#### 6. 查看 mihomo 日志

应用中应该可以看到 mihomo 的日志输出，查找：

**成功的情况：**
```
[TUN] tun://utun -> 0.0.0.0:0
[TUN] TUN interface created
```

**失败的情况：**
```
[TUN] operation not permitted
[TUN] permission denied
[TUN] failed to create TUN interface
```

### 常见问题

#### 问题1: 权限错误
**症状：** 日志显示 "operation not permitted" 或 "permission denied"

**解决：**
1. 确认系统副本已授权：
   ```bash
   ls -la "/Library/Application Support/Flycast/mihomo"
   # 必须是 root:wheel 且有 setuid 位
   ```

2. 如果权限不对，重新授权：
   ```bash
   sudo rm -rf "/Library/Application Support/Flycast"
   ```
   然后在应用中重新授权。

#### 问题2: mihomo 使用了错误的内核
**症状：** 日志显示使用的是用户目录的内核，不是系统副本

**解决：**
1. 确认 tun-manager 已初始化：检查日志中是否有 `[TunManager]` 相关输出

2. 重启应用，确保初始化顺序正确

3. 检查代码：mihomo-service.js 中 findMihomoExecutable() 应该优先返回系统授权内核

#### 问题3: 自定义设备名不生效
**症状：** 设置了自定义设备名，但接口名不一样

**macOS 说明：**
- 在 macOS 上，`device: utun` 是一个**前缀**，不是确切的接口名
- 系统会自动分配接口编号，如 utun3, utun4 等
- 这是正常行为，不影响功能

**如果要使用特定名字：**
```yaml
tun:
  device: utun5  # 指定编号
  # 但系统仍可能分配其他编号
```

**Linux 上：**
```yaml
tun:
  device: mihomo  # 可以是任意名字
```

#### 问题4: DNS 没有生效
**检查：**
```bash
# macOS
scutil --dns

# 应该看到 mihomo 的 DNS 设置
```

**TUN 模式的 DNS 配置：**
```yaml
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
```

这些应该自动配置，检查 user-settings.yaml 确认。

### 调试命令

#### 重置所有 TUN 相关配置

```bash
# 1. 清理系统授权
sudo rm -rf "/Library/Application Support/Flycast"

# 2. 清理应用数据
rm ~/Library/Application\ Support/flycast-ui/app.db
rm ~/Library/Application\ Support/flycast-ui/user-settings.yaml

# 3. 重启应用，重新配置
```

#### 查看完整的 mihomo 配置

```bash
# 查看 mihomo 实际使用的配置文件
cat ~/Library/Application\ Support/flycast-ui/mihomo/override-*.yaml
```

检查 `tun` 部分是否正确。

### 成功的标志

当 TUN 模式成功启动时，你应该看到：

1. **系统授权**：
   ```bash
   ls -la "/Library/Application Support/Flycast/mihomo"
   # -rwsr-xr-x  1 root  wheel
   ```

2. **进程运行**：
   ```bash
   ps aux | grep mihomo | grep "Library/Application Support"
   ```

3. **接口存在**：
   ```bash
   ifconfig | grep -A 5 utun
   # 看到 UP, RUNNING 状态
   ```

4. **mihomo 日志**：
   ```
   [TUN] tun://utun -> 0.0.0.0:0
   ```

5. **流量经过 TUN**：
   ```bash
   # 测试连接
   curl -v http://example.com
   # 流量应该经过 TUN 接口
   ```

### 如果还是不行

收集以下信息：

1. 应用日志（完整的控制台输出）
2. mihomo 日志
3. 系统信息：
   ```bash
   uname -a
   sw_vers
   ```
4. 权限状态：
   ```bash
   ls -la "/Library/Application Support/Flycast/mihomo"
   ```
5. 进程信息：
   ```bash
   ps aux | grep mihomo
   ```
6. 接口信息：
   ```bash
   ifconfig -a
   ```
7. 配置文件：
   ```bash
   cat ~/Library/Application\ Support/flycast-ui/user-settings.yaml
   ```
