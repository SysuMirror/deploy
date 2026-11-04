# SSE Deploy：部署与数据存储指南

> **读者**：模块开发者、项目 Owner、平台管理员  
> **入口**：https://ssemarket.cn/sdpy/  
> **更新**：2026-08-22  
> **仓库正文**：`sse-deploy/docs/用户部署约定.md`（契约细节）、本文（数据与对象存储总览）

---

## 1. 先建立一张「数据放哪儿」的地图

同一模块在 **测试 / 正式** 各有一套隔离资源。不要把「组盘」「宿主机目录」「MinIO 桶」混成一回事。

| 层级 | 测试环境 | 正式环境 | 存什么 | 删组会不会丢 |
|------|----------|----------|--------|----------------|
| **宿主机 MODULE_DATA** | `{MODULE_DATA_ROOT}/{模块名}/test/` | `…/prod/` | 平台侧备份/迁移用的业务目录；同步 MinIO 时从这里读 | 默认**不删**（作备份） |
| **K8s 组 PVC（Pod 内）** | 组 `…-{模块}-t` | 组 `…-{模块}-p` | `/home/cloud/data`（兼容 `/data`）：SQLite、JWT、未迁走的本地文件 | **删组会丢** |
| **MinIO 对象桶** | 桶名 = 组名（如 `sdpy-image-t`） | 桶名 = 组名（如 `sdpy-image-p`） | 图床原图/缩略图等大文件（S3 key，如 `images/2026/…`） | **默认不删**（随模块保留） |

**默认宿主机根目录**（生产机）：

```text
MODULE_DATA_ROOT=/root/SSE_Market/sse-sdpy/data
例：图床模块 image 正式环境 → /root/SSE_Market/sse-sdpy/data/image/prod/
```

**组内路径**（迁移 / 部署后应用应优先读）：

```text
/home/cloud/data     # 平台注入 SDPY_DATA_DIR / DATA_DIR
/data                # 尽量兼容的旧路径（迁移脚本会 ln）
```

**MinIO 集群内端点**（仅 Pod / 集群内可访问，**不能**从 ssemarket.cn 公网直连）：

```text
http://minio.platform-infra.svc.cluster.local:9000
```

