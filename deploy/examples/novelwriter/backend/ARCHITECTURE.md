# NovelWriter Backend Architecture

## 技术栈

| 层 | 选型 |
|---|---|
| Web 框架 | FastAPI (async, SSE streaming) |
| ORM | SQLAlchemy 2.0 (declarative, SQLite) |
| 数据校验 | Pydantic v2 (camelCase ↔ snake_case 自动转换) |
| 认证 | JWT (python-jose + passlib/bcrypt) |
| AI 调用 | OpenAI SDK (兼容 DeepSeek 等 OpenAI 兼容 API) |
| 实时通信 | Native WebSocket (JWT 认证) |

---

## 目录结构

```
backend/
├── main.py                  # FastAPI 入口，CORS，WebSocket，lifespan
├── config.py                # Pydantic Settings（端口/DB路径/JWT/上传目录）
├── database.py              # SQLAlchemy engine + session + Base
│
├── models/                  # ORM 模型
│   ├── base.py              # new_id(), TimestampMixin
│   ├── user.py              # User
│   ├── novel.py             # Novel
│   ├── chapter.py           # Volume, Chapter, ChapterSnapshot
│   ├── character.py         # Character, PlotThread, TimelineEvent
│   ├── knowledge.py         # KnowledgeBase, KnowledgeDocument
│   ├── ai_config.py         # AIConfig, Task, Sandbox
│   ├── agent.py             # AgentSession, AgentMessage, AILog
│   └── outline.py           # OutlineVersion, WritingStyleRule
│
├── schemas/__init__.py      # 全部 Pydantic 请求/响应模型
│
├── routers/                 # API 路由
│   ├── auth.py              # /api/auth/*      注册/登录/个人信息
│   ├── novels.py            # /api/novels/*    小说 CRUD + AI 辅助生成
│   ├── chapters.py          # /api/*           卷/章节 CRUD + AI 分析
│   ├── characters.py        # /api/novels/*    角色 CRUD + AI 生成
│   ├── knowledge.py         # /api/knowledge/* 知识库 + 文档管理
│   ├── ai_config.py         # /api/ai-config/* AI 配置 CRUD
│   ├── chat.py              # /api/chat        AI 聊天（SSE 流式）
│   ├── agent.py             # /api/agent/*     Agent 会话 + 流式处理
│   ├── outline.py           # /api/novels/*    大纲版本管理
│   ├── tasks.py             # /api/tasks/*     异步任务查询
│   ├── sandboxes.py         # /api/*           创意沙盒
│   ├── plot_threads.py      # /api/novels/*    情节线 CRUD
│   └── timeline.py          # /api/novels/*    时间线 CRUD
│
├── services/
│   ├── ai_service.py        # OpenAI SDK 封装（chat/chat_stream/DeepSeek 适配）
│   ├── auth_service.py      # 注册/登录/用户信息
│   └── agent/               # Agent 层
│       ├── base.py          # BaseAgent + AGENT_SKILLS 定义
│       ├── orchestrator.py  # 意图分类 + 路由 + 消息持久化
│       ├── author.py        # 续写/起名/扩写背景/风格提取/段落重写
│       ├── outline.py       # 大纲生成/精简/卷规划/章规划
│       ├── character.py     # 角色生成/OOC 检测
│       ├── reader.py        # 阅读体验审计/通读报告
│       ├── knowledge.py     # 知识点提取/知识库检索
│       ├── foreshadowing.py # 伏笔提取/时间线推断
│       └── ai_detector.py   # AI 痕迹检测
│
├── middleware/auth.py       # JWT Bearer 认证依赖（get_current_user）
├── websocket/manager.py    # WebSocket 连接管理（广播/任务订阅）
├── utils/
│   ├── __init__.py          # JWT create_token / verify_token
│   └── helpers.py           # new_id()
└── uploads/                 # 静态文件目录
```

---

## 请求生命周期

### 1. 普通 HTTP 请求

```
客户端 → CORS 中间件 → 路由匹配 → auth.get_current_user（JWT 校验）
       → Pydantic 请求体校验（camelCase → snake_case）
       → SQLAlchemy Session（get_db 依赖注入）
       → 业务逻辑
       → Pydantic 响应序列化（snake_case → camelCase）
       → 客户端
```

### 2. SSE 流式请求（AI 聊天/大纲生成/Agent 对话）

