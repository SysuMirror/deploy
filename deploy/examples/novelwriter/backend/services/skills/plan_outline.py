from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class PlanOutlineSkill(Skill):
    id = "plan_outline"
    name = "规划大纲"
    description = "根据创意构思生成小说大纲和卷章结构"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        title = params.get("title", "")
        background = params.get("background", "")
        genre = params.get("genre", [])
        style = params.get("style", [])

        system = (
            "你是一位专业的小说结构设计师。请根据以下信息生成完整的小说大纲：\n"
            "1. 故事框架（开端-发展-高潮-结局）\n"
            "2. 分卷规划（每卷的核心冲突和主题）\n"
            "3. 每卷下的章节规划（每章的情节要点）\n"
            "4. 主线与支线的交织安排\n\n"
            "格式：使用Markdown层级结构。"
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"书名：{title}\n背景：{background}\n类型：{', '.join(genre) if genre else '未指定'}\n风格：{', '.join(style) if style else '未指定'}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(PlanOutlineSkill())
