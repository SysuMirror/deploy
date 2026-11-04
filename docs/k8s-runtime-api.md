# SSE Deploy ↔ K8s 控制面接口文档

> **版本**：v0.1（预留设计，尚未实现）  
> **状态**：对接契约  
> **调用方**：本机 `sdpy-api`（控制面 + nginx 转发）  
> **被调用方**：另一台机器上的 K8s 控制服务  

本机不再用 `docker compose` 起用户模块；改为调用本文接口。本机 nginx 按返回的 `endpoints` / `ingress` 做反代（路径或后续子域名）。

---

## 1. 总则

### 1.1 Base URL

由环境变量配置，例如：

```text
K8S_RUNTIME_BASE_URL=https://k8s-ctrl.internal:8443
```

所有路径均相对该根，前缀 `/v1`。

### 1.2 鉴权

| Header | 必填 | 说明 |
|--------|------|------|
| `Authorization` | 是 | `Bearer <token>`，K8s 控制面签发或双方约定的静态令牌 |
| `X-Sdpy-Request-Id` | 是 | 调用方生成的 UUID，便于对日志 |
| `Content-Type` | POST/PUT | `application/json`；上传包用 `multipart/form-data` |

Token 建议独立于用户 OAuth，仅平台服务账号使用。

### 1.3 公共响应

成功：HTTP 2xx，JSON body。

失败：

```json
{
  "error": {
    "code": "INSTANCE_NOT_FOUND",
    "message": "实例不存在",
    "details": {}
  }
}
```

| HTTP | code 示例 | 含义 |
|------|-----------|------|
| 400 | `INVALID_ARGUMENT` | 参数非法 |
| 401 | `UNAUTHORIZED` | 未鉴权 |
| 403 | `FORBIDDEN` | 无权限 |
| 404 | `INSTANCE_NOT_FOUND` / `DEPLOY_NOT_FOUND` / `ARTIFACT_NOT_FOUND` / `VOLUME_NOT_FOUND` | 资源不存在 |
| 409 | `INSTANCE_EXISTS` / `DEPLOY_IN_PROGRESS` | 冲突 |
| 429 | `RATE_LIMITED` / `CAPACITY_EXCEEDED` | 限流或集群容量不足 |
| 500 | `INTERNAL` | 控制面内部错误 |
| 503 | `CLUSTER_UNAVAILABLE` | 集群不可用 |

### 1.4 实例 ID 约定

与现平台 compose 项目名对齐，全局唯一：

```text
instanceId = sdpy-{env}-{module}
```

- `env`：`test` \| `prod`
- `module`：模块名，`^[a-z][a-z0-9-]{1,31}$`

### 1.5 用户包约定（与现网一致）

zip / 制品根目录必须含：

```text
frontend/
backend/
compose.yml    # 或 docker-compose.yml / .yaml
```

服务名必须为 `web`、`api`。持久化目录在容器内为 **`/data`**。

注入环境变量（部署时传入 `env` 字段）：

| 变量 | 含义 |
|------|------|
| `SDPY_ENV` | `test` / `prod` |
| `SDPY_MODULE` | 模块名 |
| `SDPY_PUBLIC_BASE` | 前端路径前缀或后续子域名路径 |
| `SDPY_API_PUBLIC_BASE` | 后端路径前缀 |
| `SDPY_PUBLIC_URL` | 前端公网 URL |
| `SDPY_API_PUBLIC_URL` | 后端公网 URL |
| `SDPY_DATA_DIR` | 宿主机/PVC 对应逻辑路径提示 |

---

## 2. 数据模型

### 2.1 InstanceStatus

`pending` | `creating` | `running` | `degraded` | `stopped` | `failed` | `deleting` | `deleted`

### 2.2 DeployStatus

`pending` | `uploading` | `building` | `deploying` | `success` | `failed` | `cancelled`

### 2.3 Endpoint

```json
{
  "host": "10.20.0.15",
  "port": 31080,
  "protocol": "http",
  "clusterDns": "web.sdpy-prod-novelwrite.svc.cluster.local"
}
```

本机 nginx **优先使用 `host` + `port`**（须从本机路由可达，一般为 K8s 节点内网 IP + NodePort，或 LB IP）。

### 2.4 Instance

