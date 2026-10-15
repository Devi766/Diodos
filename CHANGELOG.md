# Changelog

本文件记录 FlyClash Desktop（Tauri）各版本的重要变更。

## v0.3.4 (2026-10-14)

### Redesigned dashboard card system
The dashboard is now a modular workspace: choose the information you need, preview each card's available layouts, and arrange a dashboard that fits your workflow.

- **A consistent sizing system:** standard half-width and full-width cards share the same height, while extra-large full-width cards provide more room for detailed charts and lists. Supported sizes vary by card, keeping each layout suited to its content.
- **A redesigned widget library:** preview cards and switch between supported layouts before adding them. Customize the dashboard with drag-and-drop ordering and add or remove cards, with layout preferences saved across sessions.
- **A unified visual language:** consistent title icons, inner spacing, typography, rounded corners and neutral control backgrounds, with responsive layouts and light/dark theme support.
- Refine the standard full-width route tracing card with lighter edge fades and neutral title controls. Use transparent scrollbar tracks throughout the main scrolling views.
- Resolve real application icons on macOS, including owning app bundles for helper processes and process-name fallback. Share cached, asynchronous icon loading between traffic rankings and connection details.
- **Network information at a glance:** a new standard full-width card combines total traffic, active connections, download speed and upload speed. The four individual metrics remain available as compact half-width variants.
- **Immersive traffic and subscription cards:** flowing speed visualizations and a tilted subscription usage ring bring data into the card surface. Subscription cards show usage percentage and remaining traffic, with expiry information shown only when available.
- **Compact network controls:** combine system proxy and TUN switches in one network-control card, alongside a redesigned proxy-mode selector and an IP card with a cleaner details view for direct and proxied connections.
- **Diagnostics on the dashboard:** add media availability, connectivity checks and route tracing. Test an individual media service directly from its item, open the complete media diagnostics from the card background, or inspect route results on an interactive globe.
- **More personal layouts:** add image cards and mix compact summaries with larger visualizations. Existing layouts are migrated to the new card model while retaining saved ordering and enabled/disabled preferences.

### Diagnostics tools
- Preserve native parallel group latency testing and progressively display fresh results from the core's delay history, without waiting for every node to finish.
- Add a dedicated route tracing page with target input, probe controls, an interactive globe, hop statistics and report copying.
- Share the complete media diagnostics dialog between the tools page and dashboard cards.

### Configuration management
- Improve runtime profile switching and move tray updates and connection cleanup out of the foreground path.
- Coalesce proxy refresh events, load icons asynchronously and use skeletons during page loading.
- Expand imports to YAML/JSON, partial configurations, node links and Base64 subscriptions.
- Add bounded download retries and proxy fallback; limit HTTP 5xx to one alternate-route retry.
- Wrap long error messages and redact credentials from subscription URLs.

### Performance
- Remove overlapping route transitions and schedule route preloading during idle time.
- Cache generated runtime configurations and serialize reloads of the shared work file.

### Localization and interface polish
- Default to English on first launch while preserving saved language preferences, with English fallback when preferences are unavailable.
- Complete English text for controls, notifications, TUN permissions, media reports, AI tool results and native tray menus. Follow the selected language when formatting dates and durations.
- Keep proxy and TUN toggles quiet on success while retaining failure notifications. Keep node cards at a stable height during latency tests and unify appearance selector styles.

## v0.3.3 (2026-09-07)

### 跨设备备份
- 新增局域网跨设备发现、六位配对码与 AES-256-GCM 加密传输，支持 PC 与 Android 双向发送和接收备份
- 广播设备名称、设备类型与系统平台，PC、手机和平板使用对应图标，并兼容旧版发现协议
- 完整备份同步包含 AI 助手设置；优化跨平台覆写配置的备份恢复兼容性

### 界面与交互
- 引入 Motion 页面过渡，统一按钮、开关、标签和导航反馈，降低卡片悬浮幅度
- 重做跨设备导入、接收等待与配对输入界面，完整适配浅色和深色模式
- 修复页面切换和主题初始化时的闪白问题
- 修复 macOS Overlay 标题栏无法拖动窗口的问题：红绿灯右侧长条可直接拖动，无需再去窗口边缘等待缩放箭头

### 加载性能
- 为仪表盘、节点、订阅、连接、规则、设置、日志与 AI 助手提供匹配实际布局的灰度骨架屏
- 使用用户意图预取：悬停、聚焦和按下导航时预取目标页面模块与对应数据
- 缓存失效改为 stale-while-revalidate，刷新期间保留旧内容并在后台静默更新，减少重复骨架屏
- 外部资源配置接入共享缓存，返回页面时直接显示缓存内容

