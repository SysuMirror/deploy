# SSE Deploy 更新说明（2026-09-11）

> **范围**：`apps/deploy-api`（sseinfra 客户端 / 部署流水线）、`apps/deploy-web`（流水线展示）
> **性质**：sseinfra 面板 SPA 重构适配 + 部署流水线可靠性修复
> **影响**：Git 与压缩包两种部署方式；大包（>10MB）部署成功率；环境变量同步完整性
> **结论**：修掉 4 类会造成部署失败/丢配置的问题；image 模块（47.7MB 包）部署从**必失败**恢复为**成功**

---

## 1. 变更总览

| 文件 | 变更 | 解决的问题 |
|---|---|---|
| `services/sseinfra-client.ts` | HTML 抓取 → **JSON API**；新增 frps 端口解析 | 面板 SPA 重构后旧路径全部失效 |
| `services/sseinfra-client.ts` | 环境变量写入**节流 + 冲突重试** | 连续写 env 触发 K8s rollout 冲突 → HTTP 400、变量丢失 |
| `services/sseinfra-pod.ts` | 新增 `waitGroupRolloutSettled()` | 写 env 引发的 Pod 滚动更新期间 `kubectl cp` 打进旧 Pod |
| `services/sseinfra-pod.ts` | 传输**超时按体积计算 + 进度输出** | 大包经跳板→GPU 必超时（默认 5min） |
| `services/sseinfra-pod.ts` | 就绪探测 `probeUrls` / `expectContent` / http→https 自动升级 | 「有响应」≠「前端有内容」，TLS 端口误判 |
| `services/deploy-worker.ts` | Git 部署改为**本机 clone + kubectl cp** | 面板 `addDeploy/runDeploy` 不写 supervisord 配置 → `UNLOADED` |
| `apps/deploy-api/Dockerfile` | 安装 `git` | 本机 clone 依赖 |
| `components/DeployPipeline.vue` | Git 多「拉取代码」步骤；Agent 步显示「跳过」 | 流水线展示与实际流程不符 |

---

## 2. sseinfra 客户端：HTML 抓取 → JSON API

### 2.1 背景

sseinfra 面板在 2026-09 做了 SPA 重构：旧的面板是服务端渲染 HTML，sdpy 靠**正则抓 HTML + 表单 POST + csrf_token** 工作；重构后页面由前端 JS 渲染，抓 HTML 全部失效。

### 2.2 新契约（已在客户端注释中固化）

| 项 | 说明 |
|---|---|
| 认证 | `POST /api/auth/login`（JSON `{username, password}`）→ Flask session cookie |
| CSRF | `/api/*` 路径**豁免**（面板 `csrf_protect` 直接放行），cookie 即可完成全部调用 |
| 命名 | 组（旧 `group`）在 API 层叫 **pod**：`/api/pods/…` |
| 路径细节 | 列表必须带尾斜杠 `/api/pods/?per_page=100`，否则 Flask 308 重定向 |
| 登录态 | 响应体含 `is_logged_in`；401 = 账密错（5 次锁定 5 分钟），403 = 已锁定 |

### 2.3 Web / SSH 端口的解析方式变了

新面板 API **不再暴露 nodeport**（旧面板 `group.html` 上有）。现改为读宿主机 **frps dashboard JSON API**：

```
GET {SSEINFRA_FRPS_URL}/api/proxy/tcp
  → 找 grp-<组名>-web 的 remotePort
  → idx = remotePort - 13000
  → Web = https://ssemarket.cn:{23000 + idx}
  → SSH = ssh -p {22000 + idx} <user>@ssemarket.cn
```

对应的可配置项（默认值即现网）：

| 变量 | 默认 |
|---|---|
| `SSEINFRA_FRPS_URL` | `http://172.17.0.1:7501` |
| `SSEINFRA_FRPS_USER` / `_PASS` | `admin` / `SSE_Market` |
| `SSEINFRA_WEB_PUBLIC_BASE` | `23000` |
| `SSEINFRA_WEB_FRP_BASE` | `13000` |
| `SSEINFRA_SSH_FRP_BASE` | `22000` |

> 该客户端同时收敛为 `request()` / `authedRequest()` 两入口，写操作前经 `beforeWrite()` 强制重登（面板 session 偶发过期）。

---

## 3. 环境变量写入：节流 + 冲突重试 ⭐

### 3.1 现象

部署日志出现大量：

