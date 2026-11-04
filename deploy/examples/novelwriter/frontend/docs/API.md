# NovelWriter Web API 文档

本文档描述 Vue 前端（`web/`）调用的后端 REST / SSE / WebSocket 接口。默认开发环境：

| 项 | 值 |
|----|-----|
| 前端 | `http://localhost:8001`（Vite） |
| 后端 API | `http://localhost:8002/api`（经 Vite proxy 同源访问 `/api`） |
| WebSocket | 同源 `/socket.io` → 代理到 8002 |

生产部署可设置 `VITE_API_URL` 指向 API 根地址（不含 `/api` 后缀）。

---

## 全局约定

### Base URL

```
{API_URL}/api
```

- 开发：`API_URL = ''`（空字符串，走 Vite 代理）
- 生产：同域或 `VITE_API_URL=https://api.example.com`

### 认证

| 方式 | 说明 |
|------|------|
| Cookie | `withCredentials: true`，Better-Auth / Session |
| Bearer | 部分流式接口备用 `Authorization: Bearer <token>`（localStorage） |

### 错误响应

```json
{
  "error": "错误描述",
  "message": "可选备用字段"
}
```

HTTP 401 时前端清除 `localStorage.token`，不强制跳转登录。

### 异步任务模式

多数 AI 生成接口返回：

```json
{ "id": "task-uuid" }
```

客户端应：

1. `GET /api/tasks/:taskId` 轮询状态
2. Socket.IO `subscribe:task` 订阅实时进度

---

## 1. 认证 Auth

### POST `/api/auth/signin`

登录（页面使用）。

**请求体**

```json
{ "email": "user@example.com", "password": "secret" }
```

### POST `/api/auth/register`

注册。

**请求体**

```json
{ "email": "user@example.com", "password": "secret", "name": "昵称" }
```

**响应**

```json
{ "token": "jwt...", "user": { "id": "...", "email": "...", "name": "..." } }
```

### GET `/api/auth/me`

当前用户（Bearer token）。

### GET `/api/auth/get_user`

用户资料（Settings 页）。

**响应**

```json
{ "user": [{ "name": "...", "email": "..." }] }
```

### POST `/api/auth/update_user`

更新资料。

**请求体**

```json
{ "name": "昵称", "email": "user@example.com" }
```

---

## 2. 作品 Novels

### GET `/api/novels`

作品列表。

### GET `/api/novels/:id`

作品详情（含 `volumes`, `chapters`, `characters`, `outlineVersions`, `knowledgeBases` 等）。

### POST `/api/novels`

创建作品。

**请求体示例**

```json
{
  "title": "书名",
  "genre": ["玄幻"],
  "style": ["爽文"],
  "targetWords": 200000,
  "minChapterWords": 3000,
  "background": "背景…",
  "worldSettings": {
    "timeBackground": "",
    "worldRules": [],
    "powerSystem": "",
    "forbiddenRules": []
  }
}
```

**响应**

```json
{ "id": "novel-uuid" }
```

### PATCH `/api/novels/:id`

更新作品字段。

### PATCH `/api/novels/:id/cover`

上传封面，`multipart/form-data`。

### DELETE `/api/novels/:id`

删除作品。

### PATCH `/api/novels/:id/outline`

更新大纲正文。

```json
{ "content": "大纲全文…" }
```

### POST `/api/novels/:id/condense-outline`

精简大纲。

**响应**

```json
{ "condensedOutline": "…" }
```

### GET `/api/novels/:id/outline/versions`

大纲版本列表。

### POST `/api/novels/:id/outline/versions`

保存版本。

```json
{ "content": "…", "context": {}, "mode": "manual" }
```

### PATCH `/api/novels/:id/outline/versions/:versionId/lock`

```json
{ "isLocked": true }
```

### POST `/api/novels/:id/outline/versions/:versionId/rollback`

回滚到指定版本。

### GET `/api/novels/:id/generate/outline/stream`（SSE）

流式生成大纲。

**Query**

| 参数 | 说明 |
|------|------|
| `mode` | `initial` / `continue` 等 |
| `existingOutline` | 续写时传入已有大纲 |

**SSE 事件**

```json
{ "type": "chunk", "content": "文本片段" }
{ "type": "done" }
{ "type": "error", "error": "原因" }
```

### POST `/api/novels/suggestions/titles`

AI 书名建议。

```json
{ "genre": [], "style": [], "background": "…" }
```

**响应**

```json
{ "titles": ["书名1", "书名2"] }
```

### POST `/api/novels/suggestions/expand-background`

扩写背景。

### GET `/api/novels/:id/export`

导出。Query: `format=json|txt|epub`。

### POST `/api/novels/import`

导入 JSON 或 `multipart`（txt/epub）。

