# 面板 Running 但 K8s 无 Pod（僵尸组）

> 日期：2026-08-26

## 根因（2026-08-26 补充）

1. **未用 admin 登录**：`.env` 只有 `k8s_password` 无 `k8s_username`，面板用空用户名登录 → 访问 `/group/xxx` 返回 **403 无权限**
2. **getGroup 误判**：403 页侧栏含「运行中」→ 旧逻辑判 `exists=true` → **跳过 POST /add 建组**
3. 仪表盘组列表中 **本无** `sdpy-ai-platform-p`

修复：凭据 `admin` + `SSE_Market`；收紧 `getGroup`；`listGroups` 交叉校验；`ensureGroup` 必须出现在仪表盘列表。

## 验证（admin + SSE_Market）

```powershell
cd sse-deploy
python scripts/_test_ensure_group.py sdpy-ai-platform-p
```

2026-08-26 实测：`POST /add` → `已创建组 sdpy-ai-platform-p`，仪表盘列表出现，组页 200 Running。

脚本：`scripts/_test_ensure_group.py`

## 现象

部署日志类似：

```text
[sseinfra] 复用已有组（running=true web=无）
[k8s-pkg] Pod Running ·
[k8s] 解析组 Pod：app=group-sdpy-ai-platform-p
error: jsonpath array index out of bounds: index 0, length 0
```

## 根因

- **sseinfra 面板 HTML** 仍含 `Running`，`waitRunning()` 通过
- **kubectl** 查 `app=group-{组名}` 在 `students` 命名空间 **items 为空**（Pod 已删/未拉起/标签不一致）
- 平台默认 **复用已有组**，不会在同步前删组重建

## 立刻怎么处理（任选）

1. **教师面板** http://ssemarket.cn:24000 → 打开组 `sdpy-ai-platform-p` → **删除组** → sdpy 模块页 **重新部署**
2. **强制重建**：在运行 deploy-api 的机器上设 `SSEINFRA_FORCE_RECREATE=1`，再点部署（会先删组再建）
3. 若有 K8s 权限：在 gpu 节点查 `kubectl -n students get pod -l app=group-sdpy-ai-platform-p`，确认是否 CrashLoop / 被误删

## 代码加固（2026-08-26）

`syncPackageAndStart` 前增加 `waitForGroupPod()`（最多约 120s 轮询）；仍无 Pod 则报错并提示删组或 `SSEINFRA_FORCE_RECREATE=1`。

## 注意

- 删组会清 **PVC**（组内 `/home/cloud/data`）；桶数据不受影响
- 模块名 `ai-platform` → 组名 `sdpy-ai-platform-p`（正式）
