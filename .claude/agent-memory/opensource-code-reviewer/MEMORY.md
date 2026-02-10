# FlyClash-PC 项目审查记录

## 项目概况
- **技术栈**: Electron + Next.js + React + TypeScript
- **项目类型**: Clash 代理客户端 (FlyClash)
- **平台**: 主要面向 Windows，部分功能支持 macOS
- **语言**: 前端 TypeScript/TSX，后端 JavaScript (Node.js/Electron)
- **国际化**: 使用 react-i18next，但存在部分硬编码中文

## 代码风格
- 注释以中文为主，日志输出也是中文
- 命名规范：前端驼峰命名，后端也是驼峰
- IPC 通道命名使用冒号分隔（如 `loopback:get-apps`）
- 使用 JSDoc 注释风格
- 页面路由：nodes(非proxies)、match-rules(非rules)

## 已审查文件 (2026-02-10)

### 第一轮~第三轮（略，见历史）

### 第四轮 - 全面逐文件审核 (2026-02-10)
**前端页面**: layout.tsx, page.tsx, settings/page.tsx, connections/page.tsx, match-rules/page.tsx, logs/page.tsx, nodes/page.tsx
**前端组件**: Layout.tsx, LoopbackManager.tsx
**后端模块**: proxy-parser.js, processor-pipeline.js, subscription-preprocessor.js, core-manager.js, running-mode.js, mediatest.js
**配置/类型**: electron.d.ts, next.config.js, package.json

## 关键发现（第四轮）

### P0 必须修复
1. `proxy-parser.js:3` - "对应安卓端的 ProxyParser.kt" 暗示非原创
2. `next.config.js:29` - `ignoreBuildErrors: true` 不专业
3. `mediatest.js:354,395` - Disney+ Bearer Token 硬编码
4. `mediatest.js:420` - `platformFamily` 未定义变量
5. `layout.tsx:181` - meta description 硬编码中文
6. `Layout.tsx:855` - "已连接" 未使用 i18n
7. `Layout.tsx:396` - CSS 注入风险（imageUrl 未转义）

### 反复出现的模式问题
- **console.log 泛滥**: 约 60+ 处调试日志分布在后端模块中
- **中英文混杂**: 错误消息、注释、日志混用中英文
- **代码重复**: layout.tsx 主题切换5次重复、proxy-parser.js parseQuery 3次重复
- **any 类型**: electron.d.ts 中约 15 处 any

## 开源准备清单（更新）
- [ ] **紧急**: 重构 electron/main.js（正在进行）
- [ ] **紧急**: 修复上述 P0 问题（7项）
- [ ] 移除所有调试用 console.log（约 60+ 处）
- [ ] 统一错误消息和日志为英文
- [ ] 修复 TypeScript 错误后移除 ignoreBuildErrors
- [ ] 消除代码重复（主题切换、parseQuery）
- [ ] electron.d.ts 修复重复 Window 声明、减少 any
- [ ] package.json: @types/js-yaml 移到 devDependencies
