# 订阅转换器任务

对比根目录的 example project/Sub-Store（proxy-utils）后，当前 flycast-ui 工具箱订阅转换仍缺少的能力：

- [ ] 节点处理流水线：实现类似 processors 的过滤/重命名/去重/批量打标/脚本 operator，并在前端提供可配置的执行顺序。
- [ ] 协议覆盖：补齐 shadowsocks-2022、port-hopping、更多 hy2/tuic 参数等解析与输出；生成 clash-meta/URI/sing-box 时保留 reality、flow 等字段。
  - [x] SSR：新增解析、模型与 URI 输出；Clash/Meta 不支持仍会过滤并记录。
  - [x] hy2 alpn/sni：解析 alpn，输出到 Clash Meta/URI/Sing-box。
  - [x] ss-2022：Clash Meta 输出不再因为 cipher 过滤被丢弃；标准 Clash 仍按官方允许的 cipher 限制。
  - [x] TUIC/hy2 port-hopping：解析/输出 hop-interval，TUIC/Hy2 URI、Clash Meta、Sing-box 均透传。
  - [x] shadowsocks-2022 URI：支持 2022-blake3 前缀、udp-over-tcp/tfo/type 参数透传，Clash 输出继续按官方 cipher 过滤。
  - [ ] hy2/tUIC 其他参数：0-RTT、retry/early-data 等。
  - [x] shadowsocks-2022 全量：Meta/Sing-box 细节（psk/short-id 等）还原。
  - [x] shadowsocks udp-over-tcp/tfo：Clash/Meta 输出保留 udp-over-tcp、fast-open 标记。
  - [x] ws 0-RTT：VLESS/VMess/Trojan ws 解析 ed/edh，Clash/Meta/Sing-box/URI 输出补全早期数据头。
- [ ] 订阅服务器：请求时支持 UA/代理透传、缓存与忽略失败策略，解析远端 subscription-userinfo 回传真实流量和过期时间，允许配置 profile-update-interval，而非写死静态值。
- [ ] 输出格式：增加 stash/loon/surfboard/egern 等 producer 或模板，提升与 Sub-Store 支持客户端的对齐度。
- [ ] 预处理：识别 proxy-providers、分段 Base64，并支持多订阅合并及 noCache/insecure 等参数化刷新。
  - [x] SIP008 订阅（含 Base64）自动解包为标准 ss 节点行。

## 新任务（对齐 Sub-Store 差距）

1) Producer/Parser 覆盖补齐 （优先级高）
   - 新增 Snell、SSH、AnyTLS、Juicity 等模型/解析与输出。
   - 扩展 hy2/tuic 额外参数（0-RTT、retry、early-data 等），补齐 TUIC v5 细节。
   - 为 Loon/Surge/Stash/Egern/Surfboard 特性补充解析字段及 Clash Meta/目标端透传。
   - 增加目标端 producer：Stash、Loon、Egern、SurgeMac、Surfboard，并对照 Sub-Store 参数映射。

2) Processor Pipeline （高）
   - 设计并落地类似 Sub-Store processors 的多步流水线（顺序可配置）。
   - 支持正/反向过滤、区域/类型过滤、无用节点过滤、批量属性设置（udp/tfo/skip-cert-verify/标记）、排序/重命名、脚本 operator、Resolve Domain。
   - 前端提供配置 UI，保存/导出执行顺序与参数。

3) 订阅服务增强 （高）
   - fetch 支持自定义 UA/代理、重试/忽略失败策略、缓存策略。
   - 解析远端 subscription-userinfo，回传真实流量/过期时间；支持 profile-update-interval。
   - 支持 noCache/insecure 等参数化刷新；订阅创建/更新时透传设置。
   - [x] 基础：IPC 设置增加 UA/代理/insecure/timeout/noCache，fetchWithOptions 支持代理/证书跳过/禁用缓存；订阅服务透传远端 subscription-userinfo/profile-update-interval。

4) 预处理扩展 （中）
   - 识别 proxy-providers，并从远端 provider 拉取/合并。
   - 支持多订阅合并（例如 url1+url2）、分段 Base64/缺 `=` 自动补齐（已部分完成）、Clash/Sing-box 外的更多格式。
   - 完善 noCache/insecure 参数解析并传递到订阅请求层。
