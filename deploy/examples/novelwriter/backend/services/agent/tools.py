"""Agent tools — executable operations the AI can invoke.

Tools either execute backend operations directly or emit frontend action events.
The tool-calling format uses XML-style tags:
  <tool_call>{"name": "...", "arguments": {...}}</tool_call>
"""

import json, logging, re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from services.ai_service import AIStreamChunk
from utils.helpers import new_id

logger = logging.getLogger(__name__)

# ── Tool Call / Result dataclasses ──────────────────────────────────────────

@dataclass
class ToolCall:
    name: str
    arguments: dict = field(default_factory=dict)
    call_id: str = ""

@dataclass
class ToolResult:
    name: str
    result: dict = field(default_factory=dict)
    call_id: str = ""
    error: str = ""

# ── Tool Call Parsing ───────────────────────────────────────────────────────

_TOOL_CALL_RE = re.compile(
    r'<tool_call>\s*\n?(.*?)\n?\s*</tool_call>', re.DOTALL
)

def parse_tool_calls(text: str) -> list[ToolCall]:
    """Extract tool calls from AI response text."""
    calls: list[ToolCall] = []
    for match in _TOOL_CALL_RE.finditer(text):
        try:
            data = json.loads(match.group(1).strip())
            calls.append(ToolCall(
                name=data.get("name", ""),
                arguments=data.get("arguments", data.get("params", {})),
                call_id=data.get("call_id", ""),
            ))
        except json.JSONDecodeError:
            logger.warning(f"Failed to parse tool call: {match.group(1)[:200]}")
    return calls

def strip_tool_calls(text: str) -> str:
    """Remove tool call tags from text, returning clean content."""
    return _TOOL_CALL_RE.sub('', text).strip()

# ── Tool ABC ────────────────────────────────────────────────────────────────

class Tool(ABC):
    name: str = ""
    description: str = ""
    parameters: dict = {}  # JSON Schema for arguments
    is_frontend_action: bool = False  # If True, emits action event for frontend

    @abstractmethod
    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        ...

    def to_schema(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


async def _call_ai(ai, config, messages: list[dict]) -> str:
    """Call AI and collect full response text."""
    if not ai or not config:
        return ""
    parts: list[str] = []
    async for chunk in ai.chat_stream(config, messages):
        if chunk.type == "content":
            parts.append(chunk.content)
        elif chunk.type == "error":
            raise RuntimeError(chunk.content)
        elif chunk.type == "done":
            break
    return "".join(parts)

# ── Tool Registry ───────────────────────────────────────────────────────────

class ToolRegistry:
    _tools: dict[str, Tool] = {}

    @classmethod
    def register(cls, tool: Tool):
        cls._tools[tool.name] = tool

    @classmethod
    def get(cls, name: str) -> Tool | None:
        return cls._tools.get(name)

    @classmethod
    def list_all(cls) -> list[Tool]:
        return list(cls._tools.values())

    @classmethod
    def get_schemas(cls) -> list[dict]:
        return [t.to_schema() for t in cls._tools.values()]

# ── Concrete Tools ──────────────────────────────────────────────────────────

class CreateNovelTool(Tool):
    name = "create_novel"
    description = "创建一本新小说。使用此工具创建小说而不是在对话中模拟创建。"
    parameters = {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "小说书名"},
            "genre": {"type": "array", "items": {"type": "string"}, "description": "题材标签，如 玄幻、奇幻、都市"},
            "style": {"type": "array", "items": {"type": "string"}, "description": "风格标签，如 爽文、热血"},
            "background": {"type": "string", "description": "小说背景设定"},
            "target_words": {"type": "integer", "description": "目标字数，默认200000"},
        },
        "required": ["title"],
    }
    is_frontend_action = True

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        from models import Novel
        novel = Novel(
            id=new_id(),
            user_id=user_id,
            title=arguments.get("title", "未命名作品"),
            genre=arguments.get("genre", []),
            style=arguments.get("style", []),
            background=arguments.get("background", ""),
            target_words=arguments.get("target_words", 200000),
        )
        db.add(novel)
        db.commit()
        db.refresh(novel)
        return ToolResult(
            name=self.name,
            result={
                "novel_id": novel.id,
                "title": novel.title,
                "action": {"type": "navigate", "route": f"/novels/detail?id={novel.id}"},
            },
        )

