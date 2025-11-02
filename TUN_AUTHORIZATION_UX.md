# TUN 模式授权用户体验优化

## 修改目标

优化不同平台的TUN模式授权体验：
1. **macOS/Linux**：第一次需要输密码，有权限后直接开关，不弹框
2. **Windows**：区分不同状态，显示清晰的提示信息

## 修改内容

### 1. macOS/Linux 授权流程优化

#### 修改前
```
用户点击TUN开关
  ↓
检查权限
  ↓ 已有权限
显示确认对话框 ✗（不必要）
  ↓ 用户点击确认
启用TUN模式
```

#### 修改后
```
用户点击TUN开关
  ↓
检查权限
  ↓ 没有权限
直接弹出系统密码框 ✓
  ↓ 输入密码
授权成功，自动启用 ✓

  ↓ 已有权限
直接启用，无弹框 ✓
```

### 2. Windows 授权流程（保持不变）

```
用户点击TUN开关
  ↓
检查计划任务
  ↓ 没有计划任务
显示对话框："需要创建计划任务并重启"
  ↓ 用户点击授权
创建计划任务，重启应用

  ↓ 已有计划任务
显示对话框："需要以管理员身份重启"
  ↓ 用户点击确认
以管理员身份重启应用
```

## 平台差异

### macOS/Linux

**特点：**
- 使用 `osascript` 或 `pkexec` 弹出系统密码框
- 授权是一次性的（写入系统目录）
- 授权后内核有 root 权限，可以直接创建 TUN 接口

**授权提示：**
- 第一次：`正在请求授权，请输入管理员密码...`
- 后续：直接启用，无提示

**为什么不需要弹框？**
1. 系统密码框已经是一个明确的提示
2. 授权后可以直接使用，不需要重启
3. 减少不必要的点击步骤

### Windows

**特点：**
- 使用计划任务实现管理员权限
- 需要创建计划任务（第一次）
- 需要重启应用以获取管理员权限

**授权提示：**
- 第一次：`Windows 首次启动 TUN 模式需要管理员权限。点击"授权"后，应用将创建一个计划任务并自动重启以获取管理员权限。`
- 后续：`Windows TUN 模式需要以管理员身份运行。点击"确认启用"后，应用将自动重启并以管理员权限运行。`

**为什么需要弹框？**
1. 需要重启应用，用户需要明确知道
2. 重启会中断当前会话，需要用户确认
3. 第一次和后续的操作不同，需要不同的提示

## 代码修改

### src/components/Dashboard.tsx

#### 修改1: macOS/Linux 已有权限时直接启用

**位置：** 1010-1014行

**修改前：**
```typescript
} else {
  // 已有权限，显示确认对话框
  console.log('[Dashboard] Has permission, showing confirmation dialog');
  setHasAdminPermission(true);
  setTunConfirmOpen(true);
}
```

**修改后：**
```typescript
} else {
  // 已有权限，直接启用，不显示确认对话框
  console.log('[Dashboard] Has permission, directly enabling TUN mode');
  await runTunToggle(true);
}
```

#### 修改2: 其他平台直接启用

**位置：** 1022-1023行

**修改前：**
```typescript
// 其他平台，直接显示确认对话框
setHasAdminPermission(true);
setTunConfirmOpen(true);
```

**修改后：**
```typescript
// 其他平台，直接启用
await runTunToggle(true);
```

#### 修改3: 优化 Windows 对话框提示

**位置：** 1224-1230行

**修改前：**
```typescript
<DialogDescription>
  {(!hasAdminPermission && electron?.checkElevateTask)
    ? '首次启动 TUN 模式需要管理员权限。点击"授权"后，应用将创建一个计划任务并自动重启以获取管理员权限。'
    : t('dashboard.tunModeWarning')}
</DialogDescription>
```

**修改后：**
```typescript
<DialogDescription>
  {electron?.checkElevateTask
    ? (!hasAdminPermission
        ? 'Windows 首次启动 TUN 模式需要管理员权限。点击"授权"后，应用将创建一个计划任务并自动重启以获取管理员权限。'
        : 'Windows TUN 模式需要以管理员身份运行。点击"确认启用"后，应用将自动重启并以管理员权限运行。')
    : t('dashboard.tunModeWarning')}
</DialogDescription>
```

## 用户体验对比

### macOS/Linux

| 操作 | 修改前 | 修改后 |
|------|-------|--------|
| 第一次开启TUN | 1. 点击开关<br/>2. 弹出确认框<br/>3. 点击授权<br/>4. 输入密码 | 1. 点击开关<br/>2. 输入密码 ✓ |
| 后续开启TUN | 1. 点击开关<br/>2. 弹出确认框<br/>3. 点击确认 | 1. 点击开关 ✓ |
| 关闭TUN | 直接关闭 | 直接关闭 |

**改进：**
- 第一次：减少1次点击
- 后续：减少2次点击（弹框 + 确认按钮）

### Windows

