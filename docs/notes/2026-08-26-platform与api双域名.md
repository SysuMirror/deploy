# Logo + platform/api 双域名

> 日期：2026-08-26

## 结论

部署平台**已支持**模块多域名；原先把 `api` 放在保留子域里，无法绑定 `api.ssemarket.cn`。现已：

1. 从保留列表移除 `api`（`platform` 本就不保留）
2. 域名增加 **用途** `routeTarget`：`web`（前端）/ `api`（后端）
3. 网关按用途选上游端口；部署注入 `SDPY_PUBLIC_URL` / `SDPY_API_PUBLIC_URL` 分别取 web/api 域名

## sseapi 绑定步骤（正式环境）

模块建议名：`sseapi`（路径仍可用，双域为主入口）

| 用途 | 子域标签 | 完整域名 | routeTarget | 主域名 |
|------|----------|----------|-------------|--------|
| 前端控制台 | `platform` | `platform.ssemarket.cn` | web | 勾选主 |
| 后端 API | `api` | `api.ssemarket.cn` | api | 否 |

1. **先重新部署 sdpy**（本改动）使管理台出现「用途」选项并放开 `api` 标签  
2. 模块页 → 访问域名 → 按上表添加两条  
3. 配置 OAuth 回调：`https://platform.ssemarket.cn/oauth/callback`  
4. 环境变量：`SSEAPI_OAUTH_*`、`PLATFORM_ADMIN_OAUTH_IDS`、`JWT_SECRET`  
5. 部署模块；成功后网关写 Host，访问 platform / api  

## 应用侧

- Logo：`web/public/logo.png`
- 构建：`VITE_BASE_PATH=/`，`VITE_API_BASE=$SDPY_API_PUBLIC_URL`（默认 `https://api.ssemarket.cn`）
- CORS：允许 `platform.ssemarket.cn`

## 验证

```bash
cd sse-deploy && npm run build
# 部署 sdpy 后
curl -Ik https://platform.ssemarket.cn
curl -Ik https://api.ssemarket.cn/api/health
```