```
[env] setEnvMany 失败，回退逐个写入: 写环境变量 IMAGEBED_OAUTH_REDIRECT_URI 失败（HTTP 400）:
kubectl rollout restart deployment/group-sdpy-image-p failed: error: failed to create patch
for group-sdpy-image-p: if restart has already been triggered within the past second,
please wait before attempting to trigger another
[env] 已向组同步环境变量 11/14 个（含平台键）
```

**14 个变量只写进去 11 个**。

### 3.2 根因（面板侧）

面板 `groups.py` 的 `set_env()` 每写**一个**键就重启一次 Deployment：

```python
def set_env(name, key, value):
    g["env"][key] = (value or "")
    apply_group(g)
    kubectl("rollout", "restart", f"deployment/group-{name}")   # ← 每个键都重启
    save_state(state)                                          # ← 在 kubectl 之后
```

`kubectl rollout restart` 是给 Pod 模板打 `restartedAt` 时间戳，**同一秒内第二次会被 K8s 拒绝**。sdpy 一次同步 14 个变量 → 必然有若干次落在同一秒 → 400。

> **更严重的是**：`save_state()` 在 `kubectl` 之后，写失败的键**连面板状态都没落盘**，等于真丢配置，不只是显示问题。

旁证：出问题的 Deployment `generation` 已达 **352**，即历史上被重启过 352 次。

### 3.3 修复

写入彼此**强制间隔 >1s**，并对「rollout 冲突」类错误退避重试（其它错误如权限/参数仍立即失败）：

```ts
/** 面板每写一个键都会 rollout restart，两次落在同一秒会被 K8s 判冲突 */
function envWriteGapMs(): number { /* 默认 1200，可用 SSEINFRA_ENV_WRITE_GAP_MS 覆盖 */ }
function isRestartConflict(msg: string): boolean {
  return /already been triggered within the past second|failed to create patch|the object has been modified/i.test(msg);
}
```

节流是**按组全局**的（`lastEnvWriteAt`），批量写入与降级后的逐个写入都会被间隔开。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SSEINFRA_ENV_WRITE_GAP_MS` | `1200` | 两次实际写入的最小间隔（ms） |
| `SSEINFRA_ENV_WRITE_RETRY` | `4` | 每个键最大尝试次数（仅冲突重试） |

### 3.4 验证（真实面板，回写既有变量的相同值，不改配置）

| 场景 | 结果 |
|---|---|
| 复现：间隔设 `0`、写 2 个键 | 第 2 个键**命中同一冲突** → 与线上报错逐字一致 |
| 修复：默认间隔、写 6 个键 | **全部成功**，实测最小间隔 2403ms |
| 线上部署 14 个键 | `[env] 已向组同步环境变量 14 个（含平台键，单次登录）`，**零 400、未走降级** |

---

## 4. 写 env 之后等待 rollout 收敛 ⭐

### 4.1 问题

写 env 会触发 rollout，Pod 被**整体替换**。原流程是「推 env」→「直接 `kubectl cp`」，中间没有等待，日志里可见 Pod 名跨阶段变化：

```
env 阶段   pod=group-sdpy-image-p-854bdb665d-4clzs
cp  阶段   pod=group-sdpy-image-p-78d89667f4-q7qq9   ← 换了
```

`kubectl cp` 有可能打进一个**正在被终止**的旧 Pod。这是随机失败，排查成本极高。

### 4.2 修复：`waitGroupRolloutSettled()`

- 阻塞等 `kubectl rollout status` 收敛
- **过滤 `deletionTimestamp` 非空的 Pod**（即正在删除的旧 Pod），只返回可用者
- 超时**不硬失败**：若已发现可用 Pod 则降级使用并告警，避免把原本能成的部署变失败

```ts
export async function waitGroupRolloutSettled(
  group: string, log?, opts?: { timeoutMs?, intervalMs?, signal? }
): Promise<string>   // 返回稳定后的 Pod 名，可直接用于 kubectl cp
```

接入位置：`pushEnvToSseinfraGroup()` 之后、`syncPackageAndStart()` 之前（压缩包与 Git 两条链路各一处）。

### 4.3 性能注意（重要）

跳板→gpu 是**两层 SSH**，单次往返约 20s。初版实现用了两次远程调用等 rollout，实测 **62s**；合并为单次远程调用（`rollout status` + 列 Pod 合并到一条脚本）后降到 **9~12s**。

> 教训：这条链路上**每一次额外远程调用都是 ~20s 成本**，实现时必须合并。

### 4.4 验证

```
[k8s] rollout 已收敛 pod=group-sdpy-image-p-647759bb5f-78zhq（耗时 12s）
[k8s] 解析到 pod=group-sdpy-image-p-647759bb5f-78zhq     ← cp 目标与收敛 Pod 一致
```

---

## 5. 大包传输：超时按体积计算 + 进度输出 ⭐

### 5.1 现象

47.7MB 的包在「跳板→GPU」一步卡死，5 分钟后报：

```
[错误] 命令超时(300000ms): sshpass -p *** ssh ... root@ssemarket.cn
```

### 5.2 根因

**本机 → GPU 走 Tailscale DERP 中继（`lax`，洛杉矶），无直连：**

```
GPU 节点: WZ8  100.97.31.26
  CurAddr: (空 = 无直连，走 DERP 中继)
  Relay  : lax
  tx 724541560                        ← 已往 GPU 推了 724MB
