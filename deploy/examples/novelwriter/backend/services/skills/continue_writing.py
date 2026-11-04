from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class ContinueWritingSkill(Skill):
    id = "continue_writing"
    name = "续写内容"
    description = "根据上下文和指令续写小说内容"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        novel_title = params.get("novelTitle", "")
        context = params.get("context", "")
        instruction = params.get("instruction", "")

        system = f"你是《{novel_title}》的作者，请根据上下文和指令续写内容。保持风格一致，情节合理推进。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"上下文：{context[:3000]}\n\n指令：{instruction}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(ContinueWritingSkill())
