# /image/ 空白：MIME text/html（非忘 reload）

日期：2026-08-21

## 结论

部署日志里已写 `modules.conf` 并 `nginx -s reload`。空白页是 **JS 资源路径 / SPA 回退**：请求 `.js` 得到 HTML。

## 原因

1. HTML 引用 `/image/assets/*.js`；直连 `:23002/` 时进程只挂了 `/assets`，`/image/assets` 走 NoRoute → `index.html` → MIME 错  
2. 网关 strip 后应对 `/assets`；若上游缺文件或旧 hash，同样回 HTML  

## 修复（imagebed）

- 同时 Static `/assets` 与 `{SDPY_PUBLIC_BASE}/assets`  
- `.js/.css` 不再 SPA 回退  
- `deploy.sh` 先对齐前端 base 再启动；重打 `imagebed-sseinfra.zip`

访问请用 `https://ssemarket.cn/image/`；`:23002/image/` 亦可（修后）。
