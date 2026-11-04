# Skill System

## Overview

The NovelWriter AI system uses a pluggable **Skill** architecture. Every AI operation (writing, auditing, world-building, chatting) is a Skill — a self-contained module that defines a prompt and a streaming execution method.

Skills are registered at import time via `SkillRegistry.register()` and dispatched through the unified streaming endpoint `POST /api/ai/stream`.

## Architecture

```
┌──────────────┐     POST /api/ai/stream     ┌──────────────┐
│   Frontend   │ ──────────────────────────▶  │  routers/ai  │
│  AiLogPanel  │ ◀──── SSE (event stream) ── │              │
│  aiLogStore  │                              │  dispatch    │
└──────────────┘                              │  skill via   │
       ▲                                      │  Registry    │
       │ WebSocket                            └──────┬───────┘
       │ (ai_log:status,                              │
       │  ai_log:chunk)                       ┌──────▼───────┐
       │                                      │  Skill ABC   │
┌──────┴───────┐                              │  execute_    │
│  AILogService│◄────── log_start/log_chunk/  │  stream()    │
│  (WS broadcast│       log_complete          └──────────────┘
│   + DB write) │
└──────────────┘
```

## SSE Protocol

The unified endpoint `POST /api/ai/stream` accepts:
```json
{
  "skillId": "suggest_titles",
  "params": { "genre": ["玄幻"], "count": 5 },
  "sessionId": "optional-existing-session",
  "novelId": "optional-novel-id"
}
```

Response (Server-Sent Events):
```
event: meta       data: {"sessionId":"...","taskId":"...","interactionId":"..."}
event: reasoning  data: {"content":"思考过程文本..."}
event: content    data: {"content":"最终回复文本..."}
event: result     data: {"content":"...", "titles": ["书名1","书名2"]}
event: error      data: {"message":"错误信息"}
event: done       data: {"interactionId":"...","sessionId":"..."}
```

### Event Types

| Event | Purpose |
|-------|---------|
| `meta` | Session/task/interaction IDs, sent first |
| `reasoning` | DeepSeek thinking tokens (deep thinker mode) |
| `content` | Normal AI response text |
| `result` | Structured result with skill-specific metadata |
| `error` | Error message, stream terminates |
| `done` | Completion signal |

## Skill Base Class

```python
from services.agent.base import Skill, SkillRegistry

class MySkill(Skill):
    id = "my_skill"
    name = "我的技能"
    description = "技能描述"
    category = "writing"  # writing | audit | world | general
    requires_novel = True
    sub_agent_capable = False

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        # Build prompt from params
        messages = [
            {"role": "system", "content": "系统提示词"},
            {"role": "user", "content": params.get("input", "")},
        ]

        # Stream AI response
        async for chunk in ai.chat_stream(config, messages):
            yield chunk

SkillRegistry.register(MySkill())
```

## Adding a New Skill

1. Create a new file in `backend/services/skills/` (e.g., `my_feature.py`)
2. Define a class inheriting from `Skill`
3. Set class attributes: `id`, `name`, `description`, `category`
4. Implement `execute_stream()` yielding `AIStreamChunk` objects
5. Call `SkillRegistry.register(MySkill())` at module level
6. Add `from . import my_feature` to `backend/services/skills/__init__.py`

## Frontend Integration

From any Vue component:
```typescript
import { useAiLogStore } from '@/stores/aiLog';

const aiLog = useAiLogStore();

// Execute a skill — opens panel, streams response
const taskId = await aiLog.executeSkill('suggest_titles', novelId, {
  genre: ['玄幻'],
  count: 5,
}, true, '建议书名');

// Listen for structured results
aiLog.onTaskEvent(taskId, (type, data) => {
  if (data.metadata?.titles) {
    // Handle title suggestions
  }
});
```

### Interactive Results

Skills can return structured data in `AIStreamChunk.metadata`. The AiLogPanel renders:
- `metadata.titles` → clickable title cards (emits `ai:title-selected` event)
- `metadata.characters` → character cards

## Existing Skills (20 total)

| ID | Name | Category |
|----|------|----------|
| `free_chat` | 自由对话 | general |
| `plan_outline` | 规划大纲 | writing |
| `condense_outline` | 精简大纲 | writing |
| `generate_volumes` | 生成分卷 | writing |
| `generate_chapters` | 生成章节 | writing |
| `draft_chapter` | 撰写章节 | writing |
| `continue_writing` | 续写内容 | writing |
| `suggest_titles` | 建议书名 | writing |
| `expand_background` | 扩写背景 | writing |
| `extract_style` | 提取文风 | writing |
| `rewrite_paragraph` | 重写段落 | writing |
| `generate_characters` | 生成角色 | world |
| `ooc_check` | OOC检查 | audit |
| `read_through` | 通读审阅 | audit |
| `audit_reading` | 阅读体验审计 | audit |
| `extract_knowledge` | 提取知识点 | world |
| `search_knowledge` | 知识库检索 | world |
| `extract_plot_threads` | 提取伏笔 | audit |
| `infer_timeline` | 推断时间线 | audit |
| `sub_agent` | 子Agent | general |

## AILogService

The `AILogService` provides centralized logging for every AI call:

- `log_start()` — writes `AILog` row with status="running", broadcasts `ai_log:status` via WebSocket
- `log_chunk()` — broadcasts `ai_log:chunk` via WebSocket for real-time frontend rendering
- `log_complete()` — updates `AILog` row, broadcasts final status

WebSocket events are best-effort; failures don't break the stream.

## DeepSeek Thinking Mode

When using a DeepSeek model with thinking enabled, the AI returns separate `reasoning_content` deltas. These are emitted as:
- SSE: `event: reasoning data: {"content": "..."}`
- AiLogPanel renders reasoning in dimmed, collapsible blocks (dark background, monospace)