| 操作 | 修改前 | 修改后 |
|------|-------|--------|
| 第一次开启TUN | 1. 点击开关<br/>2. 弹出确认框（通用提示）<br/>3. 点击授权<br/>4. 应用重启 | 1. 点击开关<br/>2. 弹出确认框（Windows专用提示）✓<br/>3. 点击授权<br/>4. 应用重启 |
| 后续开启TUN | 1. 点击开关<br/>2. 弹出确认框（通用提示）<br/>3. 点击确认<br/>4. 应用重启 | 1. 点击开关<br/>2. 弹出确认框（Windows专用提示）✓<br/>3. 点击确认<br/>4. 应用重启 |
| 关闭TUN | 直接关闭 | 直接关闭 |

**改进：**
- 提示信息更清晰，用户知道为什么需要重启
- 区分第一次和后续的不同操作

## 流程图

### macOS/Linux 第一次开启TUN

```
用户点击TUN开关
  ↓
[Dashboard] 检查权限
  ↓
[electron.checkCorePermission()]
  ↓
hasPermission = false
  ↓
显示 Banner: "正在请求授权，请输入管理员密码..."
  ↓
[electron.grantTunPermissions()]
  ↓
弹出系统密码框 (osascript)
  ↓
用户输入密码
  ↓
复制内核到 /Library/Application Support/Flycast/mihomo
设置 root:wheel，chmod u+s
  ↓
授权成功
  ↓
显示 Banner: "TUN 模式权限已成功授予，正在启用..."
  ↓
[runTunToggle(true)]
  ↓
TUN 模式启用 ✓
```

### macOS/Linux 后续开启TUN

```
用户点击TUN开关
  ↓
[Dashboard] 检查权限
  ↓
[electron.checkCorePermission()]
  ↓
hasPermission = true
  ↓
[runTunToggle(true)]
  ↓
TUN 模式启用 ✓
```

### Windows 第一次开启TUN

```
用户点击TUN开关
  ↓
[Dashboard] 检查计划任务
  ↓
[electron.checkElevateTask()]
  ↓
hasTask = false
  ↓
显示对话框:
"Windows 首次启动 TUN 模式需要管理员权限。
点击"授权"后，应用将创建一个计划任务并自动重启以获取管理员权限。"
  ↓
用户点击"授权"
  ↓
[electron.grantTunPermissions()]
  ↓
创建计划任务
  ↓
应用重启（以管理员权限）
  ↓
TUN 模式启用 ✓
```

### Windows 后续开启TUN

```
用户点击TUN开关
  ↓
[Dashboard] 检查计划任务
  ↓
[electron.checkElevateTask()]
  ↓
hasTask = true
  ↓
显示对话框:
"Windows TUN 模式需要以管理员身份运行。
点击"确认启用"后，应用将自动重启并以管理员权限运行。"
  ↓
用户点击"确认启用"
  ↓
[runTunToggle(true)]
  ↓
应用重启（以管理员权限）
  ↓
TUN 模式启用 ✓
```

## 设计原则

### 1. 最小化点击次数
- macOS/Linux 后续操作：1次点击（开关）
- 不需要额外的确认步骤

### 2. 明确的反馈
- 第一次授权：显示 Banner 提示正在请求授权
- 授权成功：显示成功提示并自动启用
- 失败：显示错误信息

### 3. 平台差异化
- Windows 需要重启：显示对话框说明原因
- macOS/Linux 不需要重启：直接使用系统密码框

### 4. 一致的关闭体验
- 所有平台关闭TUN都是直接执行，无弹框
- 关闭不需要特殊权限

## 测试场景

### macOS 测试

1. **第一次开启TUN**
   - [ ] 点击TUN开关
   - [ ] 立即弹出系统密码框
   - [ ] 输入密码后显示成功提示
   - [ ] TUN自动启用

2. **关闭TUN**
   - [ ] 点击TUN开关
   - [ ] 直接关闭，无弹框

3. **再次开启TUN**
   - [ ] 点击TUN开关
   - [ ] 直接启用，无密码框，无确认框
   - [ ] TUN成功启用

### Windows 测试

1. **第一次开启TUN（无计划任务）**
   - [ ] 点击TUN开关
   - [ ] 显示对话框：提示需要创建计划任务并重启
   - [ ] 点击授权
   - [ ] 应用重启

2. **后续开启TUN（有计划任务）**
   - [ ] 点击TUN开关
   - [ ] 显示对话框：提示需要以管理员身份重启
   - [ ] 点击确认
   - [ ] 应用重启

## 总结

这次修改优化了 TUN 模式的授权体验：

1. **macOS/Linux**
   - ✅ 第一次：系统密码框已经足够明确
   - ✅ 后续：直接开关，无额外步骤
   - ✅ 符合 Unix 系统的使用习惯

2. **Windows**
   - ✅ 需要重启时显示明确的提示
   - ✅ 区分第一次和后续的不同情况
   - ✅ 用户理解为什么需要重启

3. **整体改进**
   - ✅ 减少不必要的点击
   - ✅ 提示信息更清晰
   - ✅ 符合各平台的使用习惯
