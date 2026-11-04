> **版本**：v1.0  
> **状态**：内测  
> **注意**：完整公网入口暂不公开；密钥勿写入 Wiki / Git

---

## 1. 仓库与本地开发

仓库：https://gitee.com/xindonhub/sse-deploy

```bash
cd sse-deploy
npm install
npm run build:ui

# 终端 1
npm run dev:api    # 默认 :3002

# 终端 2
npm run dev:web    # 默认 :5174
```

- 本地 API 环境：`apps/deploy-api/.env`（OAuth 用 `ssemarket-sdpy_local`）  
- 生产模板：`apps/deploy-api/.env.production`（勿提交真实密钥；已被 gitignore）  
- 冒烟：`npm run smoke -w deploy-api`（需 API 已起）

OAuth 登记说明见仓库 `deploy/oauth/README.md`（`credentials/` 目录已 ignore）。

---

## 2. 生产形态（当前推荐）

| 组件 | 建议 |
|------|------|
| deploy-api | Docker 容器 `sdpy-api`，端口 `3002` 对宿主开放（勿仅绑 127.0.0.1，以便 nginx 容器访问） |
| SPA | 静态文件挂公共 nginx `/sdpy/` |
| 模块路由 | `include` → `api/data/nginx/modules.conf` |
| 平台 API | `/sdpy-api/` → `host.docker.internal:3002` |
| **持久化** | **全部在宿主机** `${SDPY_HOST_DATA}/data/`（库、uploads、work、modules.conf）；compose 同路径挂载；rebuild **不丢数据** |

上机包目录（本地生成，**不进 Git**）：`release-sdpy/`  
含 `api/`（Dockerfile、compose、dist）、`web/`、nginx snippet、说明。

### 数据目录（务必外置）

```text
${SDPY_HOST_DATA}/data/
  deploy.db
  uploads/
  work/
  nginx/modules.conf
```

`.env` 必填：`SDPY_HOST_DATA=/绝对路径/到/api`。  
entrypoint 若检测到 `DEPLOY_DATA_DIR` 落在 `/app/...` 会**拒绝启动**，防止写进镜像层。

---

## 3. 关键环境变量

| 变量 | 说明 |
|------|------|
| `SDPY_HOST_DATA` | 宿主机 api 目录绝对路径（compose 挂载必填） |
| `GATEWAY_UPSTREAM_HOST` | Docker nginx 场景：`host.docker.internal` |
| `GATEWAY_RELOAD_CMD` | `docker exec <真实容器名> nginx -s reload` |
| `DEPLOY_PORT_START` | 端口池起点，默认 8100 |
| `MAX_CONCURRENT_DEPLOYS` | 同时构建部署上限，默认 2 |
| `OAUTH_*` | Market OAuth |
| `PLATFORM_ADMIN_OAUTH_IDS` | 平台管理员 oauth id 列表（留空默认 `561`） |
| `BASE_DOMAIN` / `PUBLIC_BASE_PATH` | 域名与模块公网前缀（默认 `/` 根路径模式） |
| `AGENT_FIXER_ENABLED` / `AGENT_FIXER_API_KEY` | 部署失败自愈修复器开关与密钥（留空不启用） |
| `AGENT_FIXER_BASE_URL` / `AGENT_FIXER_MODEL` | 修复器 LLM 端点与模型（默认 DeepSeek） |
| `AGENT_MAX_ATTEMPTS` | 每个部署失败后自动重试上限，默认 1 |

compose 中 `GATEWAY_UPSTREAM_HOST` 应从 `.env` 注入，**不要写死 127.0.0.1**。

---

## 4. 公共 nginx 要点

一次性加入 snippet（仓库 `deploy/nginx-ssemarket-sdpy.conf.snippet`）：

- `/sdpy-api/` → API  
- `/sdpy/` → SPA alias  
- `include` modules.conf  

nginx 容器需能解析 `host.docker.internal`（`extra_hosts: host-gateway`）。  
`GATEWAY_RELOAD_CMD` 用 **容器名**（如 `sse_market_server-nginx_proxy-1`），不是镜像名。

---

## 5. 常见故障

| 现象 | 处理 |
|------|------|
| 502 | 查 modules.conf upstream；模块端口是否 `0.0.0.0`；nginx 探活 `host.docker.internal:端口` |
| reload 失败 No such container | 修正容器名 |
| mount path `:` | `SDPY_HOST_DATA` 为空 |
| compose 失败 | API 容器内 `docker compose version`；CLI/plugin 挂载 |

---

## 6. 构建命令

```bash
npm run build          # ui + web + api
# 将 web dist 拷到发布目录 / 网关 html / api public（按部署方式）
```

---

## 7. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-09 | 初稿（不含公网入口清单） |
