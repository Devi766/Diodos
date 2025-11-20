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
