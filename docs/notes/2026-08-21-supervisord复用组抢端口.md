# 复用组二次部署 supervisord 抢 sock

日期：2026-08-21

## 现象

`Another program is already listening on a port that one of our HTTP servers is configured to use`（再起 supervisord 失败）。

## 原因

1. `supervisorctl status` 失败时盲启第二份 supervisord  
2. 每次新 `programId`，旧 `deploy-*` 仍占 8080

## 修复（sseinfra-pod）

- ctl / pid 判定已运行则跳过 start  
- 先 stop/remove 全部旧 `deploy-*`，再写新 conf 并 start  
- awk 须单引号包 `$1`，否则 shell 展开为空 → 整行被当成进程名  
- 解压后 `chmod +x bin/*`，避免 zip 丢执行位又去下 Go  

须更新现网 `sdpy-api` dist；imagebed 建议重传新 zip（根路径 `/image/`）。
