> **版本**：v1.0  
> **状态**：内测对齐当前实现  
> **仓库**：https://gitee.com/xindonhub/sse-deploy

---

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 目的 | 说明 SSE Deploy 为何这样设计、请求如何到达用户容器 |
| 读者 | 开发 / 运维 / 评审 |
| 配套 | 《云部署平台》《后端与部署流水线》《构建与运维》 |

---

## 2. 设计原则

| 原则 | 含义 |
|------|------|
| 平台解耦 | 与 iWiki / TQPD 独立；仅 OAuth 与公共 nginx 弱关联 |
| 用户包自治 | 用户提供 `frontend/` + `backend/` + `compose.yml`，平台不改用户业务代码 |
| 双环境隔离 | 测试 / 正式各一套 compose 项目，互不停对方 |
| 路径统一 | 全部挂在 `/sdpy/...`，不给每模块自定义域名 |
| 公共反代少改 | 公共 nginx 只加一次 snippet；逐模块 location 由 API 写 `modules.conf` |
| 可见占用 | 模块端口映射到宿主机，`docker ps` 可见属预期 |

---

## 3. 系统组成

| 组件 | 形态 | 职责 |
|------|------|------|
| deploy-web | Vue SPA | 登录、项目/模块、上传、部署、日志、访问链接 |
| deploy-api | Node/Express + SQLite | 鉴权、元数据、收包、排队部署、写路由 |
| 用户模块容器 | `docker compose` | 用户自己的 web + api |
| 公共 nginx | 已有容器 | SPA、`/sdpy-api/`、include 模块路由 |

仓库 monorepo：`apps/deploy-web`、`apps/deploy-api`，UI 依赖 workspace `@sse/ui`。

---

## 4. 端到端数据流

### 4.1 管理站

```
浏览器 → 公共 nginx /sdpy/ → 静态 SPA
浏览器 API → 公共 nginx /sdpy-api/ → 宿主机 :3002（sdpy-api）
```

### 4.2 用户模块（部署成功后）

```
浏览器
  → /sdpy/test/{name}/ 或 /sdpy/{name}/
  → 公共 nginx include modules.conf
  → proxy_pass http://host.docker.internal:{webPort|apiPort}/
  → 用户 compose 映射的宿主机端口
  → 用户 web / api 容器
```

关键约束：

1. 公共 nginx **在 Docker 内**，不能用 `127.0.0.1` 当 upstream（那是 nginx 自己）。
2. API 生成路由时 `GATEWAY_UPSTREAM_HOST=host.docker.internal`。
3. 用户 compose 端口须 `"${WEB_HOST_PORT}:80"`，**不要**绑 `127.0.0.1:`，否则从 docker0 进不来 → 502。

---

## 5. 部署原理

```
用户上传 zip
  → package-store 解压校验（frontend/backend/compose）
  → 落盘 uploads/{moduleId}/{version}/
创建「部署测试/正式」
  → allocatePorts() 分配 webPort / apiPort
  → 复制包到 work/{deploymentId}/
  → 写 .env.sdpy（含端口与公网路径变量）
  → docker compose -p sdpy-{env}-{name} up -d --build --force-recreate
  → 成功则写 modules 活跃端口 + regenerateNginxRoutes()
  → GATEWAY_RELOAD_CMD reload 公共 nginx
```

compose 项目名：`sdpy-test-{模块}` / `sdpy-prod-{模块}`，与机器其他容器隔离。

---

## 6. 端口池原理

- 起点：`DEPLOY_PORT_START`（默认 **8100**）
- 每次部署取库内已用端口最大值，再 `+1` / `+2` 给 web / api
- 写入部署记录与模块活跃槽位
- **不回收空洞**（简化实现）；长期运行端口会递增

公网只走路径反代，不直接把 `810x` 暴露给业务域名规则。

---

## 7. 路由生成原理

`routing.ts` 扫描各模块活跃端口，生成仅含 `location` 的片段，例如：

```nginx
location /sdpy/test/demo/ {
  proxy_pass http://host.docker.internal:8100/;
  ...
}
location /sdpy/test/demo-api/ {
  proxy_pass http://host.docker.internal:8101/;
  ...
}
```

文件路径：`api/data/nginx/modules.conf`  
公共 nginx：`include` 该文件（只加一次配置）。

---

## 8. 路径规则（非公网入口清单）

| 环境 | 前端路径 | API 路径 |
|------|----------|----------|
| 测试 | `/sdpy/test/{模块}/` | `/sdpy/test/{模块}-api/` |
| 正式 | `/sdpy/{模块}/` | `/sdpy/{模块}-api/` |

管理站 SPA：`/sdpy/`；平台 API：`/sdpy-api/`。  
完整公网 URL 内测阶段见管理台「查看访问链接」，文档暂不罗列。

---

## 9. 与早期 PRD 的差异

| PRD 设想 | 当前实现 |
|----------|----------|
| 绑 Git 选分支部署 | 上传 zip |
| 独立平台网关容器 | 公共 nginx include modules.conf |
| Header 灰度 / 镜像晋升 | 测试/正式独立 compose |
| 多环境 OA 配额审批 UI | 默认配额 + 库内调整为主 |

详见《需求与范围》。

---

## 10. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-09 | 初稿：对齐线上 zip + compose + 公共 nginx 模型 |
