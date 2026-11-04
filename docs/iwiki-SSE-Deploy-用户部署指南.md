# SSE Deploy 用户部署指南

> **版本**：v2.1  
> **更新日期**：2026-08-22  
> **状态**：内测  
> **入口**：https://ssemarket.cn/sdpy/  
> **配套**：父文档 [SSE Deploy 云部署平台](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-6AJU0Fyf)  
> **数据与对象存储总览**（仓库）：`sse-deploy/docs/SSE-Deploy-部署与数据存储指南.md`

---

## 1. 读者与前置

| 项 | 内容 |
|----|------|
| 读者 | 项目 Owner / Developer |
| 前置 | SSE Market 账号登录 Deploy |
| 默认运行时 | `DEPLOY_RUNTIME=sseinfra`（组容器 / K8s，**无 Docker**） |

---

## 2. 访问地址

### 2.1 K8s / sseinfra（默认）

- 测试 / 正式各对应一个**独立组容器**
- **对外入口**为路径 URL（经网关反代），例：正式 `https://ssemarket.cn/sdpy/image/`、测试 `https://ssemarket.cn/sdpy/test/image/`
- 应用须监听 `0.0.0.0:$PORT`（通常 `8080`）；`:23xxx` 仅为网关上游，**不要**发给用户
- 部署成功后可在模块页「查看访问链接」核对

### 2.2 本机 compose（可选）

仅当 API 设为 `DEPLOY_RUNTIME=compose` 时：

| 环境 | 前端 | 后端 API |
|------|------|----------|
| 测试 | `/sdpy/test/{模块名}/` | `/sdpy/test/{模块名}-api/` |
| 正式 | `/sdpy/{模块名}/` | `/sdpy/{模块名}-api/` |

模块名：小写字母开头，仅 `a-z0-9-`，全局唯一。

---

## 3. 如何部署（推荐）

### 3.1 压缩包（K8s）

根目录须有可执行 **`deploy.sh`**：

```text
deploy.sh                 # 必须；前台常驻；监听 0.0.0.0:$PORT
# 其余业务代码按脚本约定
```

流程：建组 → Pod Running → 传包 → supervisord 跑 `deploy.sh`。

组内**没有 Docker**，不能 `docker compose up`。

- 模板：模块页「下载 Git 模板」
- 缺脚本：见下文「部署 Agent」

### 3.2 Git 分支

模块配置 Gitee/GitHub HTTPS 仓库，仓根同样须有 `deploy.sh`。选分支部署即可。

### 3.3 缺 deploy.sh 时（须用户确认）

1. 点部署 / 迁移时，若压缩包无 `deploy.sh`，会弹出确认框  
2. **确认**后才由部署 Agent 生成脚本并继续；**取消**则中止  
3. 生成与部署过程中，可在**部署日志页随时取消**  
4. 须管理员已配置 AI/vLLM，且模型支持 function calling  

Agent **可写**：`deploy.sh`、compose、Dockerfile、nginx 等配置与部署脚本。  
Agent **不可写**：业务源码（`.ts` / `.js` / `.vue` / `.py` 等）、真实 `.env`。

部署中 compose 构建失败的「Agent 自愈」仍靠部署弹窗勾选，不再额外弹窗。

---

## 4. 测试 / 正式隔离（平台基础）

| 维度 | 测试 | 正式 |
|------|------|------|
| 业务数据 | `{MODULE_DATA_ROOT}/{模块}/test/` | `.../prod/` |
| 环境变量 | 模块页独立配置 | 独立（**晋升不复制**） |
| K8s 组 | 独立组（后缀 `-t`） | 独立组（`-p`） |

默认数据根：`/root/SSE_Market/sse-sdpy/data`。

### 4.1 环境变量

模块页当前环境 Tab → **环境变量**：JSON 或 `.env` 文本。  
部署该环境时写入应用根目录 `.env`，并注入进程/组环境。  
平台键（`PORT`、`SDPY_*`、`DATA_DIR` 等）覆盖用户同名项。

### 4.2 下载数据

当前环境 → **下载数据**：打包宿主机 `MODULE_DATA` 为 zip。  
默认粗估上限约 512MB（`MODULE_DATA_EXPORT_MAX_MB`）。  
若数据只在 K8s Pod 且宿主机已空，此处可能下不到。

---

## 5. 迁移旧本机 compose → K8s

模块页识别到本机端口遗留时，可 **迁移到 K8s**：

1. 同步 `{MODULE_DATA_ROOT}/{模块}/{env}` → 组内 `/home/cloud/data`（尽量兼容 `/data`）  
2. Git 或压缩包重新部署  
3. 成功后停本机 compose、刷新 nginx  
4. 宿主机数据目录**保留作备份**  

缺 `deploy.sh` 同样走「确认后 Agent 生成」。

---

## 6. 组资源默认规格

每个模块的测试 / 正式各建一组，**新建组**默认：

| 资源 | 默认 |
|------|------|
| CPU | 2 |
| 内存 | 4Gi |
| 存储 | 10 Gi |

管理员：管理台 → sseinfra →「新建组默认规格」，或环境变量 `SSEINFRA_DEFAULT_CPU` / `MEM` / `STORAGE`。  
仅影响新建组；已有组请在 sseinfra 面板修改。

---

## 7. 本机 compose（兼容路径）

结构：`frontend/` + `backend/` + `compose.yml`，服务名须为 `web` / `api`，端口用 `${WEB_HOST_PORT}` / `${API_HOST_PORT}`。  
持久化写容器内 `/data`（平台 bind 宿主机按环境分目录）。

---

## 8. 平台上线（运维）

```bash
cd /path/to/sse-deploy
npm run build
# 前端拷到公共 nginx 实际挂载的 /sdpy 静态目录后：
docker compose up -d --build   # 在起 sdpy-api 的目录
docker exec sse_market_server-nginx_proxy-1 nginx -s reload
```

现网公网 nginx 容器名以 `docker ps` 为准（常见为 `sse_market_server-nginx_proxy-1`，不是 `sdpy-gateway`）。

---

## 9. 对象存储（MinIO）简述

大文件（如图床）建议走 MinIO：**一个模块 + 一个环境 = 一个桶**（桶名 = 组名，如 `sdpy-image-p`）。  
模块页 → **对象存储 → 进入管理** → 申请/确保桶 → 部署 Running → **同步历史数据** → 应用读 `MINIO_*`。  

详见 [对象存储用户手册](https://ssemarket.cn/iwiki/space/space-YVgw7lRu/page/page-dF4GrtOQ) 或仓库 `SSE-Deploy-部署与数据存储指南.md` 第 4–5 节。

---

## 10. 相关文档

- **总览**：`sse-deploy/docs/SSE-Deploy-部署与数据存储指南.md`（数据目录、桶、凭据、环境变量）  
- 契约：`sse-deploy/docs/用户部署约定.md`  
- 流水线：`docs/plans/2026-08-21-K8s部署流水线.md`  
- 备忘：`docs/notes/`（Agent、迁移、环境变量分槽等）
