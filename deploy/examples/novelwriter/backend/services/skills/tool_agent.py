"""Tool-calling agent skill — the main agent entry point in AiLogPanel."""

from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from services.agent.agent import ToolCallingAgent
from typing import AsyncGenerator


class ToolAgentSkill(Skill):
    id = "tool_agent"
    name = "AI 助手"
    description = "调用工具执行创作任务：创建小说、生成大纲、写作等"
    category = "general"
    requires_novel = False
    sub_agent_capable = True

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        message = params.get("message", "")
        novel_id = params.get("novelId", "")

        novel = None
        if novel_id and db:
            from models import Novel
            novel = db.query(Novel).filter(Novel.id == novel_id).first()

        session_id = params.get("sessionId", "")
        user_id = params.get("_userId", "")

        agent = ToolCallingAgent(ai)
        async for chunk in agent.run(
            config=config,
            message=message,
            db=db,
            user_id=user_id,
            session_id=session_id,
            novel=novel,
        ):
            yield chunk


SkillRegistry.register(ToolAgentSkill())
