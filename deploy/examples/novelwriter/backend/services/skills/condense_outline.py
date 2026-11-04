from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class CondenseOutlineSkill(Skill):
    id = "condense_outline"
    name = "精简大纲"
    description = "将小说大纲精简提炼，保留核心结构"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        outline = params.get("outline", "")

        system = "请将以下小说大纲精简提炼，保留核心结构和关键情节点。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": outline[:8000]},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(CondenseOutlineSkill())
