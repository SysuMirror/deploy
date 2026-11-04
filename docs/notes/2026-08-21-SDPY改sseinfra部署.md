# 2026-08-21 SDPY 改造为 sseinfra 部署

## 方案

见 `docs/plans/2026-08-21-sseinfra部署执行方案.md`。

- **默认运行时** `DEPLOY_RUNTIME=sseinfra`
- SDPY 负责权限/模块/点部署；WZ8 sseinfra 负责建组 + clone + `deploy.sh`
- 表单 HTTP 即 API（Cookie + CSRF / `X-CSRF-Token`）

## 代码

| 文件 | 说明 |
|------|------|
| `apps/deploy-api/src/services/sseinfra-client.ts` | 登录、建组、deploy add/run/status/logs |
| `apps/deploy-api/src/services/deploy-worker.ts` | `runSseinfraDeploy`；`DEPLOY_RUNTIME=compose` 仍走旧路径 |
| `apps/deploy-api/src/routes/deployments.ts` | sseinfra 下默认/强制 `source=git` |
| `apps/deploy-api/src/config/load-env.ts` | 兼读仓库根 `.env`（`k8s_password`→面板密码） |
| `apps/deploy-web/.../ModuleDetailView.vue` | 默认 Git；文案改为 deploy.sh |
| `deploy/examples/sseinfra-deploy.sh` | 仓根脚本模板 |

组名：`sdpy-{module}-t|p`（test/prod）。

## 验证

1. 配置模块 Git HTTPS 地址；仓根放可执行 `deploy.sh`（可参考 examples）
2. `apps/deploy-api`：`pnpm dev` / 既有启动方式；确认能读到 `SSEINFRA_PASSWORD` 或 `k8s_password`
3. 控制台部署测试环境 → 日志出现 `[sseinfra]` → success 后 URL 为 `http://ssemarket.cn:23xxx`
4. 回退本机 compose：`DEPLOY_RUNTIME=compose`

## 未做（下期）

- 自动建 MinIO 桶/发密钥
- 砍死 zip UI
- sseinfra 原生 Bearer JSON
