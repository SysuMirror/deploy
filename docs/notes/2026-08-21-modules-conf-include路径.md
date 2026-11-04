# /image 跳到博客：modules.conf include 路径不一致

日期：2026-08-21

## 现象

访问 `https://ssemarket.cn/image/` 跳到站点根博客，未进 K8s frp（如 `:23002`）。

## 原因

平台已按组 Web 提取端口并写入 modules.conf、也会 reload，但**公共 nginx include 的文件路径必须与写入路径相同**。

| 角色 | 路径（现网一例） |
|------|------------------|
| deploy-api 写入 | `/root/SSE_Market/sse-sdpy/api/data/nginx/modules.conf` |
| 旧 snippet | `include /opt/release-sdpy/api/data/nginx/modules.conf` |

路径不一致 → 没有 `location /image/` → 落到博客。

## 处理（现网立刻）

1. 看部署日志里的绝对路径  
2. 公共 nginx `server {}` 改为：

```nginx
include /root/SSE_Market/sse-sdpy/api/data/nginx/modules.conf;
```

3. `nginx -t && nginx -s reload`（或 `GATEWAY_RELOAD_CMD`）  
4. 确认 conf 内有：

```nginx
location /image/ {
  proxy_pass http://host.docker.internal:23002/;
}
```

（`GATEWAY_UPSTREAM_HOST` 以现网为准。）

仓库 snippet 已改为上述路径示例：`deploy/nginx-ssemarket-sdpy.conf.snippet`。
