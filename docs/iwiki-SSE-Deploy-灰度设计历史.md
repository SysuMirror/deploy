> **版本**：v1.0  
> **状态**：历史说明（已弱化）  
> **源稿**：仓库 `docs/灰度发布设计.md`

---

## 说明

初版曾规划「Header 灰度 + 镜像晋升」。当前实现改为：

**测试 / 正式各自独立 `docker compose` 部署**，路径分别为 `/sdpy/test/{module}/` 与 `/sdpy/{module}/`。

请以《用户部署指南》《架构与原理》为准。本文仅保留对照，避免与旧 PRD 混淆。

### 旧模型（已废弃）

| 槽位 | 旧访问形态 |
|------|------------|
| test | `/test/{module}` 等 |
| prod | 子域名或灰度 Header 切到测试容器 |

### 当前模型

| 槽位 | 前端路径 | API 路径 |
|------|----------|----------|
| test | `/sdpy/test/{module}/` | `/sdpy/test/{module}-api/` |
| prod | `/sdpy/{module}/` | `/sdpy/{module}-api/` |

路由由 `data/nginx/modules.conf` 管理。

---

## 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-09 | 归档 |