```

实测（`tailscale status` / `ping` / `netcheck`）：

| 指标 | 实测 |
|---|---|
| Tailscale ping GPU | RTT 356~1441ms（`ping -c 6` avg **1441ms**） |
| 丢包 | 10~20% |
| 5MB scp | 90s 只传 0.7MB（**≈8KB/s**） |
| `netcheck` 最近中继 | 应为香港 `hkg` 157ms，实际在用 `lax` |

> 顺带澄清一个易错认知：**sdpy-api 宿主机本身就是那个「跳板」**（Tailscale 身份 `100.67.13.77` 一致），`ssh root@ssemarket.cn` 其实是本地跳（0.235ms）。真正慢的只有**本机 → GPU** 这一跳。

**与包体积的强关联**（决定为什么只有 image 挂）：

| 模块 | 包大小 | 结果 |
|---|---|---|
| **image** | **177.98 MB**（含 `web/node_modules` 174MB） | ❌ 必超时 |
| developer | 2.06 MB | ✅ |
| ai-platform | 1.62 MB | ✅ |
| join / test-join / dshm / quest | ≤0.82 MB | ✅ |

image 打成 tar 后 **47.70MB**；在 ~31KB/s 链路上需约 25 分钟，**远超默认 300s**。

### 5.3 修复

复用 migrate 路径早已存在的策略（**部署路径此前遗漏**）：

```ts
// 跳板→GPU 常走 Tailscale DERP 中继，RTT 可达 1s+、偶发丢包，实测吞吐可能低至 100KB/s 量级；
// 默认 5min 会让 40MB+ 的包必定超时（历史故障）。故按体积给足超时（至少 30min 或约 15s/MB），
// 并复用带进度的传输函数，避免长传输期间日志「假死」。
const hopTimeoutMs = Math.max(1_800_000, Math.ceil(sizeMb) * 15_000);
await scpJumpToGpuWithProgress({ tarName, totalBytes, timeoutMs: hopTimeoutMs, log, tag: 'k8s', signal });
```

`scpJumpToGpuWithProgress()` 同时补了 `tag`（日志前缀，区分 migrate/deploy）与 `signal`（保留「取消部署」能力）。

### 5.4 验证

```
[k8s] 跳板→GPU 超时上限 30min（包 47.70MB）
[k8s] 跳板→GPU 开始，目标 47.7MB（前台 scp + 并行进度，超时上限 30min）
[k8s] 跳板→GPU 1.1/47.7 MB (2%)
[k8s] 跳板→GPU 3.4/47.7 MB (7%)        ← 进度可见，不再「假死」
```

> **遗留**：体积守仍是 `> 80MB` 才拦，47.7MB 恰好掠过。且 DERP 中继本身是短板（见 §9）。

---

## 6. 就绪探测增强

### 6.1 问题

旧 `waitForHttpReady()` 只探 `http://host:port/`，且**拿到任意 HTTP 状态码就算就绪**。后果：

- 「有响应」≠「前端有内容」：应用起来了但前端 404/空壳也判成功
- 探测 `http://` 打到 TLS 端口会得 400/426/497，被误判为「未就绪」

### 6.2 修复

| 新增项 | 作用 |
|---|---|
| `probeUrls?: string[]` | 指定完整 URL 探测（如 `https://join.ssemarket.cn/`），替代默认 `host:port` 根路径 |
| `expectContent?: boolean` | 严格模式：要求 **HTTP 2xx 且响应体非空**，即「前端有内容」 |
| http→https 自动升级 | `http://` 探测得 **400/421/426/497** 时，自动改试同 host:port 的 `https://` |