## v0.3.2 (2026-08-23)

### Windows WebView2
- 允许交互用户通过 UAC 以管理员身份运行 FlyClash，并继续使用该用户的个人 WebView2 数据目录
- 保持对 SYSTEM、LocalService、NetworkService 及 `systemprofile` 服务身份的启动拦截，TUN 仍默认由 FlyClash Helper Service 提权处理

## v0.3.1 (2026-08-23)

### Windows TUN 与 WebView2
- 移除会以管理员权限重新启动整个桌面界面的计划任务模式，TUN 提权统一交由最小权限的 FlyClash Helper Service 处理
- 启动时自动迁移旧的计划任务配置，并清理遗留的 `FlyClash-Elevated` 任务
- 阻止 FlyClash 桌面界面以 SYSTEM、LocalService、NetworkService 或管理员身份承载 WebView2，避免数据目录落入 `systemprofile` 以及高权限 WebView 风险
- TUN 设置页只展示 Helper 服务的安装、运行与 IPC 状态，避免用户重新选择不安全的提权方式

## v0.3.0-ver2 (2026-07-26)

### 性能优化
- 覆写（Override）应用结果全新缓存机制：同一配置与覆写组合仅执行一次脚本，托盘刷新、代理列表加载、配置解析等路径全部复用结果，大配置 + JS 脚本场景下启动与操作响应显著提速
- JS 覆写执行引擎改用 `JSON.parse` 注入配置，避免大配置在脚本引擎内逐节点求值；脚本循环迭代上限同步放宽，大规模节点去重类脚本不再被误杀
- 配置/覆写热重载与代理列表加载提速，消除切换配置时的界面卡顿与空白闪烁

### 覆写系统
- 修复 JS 脚本覆写后代理页仍显示原始分组的问题
- 修复配置中含 `__proto__` 等特殊键时脚本覆写静默丢失字段的问题
- 全局覆写严格互斥：新增与更新路径均保证同一时间只有一个启用的全局覆写
- 启用远程覆写但内容下载失败时自动回滚启用状态，不再产生"已启用但永不生效"的僵尸项
- 修复覆写拖拽排序部分失败时前后端状态不一致的问题
- 修复新增覆写可能插入到列表中间而非末尾、改变应用顺序的问题
- 修复覆写页面切换开关时的闪烁

### 代理与分组
- 修复 `include-all` 分组的一系列显示问题：url-test 分组缺失、国家分组节点为空、空分组被隐藏
- 代理节点类型从 provider 补全，不再显示 Unknown 占位
- 修复主界面切换节点后托盘菜单首次右键仍显示旧节点的问题

### 内核与稳定性
- 内核启动与控制器预热解耦，消除双进程控制器超时导致的启动失败
- 修复配置热切换在传输层异常时磁盘配置与运行态不一致的问题；配置切换热重载严格校验缓存归属
- 修复停核换配置再热切回旧配置时可能加载错误配置的缓存问题
- 内核已成功启动后设置持久化失败不再误报"启动失败"
- Windows TUN 服务模式独占内核所有权；修复 Helper 服务已存在时安装失败、中文系统 UAC 提权等问题

### 订阅管理
- 订阅刷新具备自愈能力：本地内容损坏时直接以新下载内容覆盖，不再中止刷新
- 删除订阅时同步清理明文导出文件，避免节点凭据残留磁盘
- 修复订阅页空白闪烁，恢复 YAML 拖拽导入

### 安全加固
- WebView 启用严格 CSP 策略
- 外部链接调用系统浏览器前强制校验，仅放行 http/https，阻断本地可执行文件与自定义协议
- 服务与发布链路安全加固；WebDAV 备份支持 HTTP 端点

### 其他
- Netflix 解锁检测算法与 Android 端对齐
- 仪表盘移除的卡片持久化为禁用状态，不再被默认布局还原
- 修复偏好设置恢复与全局模式路由问题
- 桌面端禁用 WebView 默认右键菜单；Windows 品牌与托盘图标清晰度优化

## v0.3.0

- 桌面框架由 Electron 迁移至 Tauri，安装包体积显著减小（Windows 约 145MB → 33MB，macOS 约 170MB → 46MB）
- 提供 Windows / macOS / Linux 多平台安装包
- 保留订阅管理、代理组、系统代理、TUN、连接统计等核心能力