```json
{
  "instanceId": "sdpy-prod-novelwrite",
  "module": "novelwrite",
  "env": "prod",
  "status": "running",
  "owner": "user-oauth-xxx",
  "createdAt": "2026-08-19T02:00:00.000Z",
  "updatedAt": "2026-08-19T02:10:00.000Z",
  "endpoints": {
    "web": { "host": "10.20.0.15", "port": 31080, "protocol": "http" },
    "api": { "host": "10.20.0.15", "port": 31002, "protocol": "http" }
  },
  "ingress": {
    "mode": "nodePort",
    "nodeIp": "10.20.0.15",
    "hosts": ["novelwrite.ssemarket.cn"],
    "pathWeb": "/",
    "pathApi": "/api/"
  },
  "volumeId": "pvc-sdpy-prod-novelwrite",
  "resources": { "cpu": "500m", "memory": "512Mi" }
}
```

### 2.5 Artifact

```json
{
  "artifactId": "art-abc123",
  "instanceId": "sdpy-prod-novelwrite",
  "fileName": "app.zip",
  "sizeBytes": 1234567,
  "sha256": "…",
  "createdAt": "2026-08-19T02:01:00.000Z"
}
```

### 2.6 Deployment

```json
{
  "deployId": "kd-xyz",
  "instanceId": "sdpy-prod-novelwrite",
  "artifactId": "art-abc123",
  "action": "deploy",
  "status": "building",
  "noCache": false,
  "createdAt": "2026-08-19T02:02:00.000Z",
  "finishedAt": null
}
```

`action`：`deploy` | `promote` | `rollback`

### 2.7 Volume

```json
{
  "volumeId": "pvc-sdpy-prod-novelwrite",
  "instanceId": "sdpy-prod-novelwrite",
  "module": "novelwrite",
  "env": "prod",
  "mountPath": "/data",
  "logicalPath": "/root/SSE_Market/sse-sdpy/data/novelwrite/prod",
  "status": "bound",
  "storage": "10Gi"
}
```

### 2.8 Pod

```json
{
  "name": "api-7f8c9d",
  "service": "api",
  "phase": "Running",
  "ready": true,
  "restarts": 0,
  "createdAt": "2026-08-19T02:05:00.000Z",
  "startedAt": "2026-08-19T02:05:12.000Z",
  "nodeName": "k8s-node-1"
}
```

---

## 3. 健康与容量

### 3.1 `GET /v1/health`

控制面探活。

**响应 200**

```json
{
  "ok": true,
  "cluster": "sse-k8s-1",
  "version": "0.1.0"
}
```

---

### 3.2 `GET /v1/capacity`

集群剩余资源，平台申请前可预检。

**响应 200**

```json
{
  "instances": { "used": 12, "limit": 80 },
  "cpu": { "used": "8", "allocatable": "32" },
  "memory": { "used": "24Gi", "allocatable": "64Gi" },
  "storage": { "used": "120Gi", "allocatable": "500Gi" }
}
```

---

## 4. 实例（申请 / 删除机器）

### 4.1 `POST /v1/instances`

申请一台（一组）运行位：创建 Namespace/工作负载骨架 + PVC（可选），**此时可以还没有用户代码**。

**请求**

