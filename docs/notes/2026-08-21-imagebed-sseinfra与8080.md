# imagebed sseinfra 包与 0.0.0.0:8080

日期：2026-08-21

## 现象

组页 `http://ssemarket.cn:23xxx` 打不开。面板提示：容器内须绑 **0.0.0.0:8080**。

## 结论

是。只绑 `127.0.0.1` 或未听 8080 时，frp / 网关都进不来。

## 改动

1. `用户部署约定.md` 增补 §2.0（`0.0.0.0:8080`）
2. imagebed：`main` 显式 `0.0.0.0`；识别 `SDPY_*` / `FRONTEND_DIST`
3. 仓根 `deploy.sh` + `deploy/pack-sseinfra.ps1` → `imagebed-sseinfra.zip`
4. sseinfra 部署注入 `SDPY_PUBLIC_*` / `PUBLIC_BASE`

## 使用

```powershell
cd imagebed
powershell -ExecutionPolicy Bypass -File .\deploy\pack-sseinfra.ps1
```

模块名 `image`，配 `IMAGEBED_OAUTH_REDIRECT_URI=https://ssemarket.cn/sdpy/image/oauth/callback` 后上传部署。