`waitFrpReady()` 相应改为：用 `gatewayUpstreamHost()` 拼 **frps 原生端口**（`frpPort - 10000`，如 `13002`）作为**首选**探测目标，并把前端公网 URL 作为次级目标；`expectContent: true`。

> 探 frps 原生端口的好处：它是容器内可达的真实 HTTP 入口，**不依赖公网 nginx 子域路由是否已写好**。

### 6.3 验证

```
[ready] http://host.docker.internal:23002/ → HTTP 400（疑似 http 打 TLS 端口），自动改试 https://...
[ready] 前端有内容（http://host.docker.internal:13002/ → HTTP 200，响应体 564 字节，耗时 2min）
```

---

## 7. Git 部署流程重构 ⭐

### 7.1 问题

原 Git 部署走面板 `addDeploy` + `runDeploy`，但面板**不生成 Pod 内的 supervisord program 配置**，导致：

```
[sseinfra] status=UNLOADED
[pod] (无日志)
```

排查确认：Pod 内 `/home/cloud/deploy/programs/` 为空、`status.raw` 为 `ERROR (no such process)`，而 Git 仓库其实**已成功 clone 进 Pod**。即便配置了全部 21 个环境变量仍复现。

### 7.2 新流程：本机 clone，复用压缩包链路

```
① 本机 git clone（带 token）→ work/{deploymentId}/
② 校验根目录存在 deploy.sh（组内无 Docker，必须靠 deploy.sh + supervisord）
③ 打包 tar → scp 跳板 → scp/中继到 GPU → kubectl cp 进 Pod
④ 写 supervisord program 配置并 start
```

即：**Git 与压缩包共用同一条「tar → kubectl cp → supervisord」链路**，只是第 ① 步换成从仓库取源码。面板的 `addDeploy/runDeploy` 不再参与。

> 与压缩包部署的差异：Git 多一步**拉取代码**（同时也是「为什么 Git 需要容器内安装 git」的原因）。

### 7.3 配套

- `apps/deploy-api/Dockerfile` 增加 `git`（本机 clone 前置；注意实际生效的是 `api/Dockerfile`，两处需一致）
- 前端流水线新增「拉取代码」步骤（见 §8）

---

## 8. 前端流水线展示（`DeployPipeline.vue`）

Git 与压缩包流程不同，展示同步修正：

| 项 | 变更 |
|---|---|
| 新增步骤 | Git 部署多一步 **「拉取代码」**（`cloneOk` 由日志 `Git 提交:` / `仓库已下载到本机` 判定） |
| Agent 步骤 | Git 仓库自带 `deploy.sh`，不启动 Agent → 显示 **「跳过」**（此前误显示「失败」） |
| 准备源码 | 提示按类型区分：Git = 「校验 deploy.sh」；压缩包 = 「解压压缩包」 |

---

## 9. 遗留与后续建议

| 项 | 说明 |
|---|---|
| **DERP 中继是根本短板** | 本机→GPU 无直连、走 `lax`，实测 8~31KB/s。任何 >10MB 的包都很痛苦。建议排查为何不走直连（UDP 已通）、或改用离得近的中继（`hkg`）/自建 DERP |
| 体积守卫偏松 | 现为 `> 80MB` 才拦。建议降低阈值，并在**包绑定时**就提示过大 |
| image 模块包可瘦身 | 现绑 `v-r7VRipbJHA`（177.98MB，含 `web/node_modules` 174MB）。模块内已有 **33.96MB** 的新包（自带预编译 `bin/imagebed`，无 node_modules），tar 后约 14MB，可省约 3.4 倍传输时间 |
| 面板 `set_env` 仍会重启 N 次 | 写 14 个键 = 14 次 Pod 重启（`generation` 已 352）。**建议向面板提需求：批量 env 接口，一次写入只 restart 一次** |
| 可优化：只写变化的键 | 写 env 前比对当前值，无变更时不写 → 0 次重启 |

---

## 10. 验证记录（本次线上部署）

| 项 | 结果 |
|---|---|
| 部署 ID | `dep-SomGdVx0N67x` |
| 状态 | **success** |
| 耗时 | 16:00:47 → 16:13:37（约 12 分 50 秒） |
| 地址 | https://image.ssemarket.cn |
| 页面 | HTTP 200 |
| 资源 | `/assets/index-*.js`、`/assets/index-*.css` 均 **200** |
| 备用入口 | `/test/image/`、`/image/` 均 **200** |

---

## 11. 修订记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-09-11 | 首版：汇总 2026-09-05 ~ 09-10 的客户端迁移与流水线修复 |
