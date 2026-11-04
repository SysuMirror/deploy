from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class GenerateChaptersSkill(Skill):
    id = "generate_chapters"
    name = "生成章节"
    description = "为指定卷规划章节结构"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        title = params.get("title", "")
        volume_title = params.get("volumeTitle", "")
        outline = params.get("outline", "")
        count = params.get("count", 10)

        system = f"请为《{title}》的'{volume_title}'卷规划{count}章，每章包括章节名和内容概要。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"大纲：{outline[:3000]}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(GenerateChaptersSkill())
