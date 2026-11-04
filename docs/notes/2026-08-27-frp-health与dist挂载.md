# 2026-08-27 frp 健康检查误等 + dist 未挂载到容器

## 现象

1. supervisord 已 `RUNNING`、Pod 日志里 `[sseapi] listening`，部署仍卡：
   ```
   [k8s] 等待应用就绪… 7s (frp:23009/api/health)
   ```
2. 取消接口返回旧文案：`{"ok":true,"message":"已请求取消，正在停止"}`，且长时间仍显示「部署中」。

## 根因

**sdpy-api 实际执行的是 Docker 镜像内 `/app/dist`，不是宿主机 `${SDPY_HOST_DATA}/dist`。**

- `Dockerfile`：`COPY dist ./dist` → 进程 `node dist/index.js`（WORKDIR `/app`）
- `docker-compose` 只挂了 `${SDPY_HOST_DATA}` 到同名路径，**未覆盖 `/app/dist`**
- 在宿主机改 `/root/SSE_Market/sse-sdpy/api/dist` 后 `docker restart` **不会**更新运行代码

## frp 健康检查

`waitForFrpHealth` 曾用 SSH 跳板 curl / 容器 fetch frp 端口，在 Pod 重建、frp 切换窗口内易误报；旧版成功部署**无此步骤**。

**处理（2026-08-27）**：去掉部署流水线中的健康检查；supervisord `RUNNING` 后直接 `[gateway]` 写 nginx（与旧行为一致）。

## 修复

1. `docker-compose.yml` 增加：`${SDPY_HOST_DATA}/dist:/app/dist`
2. 删除 `deploy-worker` 中对 `waitForFrpHealth` 的调用
3. 取消：`AbortSignal` + 杀 ssh/scp 子进程 + 立即 `status=cancelled`

## 验证

```bash
docker exec sdpy-api grep "已请求取消" /app/dist/services/deploy-worker.js
# 应无输出

docker exec sdpy-api grep "waitForFrpHealth" /app/dist/services/deploy-worker.js
# 应无输出（或仅注释）
```

改 dist 后：`docker compose -f /root/SSE_Market/sse-sdpy/api/docker-compose.yml up -d`（需 recreate 以应用 volume）。
