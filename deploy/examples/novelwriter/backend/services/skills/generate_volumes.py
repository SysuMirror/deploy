from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class GenerateVolumesSkill(Skill):
    id = "generate_volumes"
    name = "生成分卷"
    description = "根据小说大纲规划分卷结构"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        title = params.get("title", "")
        background = params.get("background", "")
        outline = params.get("outline", "")
        count = params.get("count", 5)

        system = f"请根据小说大纲，规划{count}卷的内容，每卷包括卷名和简短摘要。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"书名：{title}\n背景：{background}\n大纲：{outline[:5000]}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(GenerateVolumesSkill())
