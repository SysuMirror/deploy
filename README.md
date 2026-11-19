# SSE 部署台（sdpy）

软工集市的模块部署平台，生产入口：<https://deploy.ssemarket.cn>。

面向校内项目组：上传压缩包或连接 Git 仓库即可部署，模块内区分**测试 / 正式**两套环境，
底层算力由集市云 SSEINFRA（WZ8 k3s，`clouds` 命名空间）提供。

## 功能

- **项目 / 模块**：项目下建模块，模块支持「压缩包」与「Git 仓库」两种部署来源
- **双环境**：测试 / 正式各自拥有访问地址、环境变量、数据目录、对象存储与部署历史，支持测试成功后晋升正式
- **部署流水线**：包模式经跳板机同步到 k3s 组容器；Git 模式调用 SSEINFRA Deploy API；支持取消、回滚、失败日志
- **域名与网关**：模块可绑定平台子域或自定义域名，自动生成 nginx 反代与证书
- **对象存储**：MinIO 同步（图片等二进制与业务库分离）
- **自动化**：Webhook 自动部署、部署 Agent 生成 `deploy.sh`、构建失败 AI 自愈
- **监控中心**：访问日志、QPS / 耗时 / 错误趋势、宿主机进程管理
- **脚本部署**：非平台应用的宿主机脚本，网页下发执行
- **管理台**：审批、容器 / 镜像 / 数据卷 / 网络、审计、系统状态、数据恢复
- **登录**：UniSSO 单点登录（OAuth2），平台管理员按集市用户 ID 授权

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 + Vite + Pinia + 自研组件库 `@sse/ui` |
| 后端 | Express + TypeScript + better-sqlite3（WAL） |
| 运行时 | Docker Compose（`apps/deploy-api`）+ 宿主机 nginx 网关 |
| 目标集群 | 集市云 SSEINFRA / WZ8 k3s（`clouds` 命名空间） |

## 仓库结构

```
apps/deploy-api/    后端（Express，默认 :3002）
apps/deploy-web/    前端（Vue 3，构建产物 dist/ 与 dist-deploy/）
deploy/             网关 compose、nginx 片段、OAuth 配置、示例部署包
docs/               设计与运维文档（架构、部署约定、验收清单等）
```

> 历史发布包、构建产物、运行数据（SQLite、上传包、工作目录）均不入库。

## 本地开发

前置：Node.js ≥ 20、npm。

**注意：`@sse/ui` 不在本仓库内。** 根 `package.json` 的 workspace 与前端 Vite alias
都指向同级的 `packages/sse-ui`，请按以下任一方式准备：

```text
workspace/
  packages/sse-ui/      # 组件库（另仓）
  deploy/               # 本仓库
```

或修改根 `package.json` 的 `workspaces` 与 `apps/deploy-web/vite.config.ts` 中的
`@sse/ui` alias，指向你本机的组件库路径。

```bash
npm install
npm run build:ui          # 先构建 @sse/ui

npm run dev:api           # API：http://localhost:3002
npm run dev:web           # Web：http://localhost:5174（/api 代理到 3002）
```

配置：复制 `apps/deploy-api/.env.example` 为 `apps/deploy-api/.env` 后填写。
OAuth 接入说明见 [`deploy/oauth/README.md`](deploy/oauth/README.md)。

## 构建

```bash
npm run build:api         # → apps/deploy-api/dist
npm run build:web         # → apps/deploy-web/dist（/sdpy 前缀模式）
npm run build:web-deploy  # → apps/deploy-web/dist-deploy（deploy.ssemarket.cn 子域模式）
```

生产的 `apps/deploy-api/dist` 是 bind mount 进容器的，更新源码后需要
`docker restart sdpy-api` 才会生效（Node ESM 启动时缓存模块）。

## 部署与配置

- 后端：`apps/deploy-api/docker-compose.yml`，数据统一落在宿主机
  `${SDPY_HOST_DATA}/data/`（库、上传、工作目录、模块网关配置）
- 网关：公共 nginx 只加一次 `deploy/nginx-ssemarket-sdpy.conf.snippet`；
  模块路由由 API 写入 `data/nginx/modules.conf` 后 reload
- 目标集群：SSEINFRA 相关地址与凭据通过 `.env` 注入，仓库内不存放任何真实密钥
- 包结构约定见 [`docs/用户部署约定.md`](docs/用户部署约定.md)

## 安全约定

- 不提交 `.env`、`.env.*`、SQLite 数据库、上传包、`node_modules`、构建产物
- `.env.example` 只保留空占位，禁止写入真实密钥
- 部署数据全部位于宿主机数据目录，源码仓库可随时重新检出

## 文档

- [用户部署约定](docs/用户部署约定.md) — 压缩包 / compose / 前端 API 地址配置
- [OAuth2 登录接入与复制指南](docs/OAuth2-登录接入与复制指南.md)
- [部署与数据存储指南](docs/SSE-Deploy-部署与数据存储指南.md)
- [验收清单](docs/iwiki-SSE-Deploy-验收清单.md)

## License

见 [LICENSE](LICENSE)。