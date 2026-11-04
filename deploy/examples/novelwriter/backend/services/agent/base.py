from abc import ABC, abstractmethod
from typing import AsyncGenerator
from sqlalchemy.orm import Session
from services.ai_service import AIService, AIStreamChunk


# ── Legacy BaseAgent (kept for backward compat during migration) ──
class BaseAgent:
    def __init__(self, ai: AIService):
        self.ai = ai

    async def respond(self, config, messages: list[dict]) -> str:
        """Consume stream and return full text (backward compat for sync-style agents)."""
        parts: list[str] = []
        async for chunk in self.ai.chat_stream(config, messages):
            if chunk.type in ("content", "reasoning"):
                parts.append(chunk.content)
            elif chunk.type == "error":
                raise RuntimeError(chunk.content)
            elif chunk.type == "done":
                break
        return "".join(parts)

    async def respond_stream(self, config, messages: list[dict]):
        """Yield AIStreamChunk objects directly."""
        async for chunk in self.ai.chat_stream(config, messages):
            yield chunk


# ── Pluggable Skill System ──
class Skill(ABC):
    """Pluggable AI skill executed via the unified streaming endpoint."""

    id: str = ""
    name: str = ""
    description: str = ""
    category: str = "general"  # writing | audit | world | general
    requires_novel: bool = True
    sub_agent_capable: bool = False

    @abstractmethod
    async def execute_stream(
        self,
        ai: AIService,
        config,
        params: dict,
        db: Session | None,
        log_service,  # AILogService
        task_id: str,
    ) -> AsyncGenerator[AIStreamChunk, None]:
        """Execute this skill as a streaming AI operation."""
        ...


class SkillRegistry:
    _skills: dict[str, Skill] = {}

    @classmethod
    def register(cls, skill: Skill) -> None:
        cls._skills[skill.id] = skill

    @classmethod
    def get(cls, skill_id: str) -> Skill | None:
        return cls._skills.get(skill_id)

    @classmethod
    def list_all(cls) -> list[dict]:
        return [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "category": s.category,
                "requiresNovel": s.requires_novel,
                "subAgentCapable": s.sub_agent_capable,
            }
            for s in cls._skills.values()
        ]

    @classmethod
    def list_by_category(cls, category: str) -> list[dict]:
        return [s for s in cls.list_all() if s["category"] == category]


# Keep AGENT_SKILLS for backward compat (removed in Phase 7)
AGENT_SKILLS = [
    {"id": "plan", "name": "规划大纲", "description": "根据创意构思生成小说大纲和卷章结构", "category": "writing"},
    {"id": "write", "name": "续写内容", "description": "基于上下文智能续写章节内容", "category": "writing"},
    {"id": "audit", "name": "综合审计", "description": "对内容进行AI率、阅读体验、角色OOC等多维度审计", "category": "audit"},
    {"id": "character", "name": "角色管理", "description": "生成和优化角色设定，检查角色一致性", "category": "world"},
    {"id": "outline", "name": "大纲管理", "description": "生成和优化故事大纲，管理大纲版本", "category": "world"},
    {"id": "knowledge", "name": "知识库", "description": "从内容中提取知识点，构建世界观知识库", "category": "world"},
    {"id": "foreshadowing", "name": "伏笔追踪", "description": "识别和追踪小说中的伏笔，确保前后呼应", "category": "audit"},
    {"id": "chat", "name": "自由对话", "description": "与AI自由讨论写作思路和创意", "category": "general"},
]
