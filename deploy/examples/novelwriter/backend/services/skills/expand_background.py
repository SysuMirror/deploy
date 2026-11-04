from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class ExpandBackgroundSkill(Skill):
    id = "expand_background"
    name = "扩写背景"
    description = "根据已有信息扩展和丰富小说背景设定"
    category = "writing"
    requires_novel = False

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        title = params.get("title", "")
        background = params.get("background", "")
        genre = params.get("genre", [])

        system = "你是世界观构建专家。请根据已有信息，扩展和丰富小说背景设定。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"书名：{title}\n当前背景：{background}\n类型：{', '.join(genre) if genre else '未指定'}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(ExpandBackgroundSkill())