```json
{ "...": "作品数据", "initialize": true }
```

### POST `/api/novels/:id/extract-style`

文风提取。

```json
{ "sampleText": "样本文本…" }
```

### POST `/api/novels/:id/chapters/read-through`

全文通读修订（2～5 章）。

```json
{ "chapterIds": ["ch1", "ch2"] }
```

---

## 3. 人物 / 伏笔 / 时间线

### 人物

| 方法 | 路径 |
|------|------|
| GET | `/api/novels/:novelId/characters` |
| POST | `/api/novels/:novelId/characters` |
| POST | `/api/novels/:novelId/characters/generate` |
| PATCH | `/api/novels/:novelId/characters/:characterId` |
| DELETE | `/api/novels/:novelId/characters/:characterId` |

**创建人物请求体**

```json
{
  "name": "张三",
  "role": "主角",
  "personality": ["冷静"],
  "abilities": [{ "name": "剑术", "level": 5 }],
  "currentState": "…",
  "relationships": [{ "characterId": "…", "relation": "师徒" }]
}
```

### 伏笔 Plot Threads

| 方法 | 路径 |
|------|------|
| GET | `/api/novels/:novelId/threads` |
| POST | `/api/novels/:novelId/threads` |
| PATCH | `/api/novels/:novelId/threads/:threadId` |
| DELETE | `/api/novels/:novelId/threads/:threadId` |

### 时间线 Timeline

| 方法 | 路径 |
|------|------|
| GET | `/api/novels/:novelId/timeline` |
| POST | `/api/novels/:novelId/timeline` |
| PATCH | `/api/novels/:novelId/timeline/:eventId` |
| DELETE | `/api/novels/:novelId/timeline/:eventId` |

---

## 4. 分卷与章节生成

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/novels/:id/generate/outline` | 异步生成大纲 |
| POST | `/api/novels/:id/generate/volumes` | 生成分卷 |
| POST | `/api/novels/:id/volumes/batch` | 批量保存卷 |
| PATCH | `/api/novels/:id/volumes/:volumeId` | 更新卷 |
| DELETE | `/api/novels/:id/volumes/:volumeId` | 删除卷 |
| POST | `/api/novels/:id/generate/chapters` | 生成章节计划 |
| POST | `/api/novels/:id/volumes/:volumeId/chapters/batch` | 批量保存章 |
| POST | `/api/novels/:id/chapters/:chapterId/generate` | 生成章节正文 |

**generate/volumes 请求体**

```json
{ "outline": "…", "additionalRequirements": "可选" }
```

**generate/chapters 请求体**

```json
{
  "outline": "…",
  "volumeId": "vol-uuid",
  "additionalRequirements": "",
  "targetCount": 10
}
```

---

## 5. 章节 Chapters

| 方法 | 路径 |
|------|------|
| GET | `/api/chapters/:chapterId` |
| PATCH | `/api/chapters/:chapterId` |
| DELETE | `/api/chapters/:chapterId` |

**PATCH 请求体**

```json
{ "title": "第一章", "content": "正文…", "outline": "章纲" }
```

### 快照

| 方法 | 路径 |
|------|------|
| GET | `/api/chapters/:id/snapshots` |
| POST | `/api/chapters/:id/snapshots` |
| GET | `/api/chapters/:id/snapshots/:snapshotId` |
| POST | `/api/chapters/:id/snapshots/:snapshotId/restore` |
| DELETE | `/api/chapters/:id/snapshots/:snapshotId` |

### 章节 AI 分析

| 方法 | 路径 | 请求体 |
|------|------|--------|
| POST | `/api/chapters/:id/ooc-check` | `{ "content": "…" }` |
| POST | `/api/chapters/:id/extract-plot-threads` | — |
| POST | `/api/chapters/:id/infer-timeline` | — |
| POST | `/api/chapters/:id/extract-knowledge` | — |
| POST | `/api/chapters/:id/rewrite-paragraph` | 见下 |

**rewrite-paragraph**

```json
{
  "paragraphText": "选中段落",
  "restOfChapterContent": "章节其余内容",
  "additionalInstructions": "可选"
}
```

**响应**

```json
{ "content": "改写后段落" }
```

---

## 6. 任务 Tasks

### GET `/api/tasks/:taskId`

查询异步任务状态。

```json
{
  "status": "completed | failed | running | not_found",
  "error": "可选",
  "result": { "chapters": [], "volumeId": "…" }
}
```

---

## 7. AI 配置

| 方法 | 路径 |
|------|------|
| GET | `/api/ai-config` |
| POST | `/api/ai-config` |
| PATCH | `/api/ai-config/:id` |
| DELETE | `/api/ai-config/:id` |
| POST | `/api/ai-config/:id/set-default` |

**配置对象**

```json
{
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "apiKey": "sk-…",
  "baseUrl": "https://api.openai.com/v1",
  "parameters": { "temperature": 0.7, "maxTokens": 1000000 },
  "isDefault": true,
  "purpose": "default | ai_detection"
}
```

---

## 8. 知识库 Knowledge

| 方法 | 路径 |
|------|------|
| GET | `/api/knowledge` |
| GET | `/api/knowledge/:novelId` |
| POST | `/api/knowledge/:novelId` |
| PATCH | `/api/knowledge/:novelId/:id` |
| DELETE | `/api/knowledge/:novelId/:id` |
| GET | `/api/knowledge/:novelId/:kbId/documents` |
| POST | `/api/knowledge/:novelId/:kbId/documents` |
| DELETE | `/api/knowledge/:novelId/:kbId/documents/:docId` |
| POST | `/api/knowledge/:novelId/:kbId/search` |

**搜索请求**

```json
{ "query": "关键词", "limit": 5 }
```

---

## 9. 对话 Chat（SSE）

### POST `/api/chat`

**请求体**

```json
{
  "novelId": "novel-uuid",
  "message": "用户消息",
  "previousContent": "当前章节上下文（可选）"
}
```

**响应**：`text/event-stream`

```
data: {"content":"片段"}

