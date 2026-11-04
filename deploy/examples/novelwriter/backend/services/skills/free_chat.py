from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class FreeChatSkill(Skill):
    id = "free_chat"
    name = "自由对话"
    description = "与AI自由讨论写作思路和创意"
    category = "general"
    requires_novel = False

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        message = params.get("message", "")
        previous_content = params.get("previousContent", "")
        novel_title = params.get("novelTitle", "")
        novel_context = params.get("novelContext", "")

        system_msg = "你是一位专业的小说创作AI助手。"
        if novel_context:
            system_msg += f"\n当前作品信息：{novel_context}"

        messages = [{"role": "system", "content": system_msg}]
        if previous_content:
            messages.append({"role": "user", "content": f"前文内容：{previous_content}"})
        messages.append({"role": "user", "content": message or "你好"})

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(FreeChatSkill())