class SuggestTitlesTool(Tool):
    name = "suggest_titles"
    description = "根据背景和题材生成书名建议。返回书名列表供用户选择。"
    parameters = {
        "type": "object",
        "properties": {
            "background": {"type": "string", "description": "小说背景设定"},
            "genre": {"type": "array", "items": {"type": "string"}, "description": "题材标签"},
            "count": {"type": "integer", "description": "建议数量，默认5"},
        },
        "required": [],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        genre = arguments.get("genre", [])
        background = arguments.get("background", "")
        count = arguments.get("count", 5)
        prompt = f"""请为以下小说创意生成{count}个书名建议，每个书名一行，用编号列出。

题材：{', '.join(genre) if genre else '未指定'}
背景：{background or '未提供'}

要求：
- 书名简洁有力，2-8个字
- 符合题材风格
- 每个书名单独一行，格式：1. 书名"""
        try:
            content = await _call_ai(ai, config, [
                {"role": "system", "content": "你是专业的小说书名策划师，擅长为各类小说起名。"},
                {"role": "user", "content": prompt},
            ])
        except Exception as e:
            return ToolResult(name=self.name, error=str(e))
        return ToolResult(name=self.name, result={
            "action": {"type": "suggest_titles", "params": arguments},
            "message": content, "titles": content,
        })

class ExpandBackgroundTool(Tool):
    name = "expand_background"
    description = "扩展和丰富小说背景设定。需要提供已有的背景内容。"
    parameters = {
        "type": "object",
        "properties": {
            "novel_id": {"type": "string", "description": "小说ID"},
            "title": {"type": "string", "description": "书名"},
            "background": {"type": "string", "description": "当前背景设定"},
            "genre": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["novel_id"],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        from models import Novel
        novel = db.query(Novel).filter(Novel.id == arguments["novel_id"], Novel.user_id == user_id).first()
        if not novel:
            return ToolResult(name=self.name, error="小说不存在")
        title = arguments.get("title", novel.title)
        background = arguments.get("background", novel.background or "")
        genre = arguments.get("genre", novel.genre or [])
        prompt = f"""请为以下小说扩展世界背景设定，写得详细丰富（500-800字）。

书名：{title}
题材：{', '.join(genre) if genre else '未指定'}
当前设定：{background or '（尚无设定，请从零创作）'}

要求：包括世界观、时代背景、主要势力、修炼体系（如有）、社会环境等方面。"""
        try:
            content = await _call_ai(ai, config, [
                {"role": "system", "content": "你是专业的小说世界观设定师，擅长构建丰富的小说背景。"},
                {"role": "user", "content": prompt},
            ])
        except Exception as e:
            return ToolResult(name=self.name, error=str(e))
        novel.background = content
        db.commit()
        return ToolResult(name=self.name, result={
            "action": {"type": "expand_background", "params": arguments},
            "message": content, "background": content, "novel_id": novel.id,
        })

class GenerateOutlineTool(Tool):
    name = "generate_outline"
    description = "为小说生成大纲，包括分卷和章节结构。"
    parameters = {
        "type": "object",
        "properties": {
            "novel_id": {"type": "string", "description": "小说ID"},
            "title": {"type": "string", "description": "书名"},
            "background": {"type": "string", "description": "背景设定"},
            "genre": {"type": "array", "items": {"type": "string"}},
            "style": {"type": "array", "items": {"type": "string"}},
            "volumes": {"type": "integer", "description": "分卷数量，默认3"},
        },
        "required": ["novel_id"],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        from models import Novel
        novel = db.query(Novel).filter(Novel.id == arguments["novel_id"], Novel.user_id == user_id).first()
        if not novel:
            return ToolResult(name=self.name, error="小说不存在")
        title = arguments.get("title", novel.title)
        background = arguments.get("background", novel.background or "")
        genre = arguments.get("genre", novel.genre or [])
        style = arguments.get("style", novel.style or [])
        volumes = arguments.get("volumes", 3)
        prompt = f"""请为以下小说生成详细大纲，包括分卷结构和每卷章节列表。

书名：{title}
题材：{', '.join(genre) if genre else '未指定'}
风格：{', '.join(style) if style else '未指定'}
背景：{background[:200] or '未设定'}
分卷数：{volumes}卷

要求：
1. 分为{volumes}卷，每卷有明确的主题
2. 每卷包含5-10章，每章有标题和简短概要（一句话）
3. 整体结构有起承转合"""
        try:
            content = await _call_ai(ai, config, [
                {"role": "system", "content": "你是专业的小说大纲策划师，擅长构建完整的故事结构。"},
                {"role": "user", "content": prompt},
            ])
        except Exception as e:
            return ToolResult(name=self.name, error=str(e))
        novel.outline = content
        db.commit()
        return ToolResult(name=self.name, result={
            "action": {"type": "generate_outline", "params": arguments},
            "message": content, "outline": content, "novel_id": novel.id,
        })

class NavigateTool(Tool):
    name = "navigate"
    description = "导航到指定页面。用于在完成任务后引导用户查看结果。"
    parameters = {
        "type": "object",
        "properties": {
            "route": {"type": "string", "description": "目标路由，如 /novels/detail?id=xxx"},
        },
        "required": ["route"],
    }
    is_frontend_action = True

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        return ToolResult(
            name=self.name,
            result={"action": {"type": "navigate", "route": arguments["route"]}},
        )

class WriteChapterContentTool(Tool):
    name = "write_chapter_content"
    description = "为指定章节生成正文内容。需要章节ID和创作指令。生成的内容会保存到章节中。如果章节不存在则自动创建。"
    parameters = {
        "type": "object",
        "properties": {
            "novel_id": {"type": "string", "description": "小说ID"},
            "chapter_id": {"type": "string", "description": "章节ID（可选，不提供则自动创建新章节）"},
            "instruction": {"type": "string", "description": "创作指令"},
            "title": {"type": "string", "description": "章节标题"},
            "outline": {"type": "string", "description": "章节大纲/概要"},
        },
        "required": ["novel_id"],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        from models import Novel, Chapter
        novel = db.query(Novel).filter(Novel.id == arguments["novel_id"], Novel.user_id == user_id).first()
        if not novel:
            return ToolResult(name=self.name, error="小说不存在")

        chapter_id = arguments.get("chapter_id", "")
        chapter = None
        if chapter_id:
            chapter = db.query(Chapter).filter(Chapter.id == chapter_id).first()

        if not chapter:
            # Auto-create chapter
            chapter = Chapter(
                id=chapter_id or new_id(),
                novel_id=novel.id,
                title=arguments.get("title", "新章节"),
                content="",
                outline=arguments.get("outline", ""),
                status="draft",
                order=999,
            )
            db.add(chapter)
            db.commit()
            db.refresh(chapter)

        instruction = arguments.get("instruction", "请撰写本章内容")
        chapter_title = arguments.get("title", chapter.title)
        chapter_outline = arguments.get("outline", chapter.outline or "")

        prompt = f"""请撰写小说章节内容（1500-3000字）。

小说：{novel.title}
题材：{', '.join(novel.genre or [])}
背景：{(novel.background or '')[:300]}
大纲：{(novel.outline or '')[:500]}

章节标题：{chapter_title}
章节概要：{chapter_outline or '未指定'}
创作指令：{instruction}

要求：文笔流畅，情节推进合理，对话生动，场景描写到位。直接输出正文，不要写章节标题。"""
        try:
            content = await _call_ai(ai, config, [
                {"role": "system", "content": "你是一位专业的小说作家，擅长各类题材的创作。请直接输出小说正文，不要添加任何说明。"},
                {"role": "user", "content": prompt},
            ])
        except Exception as e:
            return ToolResult(name=self.name, error=str(e))

        chapter.content = content
        chapter.word_count = len(content)
        chapter.status = "draft"
        db.commit()
        return ToolResult(name=self.name, result={
            "action": {"type": "draft_chapter", "params": arguments, "chapter_id": chapter.id},
            "message": content, "chapter_id": chapter.id, "title": chapter_title,
        })

class GenerateCharactersTool(Tool):
    name = "generate_characters"
    description = "为小说生成角色设定。"
    parameters = {
        "type": "object",
        "properties": {
            "novel_id": {"type": "string", "description": "小说ID"},
            "title": {"type": "string", "description": "书名"},
            "background": {"type": "string", "description": "背景设定"},
            "genre": {"type": "array", "items": {"type": "string"}},
            "count": {"type": "integer", "description": "角色数量，默认3"},
        },
        "required": ["novel_id"],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        from models import Novel, Character
        novel = db.query(Novel).filter(Novel.id == arguments["novel_id"], Novel.user_id == user_id).first()
        if not novel:
            return ToolResult(name=self.name, error="小说不存在")
        title = arguments.get("title", novel.title)
        background = arguments.get("background", novel.background or "")
        genre = arguments.get("genre", novel.genre or [])
        count = arguments.get("count", 3)
        prompt = f"""请为以下小说生成{count}个重要角色设定。

书名：{title}
题材：{', '.join(genre) if genre else '未指定'}
背景：{background[:300] or '未设定'}

每个角色用以下格式输出：
### 角色N：角色名
- 姓名：xxx
- 性别：xxx
- 年龄：xxx
- 身份/职业：xxx
- 性格特点：xxx
- 外貌特征：xxx
- 背景故事：xxx
- 作用：xxx"""
        try:
            content = await _call_ai(ai, config, [
                {"role": "system", "content": "你是专业的小说角色设计师，擅长创造立体生动的角色。请严格按照要求的格式输出。"},
                {"role": "user", "content": prompt},
            ])
        except Exception as e:
            return ToolResult(name=self.name, error=str(e))

        # Parse character blocks (split by ### 角色N markers)
        char_blocks = re.split(r'(?:###?\s*)?角色\s*\d+\s*[：:]', content)
        if len(char_blocks) <= 1:
            char_blocks = re.split(r'\n(?=\d+[\.\)、]\s*(?:姓名|[角色]))', content)

        saved = []
        for block in char_blocks:
            block = block.strip()
            if not block or len(block) < 10:
                continue
            name_match = re.search(r'(?:姓名|[角色]名)[：:]\s*(.{1,15})', block)
            name = name_match.group(1).strip() if name_match else ""
            if not name:
                name_match = re.search(r'^([^\s]{1,10})', block)
                if name_match:
                    name = name_match.group(1).strip()

            if name:
                char = Character(
                    id=new_id(), novel_id=novel.id,
                    name=name,
                    personality=[],
                    background=block[:2000],
                    appearance="",
                    role="",
                )
                db.add(char)
                saved.append(name)

        db.commit()
        return ToolResult(name=self.name, result={
            "action": {"type": "generate_characters", "params": arguments},
            "message": content, "characters": content, "saved": saved,
            "novel_id": novel.id,
        })

class SaveContentTool(Tool):
    name = "save_content"
    description = "保存生成的内容到指定位置。用于保存AI生成的大纲、角色设定、章节内容等。"
    parameters = {
        "type": "object",
        "properties": {
            "novel_id": {"type": "string", "description": "小说ID"},
            "type": {"type": "string", "description": "内容类型: outline/character/chapter/background"},
            "target_id": {"type": "string", "description": "目标ID（章节ID、角色ID等）"},
            "content": {"type": "string", "description": "要保存的内容"},
        },
        "required": ["novel_id", "type", "content"],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        content_type = arguments.get("type", "")
        novel_id = arguments.get("novel_id", "")
        content = arguments.get("content", "")
        target_id = arguments.get("target_id", "")

        if content_type == "outline":
            from models import Novel
            novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == user_id).first()
            if novel:
                novel.outline = content
                db.commit()
                return ToolResult(name=self.name, result={"saved": "outline", "novel_id": novel_id})

        elif content_type == "background":
            from models import Novel
            novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == user_id).first()
            if novel:
                novel.background = content
                db.commit()
                return ToolResult(name=self.name, result={"saved": "background", "novel_id": novel_id})

        elif content_type == "chapter" and target_id:
            from models import Chapter
            chapter = db.query(Chapter).filter(Chapter.id == target_id).first()
            if chapter:
                chapter.content = content
                chapter.status = "draft"
                db.commit()
                return ToolResult(name=self.name, result={
                    "saved": "chapter",
                    "chapter_id": target_id,
                    "action": {"type": "navigate", "route": f"/chapters/edit?id={target_id}"},
                })

        return ToolResult(name=self.name, result={"saved": content_type, "novel_id": novel_id},
                          error="" if content_type in ("outline", "background", "chapter") else f"未知内容类型: {content_type}")

class AskUserTool(Tool):
    name = "ask_user"
    description = "向用户提问以获取信息、确认或选择。当你需要用户做出决定、提供更多细节、或确认敏感操作时使用此工具。调用后等待用户回复再继续。"
    parameters = {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "要问用户的问题"},
            "options": {"type": "array", "items": {"type": "string"}, "description": "可选的选择项列表，用户可从中选择一个"},
            "context": {"type": "string", "description": "为什么需要问这个问题，帮助用户理解背景"},
        },
        "required": ["question"],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        return ToolResult(
            name=self.name,
            result={
                "question": arguments.get("question", ""),
                "options": arguments.get("options", []),
                "context": arguments.get("context", ""),
                "pending": True,
            },
        )


class DoneTool(Tool):
    name = "done"
    description = "标记任务完成。当你完成用户请求的全部操作后调用此工具，给出总结。"
    parameters = {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "完成总结"},
        },
        "required": [],
    }

    async def execute(self, db, user_id: str, arguments: dict,
                      ai=None, config=None) -> ToolResult:
        return ToolResult(
            name=self.name,
            result={"done": True, "summary": arguments.get("summary", "任务完成")},
        )

# ── Register all tools ─────────────────────────────────────────────────────

for _tool_cls in [
    CreateNovelTool, SuggestTitlesTool, ExpandBackgroundTool,
    GenerateOutlineTool, NavigateTool, WriteChapterContentTool,
    GenerateCharactersTool, SaveContentTool, AskUserTool, DoneTool,
]:
    ToolRegistry.register(_tool_cls())
