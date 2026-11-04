from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class RewriteParagraphSkill(Skill):
    id = "rewrite_paragraph"
    name = "重写段落"
    description = "根据指令重写指定段落"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        paragraph = params.get("paragraph", "")
        instruction = params.get("instruction", "")

        system = f"请根据指令重写以下段落，保持核心意思不变。\n指令：{instruction}"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": paragraph},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(RewriteParagraphSkill())
