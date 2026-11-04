> **版本**：v1.2  
> **状态**：内测中（正式访问入口待稳定后补充）  

---

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 产品名称 | SSE Deploy（sdpy） |
| 产品形态 | deploy-web（Vue）+ deploy-api（Node） |
| 优先级 | P0（一期） |
| 身份登录 | SSE Market OAuth（`ssemarket-sdpy`） |
| 与其他平台关系 | 与 iWiki / TQPD **解耦独立**，通过超链接弱关联 |
| 仓库目录 | `sse-deploy/` |

> 说明：本页描述**当前实现**。公网访问地址暂不公开，内测稳定后再补。同空间内「Deploy 云部署测试接入平台」为早期 PRD 稿，部分能力（Git 绑定、多环境配额 OA 等）尚未在本版落地。

---

## 2. 背景与目标

### 2.1 定位

**上传压缩包 → 一键 Docker Compose 部署 → 按路径规则反代访问** 的轻量云部署平台。

用户无需改公共 nginx 逐模块配置；平台自动分配宿主机端口、生成模块路由并 reload 网关。

### 2.2 产品目标

| 目标 | 说明 |
|------|------|
| 低门槛上云 | zip 含 `frontend/` + `backend/` + `compose.yml` 即可部署 |
| 双环境隔离 | 模块内分别部署 **测试 / 正式**，互不影响 |
| 路径规范 | 统一挂在 `/sdpy/...` 路径前缀下 |
| 容器隔离 | compose 项目名 `sdpy-{env}-{模块名}`，与机器上其他业务共存 |
| 身份统一 | Market OAuth，免单独注册 |

### 2.3 非目标（本版不做）

- 不对接 Git 仓库选分支部署（改为上传 zip）
- 不暴露 Jenkins / Harbor 原语 UI
- 不自建独立平台网关容器（模块路由 **include 进公共 nginx**）
- 不做 K8s；仅 Docker Compose + Nginx

---

## 3. 路径规则（非公网入口）

管理站与平台 API 的**完整公网 URL 暂不写入**；路径约定如下，部署成功后可在管理台「查看访问链接」获取实际地址。

| 环境 | 前端路径 | 后端 API 路径 |
|------|----------|---------------|
| 测试 | `/sdpy/test/{模块名}/` | `/sdpy/test/{模块名}-api/` |
| 正式 | `/sdpy/{模块名}/` | `/sdpy/{模块名}-api/` |

模块名：小写字母开头，仅 `a-z0-9-`，全局唯一。不可用保留字：`test`、`api`、`oauth`、`login`、`projects`、`modules`、`assets` 等；不可以 `-api` 结尾。

---

## 4. 用户角色与权限

| 角色 | 范围 | 权限 |
|------|------|------|
| 平台管理员 | 全局 | 由环境变量 `PLATFORM_ADMIN_OAUTH_IDS` 引导；可识别 `isPlatformAdmin` |
| 项目 Owner | 项目 | 创建模块、邀请成员、部署 |
| Developer | 项目 | 上传包、部署、看日志 |
| Viewer | 项目 | 只读查看模块与访问链接 |

默认项目配额（创建项目时）：模块数 2 等（见实现 `DEFAULT_QUOTA`）。配额调整当前以库内 `quota_json` 运维为主，管理台提额 UI 未开放。

---

## 5. 核心使用流程

```
1. OAuth 登录管理站
2. 创建项目 → 注册模块名
3. 模块详情上传 zip（结构见《用户部署指南》）
4. 在「测试」页签点击「部署测试」（正式环境同理）
5. 「查看访问链接」获取前端 / 后端 URL（内测阶段由平台方提供入口）
6. 浏览器访问验收
```

部署日志会展示：`docker compose -p sdpy-{env}-{name} ... up -d --build --force-recreate` 的完整输出。

---

## 6. 架构概览

```
浏览器
  │
  ▼
公共 nginx（sse_market_server-nginx_proxy-1）
  ├─ /sdpy/          → 管理站静态资源（web/）
  ├─ /sdpy-api/      → 宿主机 :3002（sdpy-api）
  └─ include modules.conf
       ├─ /sdpy/test/{name}/      → host.docker.internal:{webPort}
       └─ /sdpy/test/{name}-api/  → host.docker.internal:{apiPort}
              │
              ▼
       用户模块容器（docker ps 可见）
       sdpy-test-{name}-web / -api
```

要点：

- **管理站 API**（`sdpy-api`）与**用户模块容器**分离；模块端口从 `DEPLOY_PORT_START`（默认 8100）递增分配。
- 公共 nginx 在 Docker 内，访问宿主机端口须用 `host.docker.internal`（勿在 `modules.conf` 里写 `127.0.0.1`）。
- 用户 compose **不要**把端口绑成 `127.0.0.1:端口`，否则 nginx 容器连不上会 502。

---

