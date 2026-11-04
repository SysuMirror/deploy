> **版本**：v1.0  
> **状态**：内测对齐当前实现  
> **目录**：`apps/deploy-web`

---

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 技术栈 | Vue 3 + Vue Router + Vite |
| UI | workspace `@sse/ui`（品牌色 Azure / `#0284c7`） |
| 生产 base | `/sdpy/` |
| 开发 base | `/` |

---

## 2. 目录结构（要点）

```text
apps/deploy-web/src/
  config/        brand、api-base
  layouts/       DeployLayout
  views/         Login / Projects / ProjectDetail / ModuleDetail / OAuthCallback
  components/    Header、Sidebar、BrandMark、EnvBadge
  composables/auth/  OAuth 登录与回调
  stores/        auth、deploy
  services/api.ts    后端调用
  router/
```

---

## 3. 信息架构

```
登录
 → 项目列表
    → 项目详情（模块卡片）
       → 模块详情
          ├─ 上传 zip
          ├─ 测试页签：部署 / 日志 / 查看访问链接
          └─ 正式页签：同上
```

模块详情内 **测试 / 正式** 为页签（环境挂在模块上，而非项目级切换）。  
访问链接默认收起，点「查看访问链接」后以表格展示。

---

## 4. 认证

- SSE Market OAuth（授权码）
- 前端存会话 token；请求头带 Bearer
- 回调路由：`/oauth/callback`（开发）或 `/sdpy/oauth/callback`（生产 base）
- 相关：`composables/auth/*`、`views/LoginView.vue`、`OAuthCallbackView.vue`

---

## 5. API 基址

| 环境 | 配置 |
|------|------|
| 开发 | `VITE_API_BASE=/api`（Vite 代理到 deploy-api） |
| 生产构建 | `VITE_API_BASE` 指向平台 API 公网前缀（如 `/sdpy-api` 或完整 URL，见构建说明） |

`services/api.ts` 统一封装 projects / modules / deployments / auth。

---

## 6. 状态与轮询

- 部署触发后轮询部署状态与日志流（模块详情页）
- 成功后展示访问链接（前端/后端各一）
- 支持可选「无缓存构建」勾选，映射部署参数 `noCache`

---

## 7. 品牌与视觉

- `config/brand.ts`：产品名 SSE Deploy、tagline、logo（`public/logo.png`）
- 避免实训站风、过深蓝；与基建其他平台一致使用 SoftLab/SSE UI 组件

---

## 8. 构建产物去向

```bash
npm run build:web
# dist → 可复制到
#   apps/deploy-api/public/   （若 API 兼静态）
#   deploy/gateway/html/      （网关挂载）
#   release-sdpy/web/         （上机包）
```

构建产物默认 **不进 Git**（见 `.gitignore`）。

---

## 9. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-09 | 初稿 |
