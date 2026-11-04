# sseinfra 面板 /api/pods/* 全部 500 故障（sdpy 部署失败）

> **日期**：2026-09-10
> **现象**：sdpy 部署报 `获取组 sdpy-image-p 失败（HTTP 500）: An unexpected error occurred`
> **影响**：所有走 sseinfra 的部署全部失败（新建组、查组、部署全挂）
> **结论**：**不是 sdpy 的 bug，也不是单个组的问题**，是 sseinfra 面板（yatterra-web）自身故障

---

## 1. 现象与错误

```
[k8s-pkg] 准备包 v-r7VRipbJHA → 组 sdpy-image-p
[sseinfra] 准备组 sdpy-image-p · 面板=https://cloud.ssemarket.cn · 账号=admin · ...
[错误] 获取组 sdpy-image-p 失败（HTTP 500）: An unexpected error occurred
    at SseinfraClient.getGroup (file:///app/dist/services/sseinfra-client.js:215:19)
    at async ensureSseinfraGroupForDeploy (file:///app/dist/services/deploy-worker.js:228:20)
```

## 2. 定位过程

### 2.1 排除「单个组」假设

实测发现**所有**组详情都 500，连不存在的组也一样：

| 探测 | 结果 |
|---|---|
| `GET /api/pods/sdpy-image-p` | 500 |
| `GET /api/pods/sdpy-join-p` | 500 |
| `GET /api/pods/image`（不存在） | 500 |
| `GET /api/pods/`（列表） | 500 |

### 2.2 排除「K8s / Pod 故障」假设

gpu（WZ8）机器 K3s 健康，目标 Pod 正常 Running：

```
NAME   STATUS   ROLES           AGE   VERSION
wz8    Ready    control-plane   23d   v1.36.3+k3s1

group-sdpy-image-p-6959b9f658-hchfd   1/1   Running   0   6d3h
```

→ **Pod 和 K8s 都没问题，问题在面板自身。**

### 2.3 定位面板位置

| 线索 | 值 |
|---|---|
| `cloud.ssemarket.cn` | → 本机公网 IP `175.178.90.215` |
| 本机 nginx `listen 24000 ssl` | → `proxy_pass http://127.0.0.1:14000` |
| `14000` | = **frps** 端口 |
| frps 代理表 `remotePort=14000` | → 代理名 **`platform-gui`**，clientID `f1c36b2f2e20d741` |
| 该 clientID 的 hostname | **`WZ8`**（= gpu 机器） |
| WZ8 上运行的服务 | **`yatterra-web.service`** — "YatTerra Management GUI" |

> 链路：`浏览器 → 本机 nginx:24000 → frps:14000 → frpc(WZ8) → gunicorn 127.0.0.1:8090`

### 2.4 找到根因

`journalctl -u yatterra-web.service`：

```
yatterra-web.service: Scheduled restart job, restart counter is at 598.
[INFO] Starting gunicorn 26.2.0
[ERROR] Connection in use: ('127.0.0.1', 8090)
[ERROR] Can't connect to ('127.0.0.1', 8090)
Main process exited, code=exited, status=1/FAILURE
```

**两层问题叠加**：

**问题 A — 端口被手动进程占用**

8090 被一个 1 小时前 `nohup` 手动启动的 gunicorn 占着（PPID=1，来自 `.claude/shell-snapshots`）：

```
2406676  PID 1  /bin/bash -c ... eval 'sudo fuser -k 8090/tcp; cd /opt/yatterra/web
                 && nohup gunicorn -w 1 -b 127.0.0.1:8090 --timeout 120 app:app ...'
2406678  2406676  gunicorn: master [app:app]
2406679  2406678  gunicorn: worker [app:app]
```

它是**旧代码的常驻内存**（21:48 启动），而 systemd 反复重启加载**新代码**却撞端口 → **重启 602 次**。

**问题 B — 真实根因：缺 Python 依赖**

清掉手动进程后，systemd 服务仍起不来，日志暴露真因：

```
File "/opt/yatterra/web/api/push.py", line 13, in <module>
    from pywebpush import webpush, WebPushException
ModuleNotFoundError: No module named 'pywebpush'
→ Worker failed to boot → status=3/NOTIMPLEMENTED
```

时间线：

| 时间 | 事件 |
|---|---|
| 21:41 | 新增 `/opt/yatterra/web/api/push.py`（PWA 推送，依赖 `pywebpush`） |
| ~21:4x | `api/__init__.py:467` 加入 `from .push import push_bp` |
| 21:48:05 | 服务起不来，某人用 `nohup gunicorn` **手动**起了一个（当时内存里是旧代码） |
| 之后 | 手动进程常驻旧代码 → 服务"半死"：`/api/auth/me` 200，但 pods 子系统 500 |

`push.py` 引入 `pywebpush`，但**系统 Python 从未安装该依赖**，导致 systemd 服务彻底无法启动。

## 3. 修复

```bash
# 1. 清掉手动启动的僵尸 gunicorn（释放 8090）
sudo kill 2406676 2406678 2406679

# 2. 安装缺失依赖（注意：官方源 pypi.org 不通，清华源 403，阿里源可用）
sudo /usr/bin/python3 -m pip install pywebpush \
  --break-system-packages -i https://mirrors.aliyun.com/pypi/simple/

# 3. 重启 systemd 正式服务
sudo systemctl restart yatterra-web.service
```

> 注意：`pywebpush 2.5.0` 要求 `cryptography>=47`，会把它从 `41.0.7` 升到 `50.0.1`。

## 4. 验证

| 端点 | 修复前 | 修复后 |
|---|---|---|
| `GET /api/pods/?per_page=200` | 500 | **200**（24 个 pod） |
| `GET /api/pods/sdpy-image-p` | 500 | **200**，`Running`，`lifecycle.ok=true` |
| `systemctl is-active yatterra-web` | active（假象） | **active**（真） |
| `NRestarts` | 602 | **0** |

```
[INFO] Listening at: http://127.0.0.1:8090
[INFO] Booting worker with pid: 2501153
```

辅助进程 `gpu_loop.py` / `pressure_writer.py` / `priority_kill.py` 未受影响。

## 5. 防复发建议

| # | 措施 | 说明 |
|---|---|---|
| 1 | **固化依赖** | `/opt/yatterra` 全项目**没有 requirements.txt / pyproject.toml**，依赖全靠手工 pip。建议补 `requirements.txt`（含 `pywebpush`），部署时 `pip install -r` |
| 2 | **禁止 `nohup` 手动起服务** | 手动进程会绕过 systemd，且常驻旧代码，造成"服务 active 但功能半死"的假象，极难排查 |
| 3 | **systemd 重启限制** | 当前 602 次静默重启掩盖了故障。建议加 `StartLimitIntervalSec` / `StartLimitBurst`，让它快速进入 `failed` 而非无限重试 |
| 4 | **sdpy 侧对 5xx 重试** | 见 `docs/plans/2026-09-09-sseinfra-API直连改造方案.md` Phase 1：对 `502/503/504` 重试。本次面板重启窗口期的瞬时 500 若带重试可自愈，不必让整次部署失败 |

## 6. 排查速查

```bash
# sseinfra 面板（WZ8）服务状态与日志
ssh root@ssemarket.cn
sudo -u sse -H ssh gpu
sudo systemctl status yatterra-web.service
sudo journalctl -u yatterra-web.service -n 50 --no-pager

# 8090 谁在听
sudo ss -lntp | grep 8090

# 面板 API 自测
curl -s http://127.0.0.1:8090/api/auth/me
```
