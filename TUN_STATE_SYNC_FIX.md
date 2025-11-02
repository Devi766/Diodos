# TUN 模式状态同步修复

## 问题

用户反馈：重启应用后，TUN模式的开关显示为关闭，但实际TUN还在运行。

## 根本原因

### 问题逻辑（修复前）

```javascript
// 应用启动时 (main.js)
const savedState = getTunModeEnabled();  // 从数据库读取：true

// 检测实际TUN接口状态
const tunManager = require('./main-process/tun-manager')(context);
const actuallyActive = tunManager.isTunActive();  // 此时mihomo还没启动 → false

// 发现状态不一致，自动同步
if (actuallyActive !== savedState) {
  state.tunModeEnabled = actuallyActive;  // 设置为 false
  setTunModeEnabled(actuallyActive);      // 保存到数据库：false ✗
}
```

### 时序问题

```
1. 应用启动
   ↓
2. 读取数据库：tunModeEnabled = true
   ↓
3. 检测TUN接口：isTunActive() = false (mihomo还没启动)
   ↓
4. "纠正"状态：保存 tunModeEnabled = false 到数据库 ✗
   ↓
5. mihomo启动，读取 user-settings.yaml
   ↓
6. user-settings.yaml 中 tun.enable = true
   ↓
7. mihomo 创建TUN接口
   ↓
结果：数据库状态 = false，实际TUN = 运行中 ✗
```

### 为什么会这样？

1. **数据库状态（tunModeEnabled）**：用户上次关闭应用前开启了TUN，保存为 true
2. **配置文件状态（user-settings.yaml）**：tun.enable = true
3. **运行时状态（isTunActive）**：应用启动时mihomo还没运行，TUN接口不存在，返回 false
4. **错误的自动同步**：用"不存在的TUN接口"覆盖了"用户的真实意图"

## 修复方案

### 核心原则

**启动时应该使用数据库保存的状态，而不是检测运行时状态**

原因：
- 数据库状态代表用户的**意图**（用户想要TUN开启）
- 运行时状态代表**当前瞬间**（mihomo还没启动）
- 不应该用瞬间状态覆盖用户意图

### 修复后的逻辑

```javascript
// 应用启动时 (main.js)
const savedState = getTunModeEnabled();  // 从数据库读取
console.log('[TUN] 数据库保存的状态:', savedState ? '已启用' : '未启用');

state.tunModeEnabled = savedState;  // 直接使用数据库状态
console.log('[TUN] 启动状态:', state.tunModeEnabled ? '已启用' : '未启用');
```

### 正确的时序

```
1. 应用启动
   ↓
2. 读取数据库：tunModeEnabled = true
   ↓
3. 设置状态：state.tunModeEnabled = true ✓
   ↓
4. mihomo启动，读取 user-settings.yaml
   ↓
5. user-settings.yaml 中 tun.enable = true
   ↓
6. mihomo 创建TUN接口 ✓
   ↓
结果：数据库状态 = true，UI开关 = 开启，实际TUN = 运行中 ✓
```

## 状态管理设计

### 三层状态

| 状态层 | 存储位置 | 含义 | 更新时机 |
|-------|---------|------|---------|
| **用户意图** | 数据库 `tunModeEnabled` | 用户是否想要开启TUN | 用户点击开关时 |
| **配置文件** | `user-settings.yaml` | mihomo的配置 | 切换TUN时同步更新 |
| **运行时状态** | TUN接口是否存在 | 当前瞬间的状态 | mihomo创建/销毁接口 |

### 状态同步规则

1. **启动时**：使用数据库状态（用户意图）
2. **用户操作时**：
   ```javascript
   用户点击开关
     ↓ 更新数据库（保存意图）
     ↓ 更新配置文件（同步配置）
     ↓ 重启mihomo（应用配置）
     ↓ TUN接口创建/销毁（运行时状态）
   ```
3. **不应该**：用运行时状态覆盖用户意图

## 修改文件

### electron/main.js

**修改前（1886-1916行）：**
```javascript
// 先从数据库读取上次的状态
const savedState = getTunModeEnabled();

// macOS/Linux: 检测实际的TUN接口状态
if (process.platform === 'darwin' || process.platform === 'linux') {
  try {
    const tunManager = require('./main-process/tun-manager')(context);
    const actuallyActive = tunManager.isTunActive();

    // 使用实际状态，并同步到数据库
    if (actuallyActive !== savedState) {
      state.tunModeEnabled = actuallyActive;
      setTunModeEnabled(actuallyActive);  // ✗ 错误的自动同步
    } else {
      state.tunModeEnabled = savedState;
    }
  } catch (e) {
    state.tunModeEnabled = savedState;
  }
} else {
  state.tunModeEnabled = savedState;
}
```

**修改后：**
```javascript
const savedState = getTunModeEnabled();
console.log('[TUN] 数据库保存的状态:', savedState ? '已启用' : '未启用');

state.tunModeEnabled = savedState;  // ✓ 直接使用数据库状态
console.log('[TUN] 启动状态:', state.tunModeEnabled ? '已启用' : '未启用');
```

## 测试验证

### 测试场景1：正常重启

```
1. 开启TUN模式
2. 关闭应用
3. 重新启动应用

预期结果：
- UI开关显示：开启 ✓
- 数据库状态：true ✓
- mihomo启动后TUN接口存在 ✓
```

### 测试场景2：关闭TUN后重启

```
1. 关闭TUN模式
2. 关闭应用
3. 重新启动应用

预期结果：
- UI开关显示：关闭 ✓
- 数据库状态：false ✓
- mihomo启动后TUN接口不存在 ✓
```

### 测试场景3：崩溃恢复

```
1. 开启TUN模式
2. 应用崩溃或强制杀掉进程
3. 重新启动应用

预期结果：
- UI开关显示：开启 ✓
- 数据库状态：true ✓
- mihomo启动后恢复TUN接口 ✓
```

## 边界情况

### 情况1：用户手动修改配置文件

如果用户直接编辑 `user-settings.yaml`，将 `tun.enable` 改为不同的值：

```
数据库：tunModeEnabled = true
配置文件：tun.enable = false

结果：
- UI显示：开启（来自数据库）
- 实际TUN：不运行（来自配置文件）
- 用户再次点击开关时会同步
```

这是可接受的，因为：
- 直接修改配置文件是高级操作
- 下次切换开关时会自动同步

### 情况2：mihomo进程被外部杀掉

```
1. TUN模式开启，mihomo运行中
2. 用户用 kill 命令杀掉mihomo进程
3. TUN接口消失

结果：
- UI显示：开启
- 实际TUN：不存在
- 用户重启应用后mihomo会重新创建TUN接口
```

这也是可接受的，因为：
- 外部杀进程是异常操作
- 应用保持用户意图，下次启动时恢复

## 总结

### 修复前的问题

- ✗ 应用启动时错误地检测TUN接口
- ✗ 用运行时状态覆盖用户意图
- ✗ 导致UI开关和实际状态不一致

### 修复后的改进

- ✓ 启动时直接使用数据库状态
- ✓ 尊重用户意图
- ✓ UI开关和实际状态保持一致

### 设计原则

1. **用户意图优先**：数据库状态代表用户想要的状态
2. **避免过度智能**：不要试图自动"纠正"用户的选择
3. **单一真相来源**：数据库是状态的唯一真相来源
4. **只在用户操作时同步**：不要在启动时自动同步状态
