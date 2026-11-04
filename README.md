# SSE Deploy（sdpy）

云部署平台简化版：上传 zip（`frontend/` + `backend/` + `compose.yml`）→ `docker compose` 部署测试/正式 → 平台网关按 `/sdpy` 路径反代。

## 本地开发

```bash
cd sse-deploy
npm install
npm run build:ui

# 终端 1
npm run dev:api   # http://localhost:3002

# 终端 2
npm run dev:web   # http://localhost:5174
```

OAuth：见 [`deploy/oauth/README.md`](deploy/oauth/README.md)。  
上机用 `apps/deploy-api/.env.production`；本地用 `.env`（`ssemarket-sdpy_local`）。  
先在 Market 库执行 `deploy/oauth/credentials/register-oauth-apps.sql`。

开发态前端 `VITE_BASE_PATH=/`；生产构建使用 `/sdpy/`。

本地冒烟（绕过 OAuth，需 API 已启动）：

```bash
npm run smoke -w deploy-api
```

示例可部署包：`deploy/examples/sample-app/`（整目录打成 zip 上传）。验收项见 [`docs/验收清单.md`](docs/验收清单.md)。

## 使用流程

1. OAuth 登录 → 创建项目 → 注册模块名  
2. 模块详情上传 zip（结构见 [`docs/用户部署约定.md`](docs/用户部署约定.md)）——或配置 Git 仓库（Gitee / GitHub）后按分支部署  
3. 「部署测试」或「部署正式」  
4. 访问：
   - 测试前端 `https://ssemarket.cn/sdpy/test/{name}/`
   - 测试 API `https://ssemarket.cn/sdpy/test/{name}-api/`
   - 正式前端 `https://ssemarket.cn/sdpy/{name}/`
   - 正式 API `https://ssemarket.cn/sdpy/{name}-api/`

平台管理站本身：`https://ssemarket.cn/sdpy/`

## 生产部署

**推荐：deploy-api 跑在宿主机**（需本机 Docker，工作目录路径即宿主机路径，避免 docker.sock 路径错位）。网关可用容器。

```bash
npm run build
mkdir -p deploy/gateway/html
# Windows: xcopy /E /I apps\deploy-web\dist deploy\gateway\html
cp -r apps/deploy-web/dist/* deploy/gateway/html/

# API（宿主机）
cd apps/deploy-api && node dist/index.js

# 网关
cd ../../deploy && docker compose up -d gateway
```

若 API 也容器化，须保证容器内 `WORK_DIR` / 上传目录与宿主机**绝对路径一致**（docker 守护进程按宿主机路径 build）。

公共 nginx **只加一次** [`deploy/nginx-ssemarket-sdpy.conf.snippet`](deploy/nginx-ssemarket-sdpy.conf.snippet)：

- `/sdpy-api/` → deploy-api  
- `/sdpy/` → 平台网关（SPA + 用户模块）  

模块路由由 API 写入 `data/nginx/modules.conf`，经 `GATEWAY_RELOAD_CMD` reload **平台网关**，不改公共反代。

生产 OAuth 回调示例：`https://ssemarket.cn/sdpy/oauth/callback`

## 文档

- [用户部署约定](docs/用户部署约定.md) — zip / compose / 前端 API 地址配置  
- [灰度发布设计](docs/灰度发布设计.md) — 旧版说明，初版已弱化