```json
{
  "instanceId": "sdpy-prod-novelwrite",
  "module": "novelwrite",
  "env": "prod",
  "owner": "user-oauth-xxx",
  "resources": {
    "cpu": "500m",
    "memory": "512Mi"
  },
  "needPvc": true,
  "volume": {
    "logicalPath": "/root/SSE_Market/sse-sdpy/data/novelwrite/prod",
    "mountPath": "/data",
    "storage": "10Gi"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `instanceId` | 是 | 见 §1.4；已存在则 409 |
| `module` | 是 | 模块名 |
| `env` | 是 | `test` / `prod`，数据卷按环境隔离 |
| `owner` | 否 | 平台用户 ID，便于审计 |
| `resources` | 否 | 默认由控制面配额决定 |
| `needPvc` | 否 | 默认 `true` |
| `volume` | 否 | PVC 规格；`logicalPath` 仅作标签，实际挂载 `mountPath=/data` |

**响应 201** — `Instance`（`status` 可为 `creating`，需再 GET 直到 `running` 或允许在 `creating` 时就 deploy）

**错误**

- `409 INSTANCE_EXISTS`
- `429 CAPACITY_EXCEEDED`

---

### 4.2 `GET /v1/instances`

列表，对应管理台「容器列表」。

**Query**

| 参数 | 说明 |
|------|------|
| `module` | 过滤模块名 |
| `env` | `test` / `prod` |
| `status` | 状态过滤 |
| `owner` | 所有者 |

**响应 200**

```json
{
  "instances": [ { "...": "Instance" } ]
}
```

---

### 4.3 `GET /v1/instances/:instanceId`

查单实例，含最新 `endpoints`（**本机写 nginx 依赖此字段**）。

**响应 200** — `Instance`  
**404** `INSTANCE_NOT_FOUND`

---

### 4.4 `DELETE /v1/instances/:instanceId`

删除机器：停 Pod、删 Service/Ingress。

**Query / Body（可选）**

```json
{
  "purgeVolume": false
}
```

- `purgeVolume=false`（默认）：PVC 保留，下次同 `instanceId` 可再挂同一数据  
- `true`：删除 PVC（对应平台「删除模块且清数据」）

**响应 200**

```json
{ "ok": true, "instanceId": "sdpy-prod-novelwrite" }
```

异步删除时 `status` 先变 `deleting`，再次 GET 直到 404。

---

### 4.5 `POST /v1/instances/:instanceId/stop`

停止工作负载，保留 PVC 与 instance 记录。`status` → `stopped`。

**响应 200** — `Instance`

---

### 4.6 `POST /v1/instances/:instanceId/start`

从 `stopped` 拉起（使用上次制品，不重新构建）。若无成功制品则 409。

**响应 200** — `Instance`

---

### 4.7 `POST /v1/instances/:instanceId/restart`

滚动重启当前 Pod。

**响应 200**

```json
{ "ok": true }
```

---

## 5. 制品（把代码放到机器上）

### 5.1 `POST /v1/instances/:instanceId/artifacts`

上传 zip。`multipart/form-data`：

| 字段 | 必填 | 说明 |
|------|------|------|
| `package` | 是 | `.zip` 文件 |
| `fileName` | 否 | 原始文件名 |
| `label` | 否 | 版本标签 |

校验失败（缺 `frontend/` / `backend/` / compose）返回 **400** `INVALID_PACKAGE`。

**响应 201** — `Artifact`

---

### 5.2 `POST /v1/instances/:instanceId/artifacts/from-url`

大包可不经平台内存中转。

**请求**

```json
{
  "url": "https://sdpy-api/internal/packages/...",
  "fileName": "app.zip",
  "sha256": "可选校验"
}
```

URL 须控制面可拉取（内网或带短时签名）。

**响应 201** — `Artifact`

---

### 5.3 `GET /v1/instances/:instanceId/artifacts`

该实例历史上传列表（可选实现；平台也可只存自己的 packages 表）。

**响应 200**

```json
{ "artifacts": [ { "...": "Artifact" } ] }
```

---

### 5.4 `DELETE /v1/instances/:instanceId/artifacts/:artifactId`

删除未在用制品。正在部署中的返回 409。

---

## 6. 部署（构建并发布）

### 6.1 `POST /v1/instances/:instanceId/deploy`

用指定制品构建 `web`/`api` 并滚动发布。对应现网 `docker compose up -d --build`。

**请求**

```json
{
  "artifactId": "art-abc123",
  "action": "deploy",
  "noCache": false,
  "env": {
    "SDPY_ENV": "prod",
    "SDPY_MODULE": "novelwrite",
    "SDPY_PUBLIC_BASE": "/novelwrite",
    "SDPY_API_PUBLIC_BASE": "/novelwrite-api",
    "SDPY_PUBLIC_URL": "https://ssemarket.cn/novelwrite",
    "SDPY_API_PUBLIC_URL": "https://ssemarket.cn/novelwrite-api"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `artifactId` | 是 | 已上传制品 |
| `action` | 否 | 默认 `deploy`；`promote`/`rollback` 仅作标记，行为仍是用该制品发布到本 instance |
| `noCache` | 否 | 等价 `--no-cache` |
| `env` | 是 | 写入构建参数与运行环境 |

同一 instance **同时只允许一个** 进行中的 deploy，否则 409 `DEPLOY_IN_PROGRESS`。

**响应 201**

```json
{
  "deployment": { "...": "Deployment" }
}
```

`status` 初始为 `pending` / `building`。

---

### 6.2 `GET /v1/instances/:instanceId/deployments/:deployId`

轮询状态。`success` 后 `GET /instances/:id` 的 `endpoints` 必须已可用。

**响应 200** — `{ "deployment": Deployment }`

---

### 6.3 `GET /v1/instances/:instanceId/deployments/:deployId/logs`

构建/发布日志，对应平台「编译日志」页。

**Query**

| 参数 | 说明 |
|------|------|
| `cursor` | 上次返回的偏移（字节或行号），增量拉取 |
| `follow` | `1` 时可用 SSE（可选） |

**响应 200（JSON 轮询，最低要求）**

```json
{
  "status": "building",
  "eof": false,
  "cursor": "4096",
  "text": "...追加的日志..."
}
```

**响应 200（可选 SSE）**

```
Content-Type: text/event-stream

data: {"line":"Step 3/9 : RUN npm ci"}

data: {"status":"success","eof":true}
```

---

### 6.4 `POST /v1/instances/:instanceId/deployments/:deployId/cancel`

取消排队或构建中的任务。已 `success`/`failed` 则 409。

**响应 200**

```json
{ "ok": true, "status": "cancelled" }
```

---

### 6.5 `GET /v1/instances/:instanceId/deployments`

历史部署列表。

**Query：** `limit` 默认 30。

**响应 200**

```json
{ "deployments": [ { "...": "Deployment" } ] }
```

---

## 7. 运行时排障

### 7.1 `GET /v1/instances/:instanceId/pods`

**响应 200**

```json
{ "pods": [ { "...": "Pod" } ] }
```

---

### 7.2 `GET /v1/instances/:instanceId/logs`

运行日志（非构建日志）。

**Query**

| 参数 | 说明 |
|------|------|
| `service` | `web` / `api`，默认 `api` |
| `tail` | 行数，默认 200 |
| `since` | RFC3339 |

**响应 200**

```json
{ "service": "api", "text": "..." }
```

---

### 7.3 `GET /v1/instances/:instanceId/health`

**响应 200**

```json
{
  "web": { "ok": true, "status": 200, "latencyMs": 12 },
  "api": { "ok": true, "status": 200, "latencyMs": 8 }
}
```

控制面应对 cluster 内 `web`/`api` 的健康检查路径探活（如 `/`、`/health`）。探不到时 `ok: false`，HTTP 仍 200。

---

### 7.4 `GET /v1/instances/:instanceId/events`

调度/镜像/OOM 等事件。

**响应 200**

```json
{
  "events": [
    {
      "type": "Warning",
      "reason": "FailedScheduling",
      "message": "0/2 nodes available: insufficient memory",
      "at": "2026-08-19T02:03:00.000Z"
    }
  ]
}
```

---

### 7.5 `GET /v1/instances/:instanceId/ingress`

明确告诉本机 nginx 怎么配。可与 Instance.endpoints 重复，但此接口应作为 **转发权威**。

**响应 200**

```json
{
  "mode": "nodePort",
  "web": { "host": "10.20.0.15", "port": 31080, "protocol": "http" },
  "api": { "host": "10.20.0.15", "port": 31002, "protocol": "http" },
  "suggestedHost": "novelwrite.ssemarket.cn",
  "stripPath": false
}
```

| mode | 本机做法 |
|------|----------|
| `nodePort` | `proxy_pass http://{host}:{port}/` |
| `loadBalancer` | 同上，host 为 LB |
| `ingress` | `proxy_pass` 到统一入口，并设 `Host: suggestedHost` |

---

## 8. 存储卷

测试 / 正式必须拆开：逻辑上 `{MODULE_DATA_ROOT}/{module}/{env}`，容器内一律 `/data`。

### 8.1 `POST /v1/volumes`

幂等：已存在则返回现有卷。

**请求**

```json
{
  "instanceId": "sdpy-prod-novelwrite",
  "module": "novelwrite",
  "env": "prod",
  "logicalPath": "/root/SSE_Market/sse-sdpy/data/novelwrite/prod",
  "mountPath": "/data",
  "storage": "10Gi"
}
```

**响应 200/201** — `Volume`

---

### 8.2 `GET /v1/volumes/:volumeId`

**响应 200** — `Volume`

---

### 8.3 `DELETE /v1/volumes/:volumeId`

仅在实例已删除或 `purgeVolume` 流程中调用。卷仍被绑定则 409 `VOLUME_IN_USE`。

---

## 9. Webhook（可选，减少轮询）

控制面在状态变化时 POST 到平台配置的回调 URL。

```text
K8S_RUNTIME_WEBHOOK_URL=https://ssemarket.cn/sdpy-api/internal/k8s/webhook
```

**请求 Header：** `X-K8s-Signature: sha256=HMAC(...)`（双方共享密钥）

**Body**

```json
{
  "type": "instance.status | deploy.status | deploy.log",
  "instanceId": "sdpy-prod-novelwrite",
  "deployId": "kd-xyz",
  "status": "success",
  "at": "2026-08-19T02:10:00.000Z",
  "endpoints": {
    "web": { "host": "10.20.0.15", "port": 31080 },
    "api": { "host": "10.20.0.15", "port": 31002 }
  }
}
```

无 webhook 时，平台对进行中的 deploy 每 1.5～2s 调 `GET .../logs` 与 `GET .../deployments/:id`。

---

## 10. 平台调用时序

### 10.1 首次部署测试

```
POST /instances                         # 申请机器
POST /instances/:id/artifacts           # 上传 zip
POST /instances/:id/deploy              # 构建发布
loop GET .../deployments/:id + /logs    # 直到 success/failed
GET  /instances/:id/ingress             # 写本机 nginx
```

### 10.2 晋升正式

```
POST /instances   (env=prod，若尚无)
POST /artifacts   （或复用已同步的 artifactId）
POST /deploy      action=promote
GET  /ingress     写正式路径或子域名
```

正式与测试 **不同 instanceId**，**不同 PVC**。

### 10.3 删除模块

```
DELETE /instances/sdpy-test-{m}?purgeVolume=false
DELETE /instances/sdpy-prod-{m}?purgeVolume=false
本机：去掉 nginx location / DNS 记录
```

用户明确要求清数据时再 `purgeVolume=true`。

---

## 11. 本机 nginx 对接规则

拿到 ingress 后：

**路径模式（现网）**

```nginx
location /sdpy/test/{module}/ {
  proxy_pass http://{web.host}:{web.port}/;
}
location /sdpy/test/{module}-api/ {
  proxy_pass http://{api.host}:{api.port}/;
}
```

**子域名模式（后续）**

- DNS：`{module}.ssemarket.cn`、`test-{module}.ssemarket.cn` → 本机  
- nginx：按 `Host` 反代到对应 `web`/`api` endpoints  
- 或 `Host` 转到 K8s Ingress（`mode=ingress`）

控制面 **不必** 自己配公网证书；证书仍在本机或统一 LB。K8s 只保证内网/NodePort 可达。

---

## 12. 接口总表

| 方法 | 路径 | 必做 | 说明 |
|------|------|------|------|
| GET | `/v1/health` | 是 | 探活 |
| GET | `/v1/capacity` | 建议 | 配额 |
| POST | `/v1/instances` | **是** | 申请机器 |
| GET | `/v1/instances` | 建议 | 列表 |
| GET | `/v1/instances/:id` | **是** | 详情 + endpoints |
| DELETE | `/v1/instances/:id` | **是** | 删除机器 |
| POST | `/v1/instances/:id/stop` | 否 | 停止 |
| POST | `/v1/instances/:id/start` | 否 | 启动 |
| POST | `/v1/instances/:id/restart` | 建议 | 重启 |
| POST | `/v1/instances/:id/artifacts` | **是** | 上传代码包 |
| POST | `/v1/instances/:id/artifacts/from-url` | 建议 | URL 拉取包 |
| GET | `/v1/instances/:id/artifacts` | 否 | 制品列表 |
| DELETE | `/v1/instances/:id/artifacts/:aid` | 否 | 删制品 |
| POST | `/v1/instances/:id/deploy` | **是** | 构建发布 |
| GET | `/v1/instances/:id/deployments/:did` | **是** | 部署状态 |
| GET | `/v1/instances/:id/deployments/:did/logs` | **是** | 构建日志 |
| POST | `/v1/instances/:id/deployments/:did/cancel` | 建议 | 取消 |
| GET | `/v1/instances/:id/deployments` | 否 | 部署历史 |
| GET | `/v1/instances/:id/pods` | 建议 | Pod 列表 |
| GET | `/v1/instances/:id/logs` | 建议 | 运行日志 |
| GET | `/v1/instances/:id/health` | **是** | 探活 web/api |
| GET | `/v1/instances/:id/events` | 建议 | 事件 |
| GET | `/v1/instances/:id/ingress` | **是** | 转发地址权威来源 |
| POST | `/v1/volumes` | 建议 | 确保 PVC |
| GET | `/v1/volumes/:vid` | 否 | 卷详情 |
| DELETE | `/v1/volumes/:vid` | 建议 | 删卷 |
| POST | （平台 webhook） | 否 | 状态推送 |

**最低可跑通（8 个）：**  
`POST /instances` · `DELETE /instances/:id` · `POST .../artifacts` · `POST .../deploy` · `GET .../deployments/:did` · `GET .../deployments/:did/logs` · `GET /instances/:id` · `GET .../ingress`

---

## 13. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1 | 2026-08-19 | 初稿，供 K8s 控制面按此实现 |
