# platform.ssemarket.cn 502：deploy.sh NODE_ENV 导致 tsc 缺失

## 背景

- 模块 **ai-platform**（组 `sdpy-ai-platform-p`）部署后 supervisord 显示 RUNNING，网关已写 frp 端口，但 `https://platform.ssemarket.cn/` 返回 **502**。
- 跳板机 `curl 127.0.0.1:{frpPort}` → **Empty reply**；Pod 内 `8080` 无响应。

## 根因

`基础服务/api-platform/deploy.sh` 在 **npm ci / npm run build 之前** 执行 `export NODE_ENV=production`，npm 跳过 devDependencies，构建阶段找不到 `tsc`（Pod deploy 日志可见 `tsc: not found`），Node 进程从未启动。

supervisord 的 `startsecs=3` 会在 shell 脚本退出前短暂认为 RUNNING，部署平台过早写入网关。

## 修复

1. **deploy.sh**：构建阶段不设 `NODE_ENV=production`；仅在 `exec node dist/index.js` 前 export。
2. **deploy-worker**：`publishSseinfraToGateway` 前调用 `waitForFrpHealth(frpPort)`，轮询跳板 `127.0.0.1:{frp}/api/health` 直到 200（超时 10 分钟）。
3. 重打 **`基础服务/api-platform/sseapi-sseinfra.zip`**（`deploy/pack-sseinfra.ps1`）。

## 验证步骤

1. 在 sdpy 管理台上传新 zip，对 ai-platform **正式环境**重新部署。
2. 部署日志应出现 `[k8s] 应用健康检查通过 frp:…/api/health`。
3. `curl -sI https://platform.ssemarket.cn/` 非 502；`curl https://api.ssemarket.cn/api/health` → 200。

## 部署 deploy-api 改动

若需 `waitForFrpHealth` 生效，重建并重启 **sdpy-api**（与 sseinfra 建组修复同一套镜像流程）。

## 未决

- 现网 Pod 需用户触发一次重新部署才能应用新 zip；本地无法直接改运行中容器内已失败的 build。
