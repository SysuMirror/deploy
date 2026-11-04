from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class OOCCheckSkill(Skill):
    id = "ooc_check"
    name = "OOC检查"
    description = "检查角色行为是否符合其设定"
    category = "audit"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        character_name = params.get("characterName", "")
        character_profile = params.get("characterProfile", "")
        content = params.get("content", "")

        system = f"请检查以下文本中角色'{character_name}'的行为是否符合其设定。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"角色设定：{character_profile}\n\n检查文本：{content[:3000]}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(OOCCheckSkill())
