# 平台持久化数据说明（容器外）

生产环境所有可变数据必须落在宿主机，**不要**写进镜像层。

## 目录

```text
${SDPY_HOST_DATA}/data/
  deploy.db              # SQLite
  uploads/               # 用户上传包（按模块/版本）
  work/                  # 部署工作目录
  nginx/modules.conf     # 模块反代路由
```

## 配置

在 `api/.env`：

```bash
SDPY_HOST_DATA=/绝对路径/到/api目录
```

`docker-compose.yml` 会：

1. 挂载 `${SDPY_HOST_DATA}:${SDPY_HOST_DATA}`（路径与宿主机一致，供 docker.sock 部署）
2. 再挂载 `${SDPY_HOST_DATA}/data`（明确持久化边界）
3. 注入 `DEPLOY_DATA_DIR=${SDPY_HOST_DATA}/data`

## 用户模块数据

用户模块的 SQLite / 上传文件统一在宿主机：

```text
/root/SSE_Market/sse-sdpy/data/{模块名}/test/
/root/SSE_Market/sse-sdpy/data/{模块名}/prod/
```

测试与正式拆开；目录不存在时由平台自动创建，并 bind 到该模块 `api` 容器的 `/data`。重建模块容器不会丢失。
通过环境变量 `MODULE_DATA_ROOT` 可改根路径（默认 `/root/SSE_Market/sse-sdpy/data`）。

## 升级

只更新 `dist/` + `docker compose up -d --build`，**不要删**宿主机 `data/` 目录。
