from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class InferTimelineSkill(Skill):
    id = "infer_timeline"
    name = "推断时间线"
    description = "从文本中提取时间线事件并对齐"
    category = "audit"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        content = params.get("content", "")
        existing_events = params.get("existingEvents", [])

        events_text = "\n".join(
            f"- {e.get('time_label', '')}: {e.get('title', '')} — {e.get('description', '')[:200]}"
            for e in existing_events
        )
        system = "请从以下文本中提取时间线事件，与已有事件对齐时间顺序。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"已有时间线：\n{events_text}\n\n新内容：\n{content[:5000]}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(InferTimelineSkill())
