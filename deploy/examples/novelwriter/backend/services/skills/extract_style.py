from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class ExtractStyleSkill(Skill):
    id = "extract_style"
    name = "提取文风"
    description = "分析文本的写作风格特征"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        content = params.get("content", "")

        system = "请分析以下文本的写作风格特征，包括：句式特点、用词习惯、叙事视角、节奏控制、描写手法等。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": content[:5000]},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(ExtractStyleSkill())