教师手工管理桶/密钥：[sseinfra 存储面板](http://ssemarket.cn:24000/storage)

---

## 2. 用户访问地址（业务 URL）

默认运行时 `DEPLOY_RUNTIME=sseinfra`。对外只发 **路径 URL**，不要把 `:23xxx` 当正式入口。

| 环境 | 前端（示例：模块 `image`） | API（若有独立后端） |
|------|---------------------------|---------------------|
| 测试 | `https://ssemarket.cn/sdpy/test/image/` | `https://ssemarket.cn/sdpy/test/image-api/` |
| 正式 | `https://ssemarket.cn/sdpy/image/` | `https://ssemarket.cn/sdpy/image-api/` |

部署成功后，在模块详情页 **「查看访问链接」** 核对。平台网关把 `/sdpy/…` 反代到组容器 `0.0.0.0:8080`（经 frp `23xxx` 上游）。

应用必须监听 **`0.0.0.0:$PORT`**（通常 `PORT=8080`），不能只绑 `127.0.0.1`。

---

## 3. 标准部署流程（K8s / sseinfra）

### 3.1 压缩包或 Git

1. 登录 https://ssemarket.cn/sdpy/ → 项目 → 模块  
2. 仓根或 zip 根须有可执行 **`deploy.sh`**（前台常驻、`0.0.0.0:$PORT`）  
3. 选 **测试** 或 **正式** Tab → **部署**  
4. 在部署日志页看：建组 → Pod Running → 传包 → supervisord 执行 `deploy.sh`  
5. 成功后用访问链接验收  

组名规则（自动）：`{组前缀}-{模块名}-{t|p}`，默认前缀 `sdpy`，例：`sdpy-image-p`。

### 3.2 从本机 compose 迁到 K8s

模块页 **「迁移到 K8s」**：

1. 把宿主机 `MODULE_DATA/{模块}/{env}` 打进组 Pod `/home/cloud/data`  
2. 再用 Git 或 zip 重新部署  
3. 停旧 compose；**宿主机 MODULE_DATA 不删**  

### 3.3 平台管理员前置（否则无法自动建桶 / 传包）

管理台 → **管理员** → **sseinfra 面板登录**：

| 配置项 | 说明 |
|--------|------|
| 面板地址 | 默认 `http://ssemarket.cn:24000` |
| **面板账号** | 例：`admin`（`:24000/login` 用户名） |
| **面板密码** | 与 SSH 跳板密码相同（见下） |
| SSH 跳板用户/主机 | 默认 `root` + `ssemarket.cn`（压缩包 `kubectl cp` 用） |

也可用环境变量（优先于管理台数据库）：

```bash
SSEINFRA_USERNAME=admin
SSEINFRA_PASSWORD=***
SSEINFRA_BASE_URL=http://ssemarket.cn:24000
SSEINFRA_SSH_HOST=ssemarket.cn
SSEINFRA_SSH_USER=root
# 兼容旧键名：k8s_username / k8s_password
```

填好后点 **「测试登录」** 必须成功，否则审批建桶、部署传包都会失败。

---

## 4. 对象存储（MinIO）：桶怎么申请、怎么用

### 4.1 这是什么

- **不是** Linux 挂载目录；用 **S3 兼容 API** 读写对象。  
- 对象 **key** 可用斜杠，看起来像文件夹：`images/2026/08/21/uuid.png`。  
- **一个模块 + 一个环境 = 一个桶**；桶名与 **K8s 组名相同**（如正式 `sdpy-image-p`）。  
- **访问密钥标签（label）必须等于组名**，平台才能把 `MINIO_*` 注入组环境。

### 4.2 入口

1. https://ssemarket.cn/sdpy/ → 模块详情  
2. **对象存储 → 进入管理**（或环境操作栏「对象存储」）  
3. URL：`/sdpy/modules/{模块ID}/object-storage?env=prod|test`  
4. 顶部切换 **测试 / 正式**

### 4.3 申请桶（两种方式）

| 方式 | 谁操作 | 结果 |
|------|--------|------|
| **申请对象存储** | 模块成员提交 → **平台管理员审批** | 自动建桶 + 发读写密钥（label=组名） |
| **确保桶存在** | 有权限用户（含管理员）直接点 | 幂等建桶+发密钥，**不删已有桶** |

审批 / 确保成功后，绑定状态为 **「已建桶」**。此时桶已在 MinIO 里，但应用进程可能还没拿到环境变量。

### 4.4 推荐完整流程（含历史数据）

```text
① 申请或确保桶
② 部署该环境 → 组 Running
③ 对象存储页 →「同步历史数据到桶」（异步，可离开页面稍后回来看进度）
④ 同步成功后平台写入组环境 MINIO_*（可能触发 Pod 重建）
⑤ 若应用仍读本地：再点一次「部署」或确认组 env 已有 MINIO_*
⑥ 验收：新上传进桶；图床日志 backend 为 minio:桶名
```

**同步做什么**：把宿主机 `MODULE_DATA/{模块}/{env}`（并推入 Pod `/home/cloud/data`）里的文件，经 Pod 上传到 MinIO 桶。跳过 `.db`、JWT 等元数据，主要迁图片等业务二进制。

**组须 Running** 才能同步；数据量大可能数十分钟，进度条会显示阶段（推数据 → 上传桶）。

### 4.5 桶与密钥的生命周期

| 操作 | 桶 | 组 PVC | 宿主机 MODULE_DATA |
|------|-----|--------|-------------------|
| 重新部署 / 复用组 | 保留 | 保留（复用组时） | 保留 |
| 释放 K8s 组 | **保留** | 随组删除 | 保留 |
| 删除模块 | **保留**（绑定记 orphaned） | 随删组 | 保留 |
| 平台删桶按钮 | **无** | — | — |

确需删桶：教师在 [存储面板](http://ssemarket.cn:24000/storage) 手工处理。

**注意**：同一标签下不要堆多把密钥（如多个 `sdpy-image-p`），平台按标签匹配时可能取到不确定的一把。建议每个环境 **只保留 1 把** 读写密钥。

---

## 5. 凭据与环境变量（开发者必读）

### 5.1 平台部署时注入（sseinfra 组环境 → 进程）

密钥 **label = 组名** 时，部署 / 同步后组环境会出现（同步成功后会 `setEnvMany` 写入）：

| 变量 | 典型值 | 说明 |
|------|--------|------|
| `MINIO_ENDPOINT` | `http://minio.platform-infra.svc.cluster.local:9000` | 仅集群内可达 |
| `MINIO_ACCESS_KEY` | 面板发的 key（如 `key-…`） | 勿提交到 Git |
| `MINIO_SECRET` | 面板发的 Secret | 勿提交到 Git |
| `MINIO_BUCKET` | 与组名相同，如 `sdpy-image-p` | 当前环境专属桶 |
| `PORT` | `8080` | 应用监听端口 |
| `SDPY_DATA_DIR` | `/home/cloud/data` | 组内持久化数据根 |
| `DATA_DIR` | `/home/cloud/data` | 同上，兼容旧应用 |
| `SDPY_ENV` | `test` / `prod` | 环境标识 |
| `SDPY_MODULE` | 模块名 | 如 `image` |
| `SDPY_PUBLIC_BASE` 等 | 由平台拼 | 前端静态资源公网前缀 |

应用在 `deploy.sh` 里应 **`export`** 上述变量（模板见 `deploy/examples/templates/sseinfra-module/deploy.sh`）。

### 5.2 应用如何选择「读桶还是读本地盘」

以图床（imagebed）为例：

```go
// 四个 MINIO_* 全部非空 → 走 MinIO；否则 → 本地 DATA_DIR
MINIO_ENDPOINT + MINIO_ACCESS_KEY + MINIO_SECRET + MINIO_BUCKET
```

| 场景 | 读哪里 | 如何确认 |
|------|--------|----------|
| 未配 `MINIO_*` | Pod 本地 `/home/cloud/data` | 日志 `backend: local` |
| 已配且进程启动时带齐四元组 | MinIO 桶 | 日志 `backend: minio:sdpy-image-p` |
| 只同步了桶、未注入 env / 未重启 | 仍可能读本地空目录 | 页面「共 0 张」或旧图 404 |

**SQLite / JWT** 等元数据仍建议放 `DATA_DIR`（PVC），不要塞进 MinIO 桶（同步脚本也会跳过 `.db`）。

### 5.3 模块页「环境变量」与 MinIO 的关系

模块详情 → **环境变量**（按 test/prod **分槽**）：

- 保存后，**下次部署该环境**时写入应用根目录 `.env` 并注入组环境。  
- **不会**自动把 MinIO 密钥写进用户自定义 env 文件（由平台按 label 注入）。  
- 用户自定义变量与 `MINIO_*` 并存；勿在模块 env 里手写密钥，除非你知道在覆盖平台注入。

### 5.4 名称对照表（例：模块 `image`）

| 概念 | 测试 | 正式 |
|------|------|------|
| K8s 组名 | `sdpy-image-t` | `sdpy-image-p` |
| MinIO 桶名 | `sdpy-image-t` | `sdpy-image-p` |
| 密钥 label | `sdpy-image-t` | `sdpy-image-p` |
| 宿主机数据 | `…/data/image/test/` | `…/data/image/prod/` |
| 公网访问 | `/sdpy/test/image/` | `/sdpy/image/` |

---

## 6. 平台运维：部署 sdpy 本身

```bash
cd /path/to/sse-deploy
npm run build

# 覆盖现网（路径以机器为准）
cp -a apps/deploy-api/dist /root/SSE_Market/sse-sdpy/api/dist
cp -a apps/deploy-web/dist/* /root/SSE_Market/sse-sdpy/web/
cd /root/SSE_Market/sse-sdpy/api && docker compose up -d --build
```

**sdpy-api 容器关键环境**（`docker-compose` / `.env`，勿提交密钥）：

| 变量 | 作用 |
|------|------|
| `DEPLOY_RUNTIME` | `sseinfra`（默认） |
| `MODULE_DATA_ROOT` | 宿主机模块数据根，默认 `/root/SSE_Market/sse-sdpy/data` |
| `SSEINFRA_USERNAME` / `SSEINFRA_PASSWORD` | 控制面板登录（建组、建桶、同步） |
| `SSEINFRA_SSH_HOST` / `SSEINFRA_SSH_USER` | 跳板 SSH（传包、kubectl） |

业务库、上传队列等 sdpy 自身数据在 `DEPLOY_DATA_DIR`（须在 compose 里指到宿主机绝对路径，见 `apps/deploy-api/DATA.md`）。

---

## 7. 常见问题

**Q：同步成功，图床仍读本地？**  
在 Pod 内 `env | grep MINIO` 应有四行；没有则管理台补配或再部署。有则看启动日志 `backend` 是否为 `minio:…`。

**Q：MODULE_DATA 和桶里哪个是「正式数据」？**  
上线后 **新上传** 应在 MinIO（配齐 `MINIO_*` 后）。`MODULE_DATA` 是宿主机副本 + 同步源；组 PVC 是运行中容器本地盘。

**Q：旧路径 `data/imagebed/` 没数据？**  
平台只认 `data/{模块名}/{test|prod}/`。需先 `rsync` 对齐再迁移或同步（见 notes：`image数据目录与迁移`）。

**Q：对象存储页进度丢了？**  
同步是后台任务；刷新对象存储页会恢复轮询。勿在同步中途 **重建 sdpy-api**（会丢内存任务状态）。

**Q：教师面板很多把同标签密钥？**  
删到每环境 1 把，避免平台匹配到错误 AK/SK。

---

## 8. 相关文档

| 文档 | 内容 |
|------|------|
| [用户部署约定](./用户部署约定.md) | zip / compose / Agent 边界 |
| [对象存储用户手册](./iwiki-SSE-Deploy-对象存储用户手册.md) | 对象存储页 UI 说明（iWiki 同步版） |
| [用户部署指南](./iwiki-SSE-Deploy-用户部署指南.md) | 部署入口精简版 |
| [K8s 迁移与 Agent](./iwiki-SSE-Deploy-K8s迁移与Agent.md) | 迁移与 Agent 细节 |
| [构建与运维](./iwiki-SSE-Deploy-构建与运维.md) | 网关、nginx、镜像 |
