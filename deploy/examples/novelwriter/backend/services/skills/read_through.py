from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class ReadThroughSkill(Skill):
    id = "read_through"
    name = "通读审阅"
    description = "通读章节并评估整体连贯性和节奏"
    category = "audit"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        title = params.get("title", "")
        chapters = params.get("chapters", [])

        chapter_summaries = "\n".join(
            f"第{chapter.get('order', i + 1)}章 {chapter.get('title', '')}: {chapter.get('content', '')[:500]}"
            for i, chapter in enumerate(chapters)
        )
        system = f"请以编辑身份通读《{title}》的以下章节摘要，评估整体连贯性和节奏。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": chapter_summaries[:8000]},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(ReadThroughSkill())
