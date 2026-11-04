# SSE Deploy OAuth 登记

SSE Market 的 OAuth 应用存在表 `oauth2_apps`，**每个 app 只能登记一条 `redirect_uri`**（精确匹配），因此生产与本地各建一个应用。

## 应用一览

| 环境 | app_id | app_name | redirect_uri | 配置文件 |
|------|--------|----------|--------------|----------|
| 生产（路径） | `ssemarket-sdpy` | SSE Deploy | `https://ssemarket.cn/sdpy/oauth/callback` | `apps/deploy-api/.env.production` |
| 生产（子域） | 同上 | 同上 | `https://deploy.ssemarket.cn/oauth/callback` | 同 app_id，`alt_redirect_uri` + `OAUTH_APP_SECRET_DEPLOY` |
| 本地/测试 | `ssemarket-sdpy_local` | SSE Deploy (Local) | `http://localhost:5174/oauth/callback` | `apps/deploy-api/.env` |

`app_secret`、SQL、额外备份在 `deploy/oauth/credentials/`（已 gitignore）。

本地 Market 库插入（若尚未登记）：

```sql
INSERT INTO oauth2_apps (
  app_id, app_name, app_secret, app_icon, redirect_uri, description, is_active, created_at, updated_at
) VALUES (
  'ssemarket-sdpy_local',
  'SSE Deploy (Local)',
  '8860f0fbcec2fe7869354c62e6bce43d795ee9c47e1401c3a8d9d326c385c888',
  '',
  'http://localhost:5174/oauth/callback',
  'SSE Deploy 本地开发',
  1,
  NOW(),
  NOW()
);
```

## 上机步骤

### 1. 写入 OAuth 应用（进 MySQL 容器）

目标容器：`sse_market_db`（库 `ssemarket`，宿主机端口 `3506`）。

把 `credentials/register-oauth-apps.sql` 拷到服务器后：

```bash
# 方式 A：管道执行（推荐）
docker exec -i sse_market_db mysql -uroot -padmin ssemarket < register-oauth-apps.sql

# 方式 B：进容器交互
docker exec -it sse_market_db mysql -uroot -padmin ssemarket
# 然后粘贴 SQL 或 source /path/to/register-oauth-apps.sql
```

确认：

```bash
docker exec -it sse_market_db mysql -uroot -padmin ssemarket \
  -e "SELECT app_id, app_name, redirect_uri, is_active FROM oauth2_apps WHERE app_id LIKE 'ssemarket-sdpy%';"
```

### 2. 部署 Deploy API

使用 `apps/deploy-api/.env.production`（复制为服务器 `.env`），监听 `127.0.0.1:3002`。

### 3. 验证 check 接口

```bash
curl -s -X POST https://ssemarket.cn/api/auth/connect/check \
  -H "Content-Type: application/json" \
  -d '{"appid":"ssemarket-sdpy"}'
```

应返回 `app_name: SSE Deploy`。

### 4. 登录

打开 `https://ssemarket.cn/sdpy/`（需先配好公共 nginx 的 `/sdpy`、`/sdpy-api` 与网关）。

## 注意

- 勿把 `credentials/`、`.env.production` 提交到 Git  
- 生产回调必须与 nginx 前端路径一致：`/sdpy/oauth/callback` 或 `deploy.ssemarket.cn/oauth/callback`  
- **同 app_id 双入口**：OAuth 表 `alt_redirect_uri` / `alt_app_secret`；deploy-api 按 `Host` 选 `OAUTH_APP_SECRET_DEPLOY`  
- 若库中已有同名 `app_id`，SQL 使用 `ON DUPLICATE KEY UPDATE` 覆盖 secret / redirect / alt_*  
- 首次加 alt 列：`ALTER TABLE oauth2_apps ADD COLUMN alt_redirect_uri …`（见 `register-oauth-apps.sql` 注释）