data: [DONE]
```

---

## 10. Agent 工作流

### POST `/api/agent/session`

创建会话。

```json
{ "novelId": "可选", "title": "可选" }
```

**响应**

```json
{ "sessionId": "…", "novelId": "…" }
```

### GET `/api/agent/skills`

技能列表。

### GET `/api/agent/conversations`

历史会话列表。

### GET `/api/agent/session/:sessionId/messages`

消息历史。

### POST `/api/agent/session/:sessionId/process`

非流式处理。

```json
{ "userInput": "帮我规划前三章" }
```

**响应 `AgentResponse`**

```json
{
  "success": true,
  "message": "…",
  "data": {
    "plan": { "steps": [], "currentStepIndex": 0 },
    "workflow": { "action": "…", "analysis": "…" },
    "confirmation": {
      "skillName": "…",
      "message": "是否执行？",
      "options": [{ "label": "确认", "value": "confirm" }]
    },
    "skillResults": [],
    "aiAnalysis": "…"
  }
}
```

### POST `/api/agent/session/:sessionId/process/stream`

NDJSON 流式事件：

| type | 说明 |
|------|------|
| `status` | 状态消息 |
| `stream_round` | 迭代轮次 |
| `chunk` | 文本块 `{ text }` |
| `result` | 完整 AgentResponse |
| `error` | 错误 |
| `done` | 结束 |

### POST `/api/agent/session/:sessionId/confirm`

### POST `/api/agent/session/:sessionId/confirm/stream`

```json
{ "choice": "confirm | cancel | modify", "modifications": [] }
```

---

## 11. 推演沙盒 Sandbox

| 方法 | 路径 |
|------|------|
| GET | `/api/novels/:novelId/sandboxes` |
| POST | `/api/novels/:novelId/sandboxes` |
| PATCH | `/api/sandboxes/:id` |
| DELETE | `/api/sandboxes/:id` |
| POST | `/api/sandboxes/:id/generate` |

---

## 12. WebSocket（Socket.IO）

连接地址：与 `API_URL` 同源，path `/socket.io`。

### 客户端 → 服务端

| 事件 | 载荷 |
|------|------|
| `subscribe:task` | `taskId: string` |

### 服务端 → 客户端

| 事件 | 载荷 |
|------|------|
| `global:task:log` | AI 调用日志 |
| `novel:updated` | `{ novelId }` |
| `task:progress` | `{ progress, message }` |
| `task:completed` | `{ type, result }` |

**global:task:log 示例**

```json
{
  "interactionId": "…",
  "type": "llm",
  "status": "chunk | running | completed | failed",
  "message": "…",
  "chunk": "流式文本",
  "provider": "openai",
  "model": "gpt-4",
  "timestamp": "ISO8601"
}
```

---

## 前端代码映射

| 模块 | 文件 |
|------|------|
| Axios 客户端 | `web/src/api/client.ts` |
| API 方法 | `web/src/api/index.ts` |
| Socket | `web/src/stores/socket.ts` |
| 流式 Chat | `chatStream()` |
| 流式 Agent | `agentProcessStream()` |

---

## 版本说明

- 本文档基于原 Next.js `frontend/lib/api.ts` 与页面调用反推。
- Agent 存在两套端点（`lib/api.ts` 工具确认型 vs `agent/page.tsx` 技能工作流型）；Vue 版默认使用**技能工作流型**（`process/stream`）。
- 仓库内若未包含后端源码，以实际部署的后端行为为准。