## 7. 端口分配逻辑

1. 环境变量 `DEPLOY_PORT_START`（默认 `8100`）为起点。
2. 每次创建部署任务时，扫描库内已占用端口，取最大值：
   - `webPort = max + 1`
   - `apiPort = max + 2`
3. 写入工作目录 `.env.sdpy`：`WEB_HOST_PORT` / `API_HOST_PORT`。
4. 用户 `compose.yml` 映射这两个端口 → 故 **`docker ps` 会显示占用**，属预期行为。
5. 公网不直接暴露 `810x`，只通过 `/sdpy/...` 路径反代。

同一模块测试 / 正式各占一对端口；重新部署会再申请新端口（当前实现为递增，不做空洞回收）。

---

## 8. 生产运维要点

### 8.1 目录与进程

| 项 | 建议 |
|----|------|
| API 目录 | 上机包 `api/`（绝对路径写入 `SDPY_HOST_DATA`） |
| 容器名 | `sdpy-api` |
| 数据 | `api/data/`（uploads、work、deploy.db、nginx/modules.conf） |
| 前端静态 | 公共 nginx 挂载 `web/` 到 `/sdpy/` |

### 8.2 关键环境变量

| 变量 | 含义 |
|------|------|
| `SDPY_HOST_DATA` | 宿主机上 api 目录**绝对路径**（compose 挂载必需） |
| `GATEWAY_UPSTREAM_HOST` | 须为 `host.docker.internal`（nginx 在容器内时） |
| `GATEWAY_RELOAD_CMD` | 例：`docker exec <公共nginx容器名> nginx -s reload` |
| `DEPLOY_PORT_START` | 端口池起点，默认 8100 |

> `docker-compose.yml` 中 `GATEWAY_UPSTREAM_HOST` 应从 `.env` 注入，**不要写死 `127.0.0.1`**。

### 8.3 常见故障

| 现象 | 原因 | 处理 |
|------|------|------|
| 部署成功但访问 502 | upstream 为 `127.0.0.1` 或端口绑回环 | 改 `GATEWAY_UPSTREAM_HOST`；compose 用 `"${WEB_HOST_PORT}:80"`；重新上传部署 |
| reload 失败 `No such container` | 容器名写错（应用镜像名） | `GATEWAY_RELOAD_CMD` 使用 `docker ps` 里真实容器名 |
| `invalid mount path: ':'` | `SDPY_HOST_DATA` 为空 | 写成绝对路径后 `docker compose up -d` |

### 8.4 自检命令

```bash
# nginx 能否解析宿主机
docker exec <nginx容器名> getent hosts host.docker.internal

# 模块端口应为 0.0.0.0，不是 127.0.0.1
docker ps --filter name=sdpy-test- --format '{{.Names}} {{.Ports}}'

# 路由内容
grep proxy_pass /path/to/api/data/nginx/modules.conf

# 从 nginx 容器探活模块（端口以实际为准）
docker exec <nginx容器名> wget -qO- http://host.docker.internal:8100/ | head
```

---

## 9. 验收要点（内测）

- [ ] 管理站可打开并 OAuth 登录  
- [ ] 创建项目 / 模块，上传示例 zip 成功  
- [ ] 「部署测试」成功，日志无 reload 失败  
- [ ] 管理台给出的前端 / 后端链接可访问（非 502）  
- [ ] `docker ps` 可见 `sdpy-test-{name}-web/api`，端口为 `0.0.0.0:81xx`  
- [ ] 「部署正式」不停止测试容器（独立 compose 项目）

示例包：仓库 `sse-deploy/deploy/examples/sample-app/`，或发布目录 `release-sdpy/sdpy-sample-app.zip`。

---

## 10. 项目文档目录

| 文档 | 说明 |
|------|------|
| [SSE Deploy 用户部署指南](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-i_4t1QsZ) | zip / compose / 使用步骤 |
| [SSE Deploy：对象存储（MinIO）用户手册](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-dF4GrtOQ) | 开通桶 / 同步历史数据 / 生命周期 |
| [SSE Deploy 架构与原理](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-2we6ohlE) | 见正文 |
| [SSE Deploy 需求与范围](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-9VDKfiX_) | 见正文 |
| [SSE Deploy 前端架构说明](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-HC011ftw) | 见正文 |
| [SSE Deploy 后端与部署流水线](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-aDk1vtt5) | 见正文 |
| [SSE Deploy 构建与运维指南](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-qVvJnoJm) | 见正文 |
| [SSE Deploy 验收清单](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-fqgFuTuR) | 见正文 |
| [SSE Deploy 灰度设计（历史）](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-qtQ63jJz) | 见正文 |
| 仓库 `https://gitee.com/xindonhub/sse-deploy` | 源码 |

仓库内 Markdown 源稿在 `sse-deploy/docs/iwiki-SSE-Deploy-*.md`。

