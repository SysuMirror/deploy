# MinIO 同步失败：pip PEP668 + 写 env 重建 Pod

## 背景

`sdpy-image` prod「同步历史数据」：宿主机 → 跳板 → GPU → Pod 传包成功（~140MB），随后在 Pod 内上传到 MinIO 失败。

## 现象

1. 错误：`externally-managed-environment`（Debian/Ubuntu 禁止对系统 Python 随意 `pip install`）。
2. 日志里 Pod 名从 `…-t5v9h` 变成 `…-6bswh`：写组 env `MINIO_*` 触发了重建，上传落在新 Pod 上。

## 结论

- 上传脚本用 `pip install --user minio` 不够，需加 `--break-system-packages`。
- `setEnvMany` 必须放到 **上传成功之后**；上传用脚本内联 AK/SK，不依赖当次 env。
- 宿主机 `MODULE_DATA` 仍在，修代码重建 `sdpy-api` 后重新点同步即可。

## 改动

- `apps/deploy-api/src/services/minio-sync.ts`
