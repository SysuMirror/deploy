# NovelWriter（SSE Deploy 示例包）

从 `E:\app\NovelWriter` 整理而来，符合平台约定：

```text
frontend/   # 原 web/
backend/    # 原 Python FastAPI（非 backend-go）
compose.yml
```

## 说明

- 服务名必须为 `web` / `api`
- 前端构建默认 `VITE_API_URL=""`，浏览器同源请求 `/api`、`/ws`，由前端容器 nginx 反代到 `api:8002`
- 数据卷 `novelwriter-data` 持久化 SQLite 与 uploads
- **未包含** `backend-go`；当前部署用 Python 后端
- 构建加速：后端用清华 PyPI（预编译 wheel，不装 gcc）；前端用 npmmirror；基础镜像仍为官方 `python`/`node`/`nginx`
- 健康检查：`GET /health`
- 上线前请在设置页配置 AI 模型（API Key），并修改 `JWT_SECRET`

## 打包上传

将本目录打成 zip（根下直接是 `frontend/`、`backend/`、`compose.yml`）后上传 SSE Deploy。

```powershell
# 在 examples/novelwriter 目录执行（勿多包一层目录）
Compress-Archive -Path frontend,backend,compose.yml -DestinationPath ..\..\..\release-sdpy\novelwriter-sdpy.zip -Force
```
