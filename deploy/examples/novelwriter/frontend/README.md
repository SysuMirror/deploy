# NovelWriter Web（Vue 3）

由原 `frontend/` Next.js + React TSX 一比一重构的 Vue 3 前端，目标更好的运行时性能与更小的打包体积。

## 技术栈

- Vue 3 + TypeScript + Vite 6
- Vue Router 4（History 模式）
- Pinia（Socket 状态）
- Tailwind CSS 3
- Axios + 原生 fetch（SSE / NDJSON 流）
- Socket.IO Client

## 快速开始

```bash
cd web
npm install
npm run dev
```

访问 http://localhost:8001 。开发时 `/api` 与 `/socket.io` 由 Vite 代理到 `http://localhost:8002`。

## 环境变量

复制 `.env.example` 为 `.env`：

```env
# 留空则开发环境走 Vite 代理；生产填 API 根地址（不含 /api）
VITE_API_URL=
BACKEND_DEV_PROXY_URL=http://localhost:8002
```

## 路由对照（与 TSX 版一致）

| 路径 | 说明 |
|------|------|
| `/` | 首页 |
| `/novels` | 藏书阁 |
| `/novels/new` | 新建作品 |
| `/novels/detail?id=` | 作品详情（多 Tab） |
| `/chapters/edit?id=` | 章节编辑器 |
| `/agent` | AI 写作助手 |
| `/stats` | 写作统计 |
| `/knowledge` | 知识库 |
| `/settings` | 系统设置 |
| `/login` `/register` | 认证 |

## API 文档

详见 [docs/API.md](./docs/API.md)。

## 构建

```bash
npm run build
npm run preview
```

产物在 `dist/`，可配合 `nginx.conf` 静态托管，并将 `/api` 反代到后端。

## 与 frontend/ 的关系

- `frontend/` 仍保留 Next.js + Flutter 混合目录；**Web 新实现位于 `web/`**。
- 功能对齐：作品 CRUD、大纲流式、章节生成、人物卡、Agent、设置、统计等。
- 部分次要 Tab（伏笔、时间线、关系图）可在 `NovelDetailView` 中继续扩展子组件。
