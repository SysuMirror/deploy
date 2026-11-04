> **版本**：v1.0  
> **状态**：内测对齐当前实现  
> **目录**：`apps/deploy-api`

---

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 运行时 | Node.js + TypeScript（Express） |
| 数据库 | SQLite（`better-sqlite3`），文件在 `data/deploy.db` |
| 关键端口 | 默认 `3002` |

---

## 2. 模块划分

| 路径 | 职责 |
|------|------|
| `routes/auth.ts` | OAuth 授权、回调、`/auth/me` |
| `routes/projects.ts` | 项目 CRUD / 成员 |
| `routes/modules.ts` | 模块 CRUD、上传 zip |
| `routes/deployments.ts` | 创建部署、查状态/日志 |
| `services/package-store.ts` | 解压、布局校验、版本目录 |
| `services/deploy-worker.ts` | 异步执行 compose |
| `services/routing.ts` | 路径规则、modules.conf、reload |
| `services/project.ts` | 配额、端口分配、槽位 |
| `db/init.ts` | Schema / 迁移列 |

---

## 3. 上传与包版本

1. multer 接收 `package` 字段  
2. `uploads/{moduleId}/{version}/source.zip`  
3. 解压到 `_extract`，识别是否多包一层目录  
4. 校验存在 `frontend/`、`backend/`、`compose.yml`（或 docker-compose 变体）  
5. 规范化到 `.../app`，更新模块 `package_path` / `package_version`  
6. 重新上传 = 新版本；下次部署用最新包  

---

## 4. 部署流水线（Worker）

`enqueueDeployment` → `setImmediate` 跑 `runComposeDeploy`：

| 阶段 status | 动作 |
|-------------|------|
| unpacking | 复制包到 `work/{deploymentId}/`，检查 docker compose |
| building | `docker compose -p sdpy-{env}-{name} --env-file .env.sdpy up -d --build [--no-cache] --force-recreate` |
| deploying | 写活跃槽位、生成公网/本地 URL |
| success / failed | 结束；success 后 `regenerateNginxRoutes` |

`.env.sdpy` 注入：`SDPY_ENV`、`SDPY_MODULE`、`WEB_HOST_PORT`、`API_HOST_PORT`、`SDPY_*_PUBLIC_*` 等。

API 容器须挂载：

- Docker socket + 宿主机 docker CLI  
- `SDPY_HOST_DATA` 绝对路径（与宿主机一致，供守护进程 build）  

---

## 5. 端口分配

`allocatePorts()`：

- 读 `DEPLOY_PORT_START`（默认 8100）  
- UNION 查询历史部署端口与模块活跃端口  
- 返回 `{ webPort: max+1, apiPort: max+2 }`  

创建部署记录时即占用这对端口。

---

## 6. 路由与 reload

`regenerateNginxRoutes`：

1. `listActiveRoutes()`  
2. 写 `data/nginx/modules.conf`  
3. 执行 `GATEWAY_RELOAD_CMD`（如 `docker exec <nginx容器名> nginx -s reload`）  

upstream 主机：`GATEWAY_UPSTREAM_HOST`（生产 Docker nginx 场景用 `host.docker.internal`）。

---

## 7. 主要 API 面（摘要）

| 前缀 | 说明 |
|------|------|
| `/api/health` | 健康检查 |
| `/api/auth/*` | OAuth |
| `/api/projects/*` | 项目 |
| `/api/modules/*` | 模块与上传 |
| `/api/deployments/*` | 部署任务 |

鉴权：`authMiddleware`；平台管理员：`PLATFORM_ADMIN_OAUTH_IDS` → `isPlatformAdmin`。

---

## 8. 数据目录

```text
data/
  deploy.db
  uploads/{moduleId}/{version}/
  work/{deploymentId}/
  nginx/modules.conf
```

生产由 `DEPLOY_DATA_DIR` / `WORK_DIR`（compose 常覆盖为 `SDPY_HOST_DATA/data`）决定。

---

## 9. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-09 | 初稿 |