```
客户端 → ... → 路由处理器 → StreamingResponse(event_stream())
       → async generator 逐块 yield SSE 事件
       → data: {"content": "..."}
       → data: [DONE]
```

### 3. WebSocket 连接

```
客户端 → ws://host:8002/ws?token=<JWT>
       → verify_token() 提取 user_id
       → ConnectionManager.connect(ws, user_id)
       → 循环 receive_json()，支持事件：
         - "subscribe:task" / "subscribe_task" → 订阅任务通知
         - "ping" → pong
         - 其他 → 广播给所有连接
```

---

## 核心设计决策

### camelCase ↔ snake_case 自动转换

`schemas/__init__.py` 中 `camel_config()` 用 `alias_generator` 将 Python 的 `snake_case` 字段名自动映射为前端的 `camelCase`，反之亦然。每个 schema 类都声明 `model_config = camel_config(...)`。

```python
def _snake_to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])
```

字段如 `user_input` → 前端接收/发送 `userInput`，无需手动转换。

### DeepSeek 适配

`ai_service.py` 的 `_build_params()` 检测 provider 是否为 DeepSeek：
- `max_tokens` 上限 65536（通用 API 上限 131072）
- 通过 `extra_body` 传递 `thinking` 和 `reasoning_effort` 参数

### Agent 层架构

```
Orchestrator（意图分类 + 路由）
  ├── classify_intent(message) → "plan"|"write"|"audit"|"character"|...
  ├── process()        → 同步 AI 调用 + 消息持久化
  ├── process_stream() → 流式 AI 调用 + SSE 输出
  └── _save_message()  → AgentMessage 持久化

BaseAgent
  ├── respond(config, messages) → chat_with_history()
  └── respond_stream(config, messages) → chat_stream()

7 个专用 Agent（Author / Outline / Character / Reader / Knowledge / Foreshadowing / AIDetector）
  每个 Agent 只负责构造 system prompt + user prompt，调用 BaseAgent.respond()
```

### 消息持久化路径

1. 用户消息 → `Orchestrator._save_message(role="user")` → 写入 `agent_messages`
2. AI 调用 → `log_ai_interaction()` → 写入 `ai_logs`
3. AI 回复 → `Orchestrator._save_message(role="assistant")` → 写入 `agent_messages`

### 前端消息兼容

`chat.py` 的 `/api/chat` 端点同时支持两种前端消息格式：
- 标准格式：`{"messages": [{"role": "user", "content": "..."}]}`
- 简化格式：`{"novelId": "...", "message": "...", "previousContent": "..."}`

`AgentProcessRequest` 同时接受 `userInput` 和 `message` 字段，`RewriteParagraphRequest` 同时接受 `paragraphText`/`paragraph`、`additionalInstructions`/`instruction`。

---

## 数据库模型关系

```
User (1) ──< (N) Novel
Novel (1) ──< (N) Volume
Volume (1) ──< (N) Chapter
Chapter (1) ──< (N) ChapterSnapshot
Novel (1) ──< (N) Character
Novel (1) ──< (N) PlotThread
Novel (1) ──< (N) TimelineEvent
Novel (1) ──< (N) KnowledgeBase
KnowledgeBase (1) ──< (N) KnowledgeDocument
Novel (1) ──< (N) OutlineVersion
Novel (1) ──< (N) Sandbox
User (1) ──< (N) AIConfig
User (1) ──< (N) AgentSession
AgentSession (1) ──< (N) AgentMessage
```

带 `TimestampMixin` 的模型自动拥有 `created_at` + `updated_at`（含默认值和 onupdate）：
User, Novel, Volume, Chapter, Character, PlotThread, TimelineEvent, KnowledgeBase, AIConfig, Sandbox, AgentSession, WritingStyleRule

不带 mixin 的模型手动定义 `created_at`，必须显式指定 `default`：
ChapterSnapshot, KnowledgeDocument, AgentMessage, AILog, OutlineVersion, Task

---

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `port` | 8002 | 服务端口（Go 版用 8001） |
| `db_path` | `novelwriter.db` | SQLite 文件路径 |
| `jwt_secret` | 硬编码 | 生产环境需要改为环境变量 |
| `jwt_algorithm` | HS256 | JWT 签名算法 |
| `jwt_expire_hours` | 72 | Token 过期时间 |
| `upload_dir` | `uploads/` | 文件上传目录 |
| `cors_origin` | `http://localhost:8001` | 前端地址 |
