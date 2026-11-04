import uuid
from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class SubAgentSkill(Skill):
    id = "sub_agent"
    name = "子Agent"
    description = "派生子Agent独立完成指定任务"
    category = "general"
    requires_novel = False
    sub_agent_capable = True

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        prompt = params.get("prompt", "")
        novel_context = params.get("novelContext", "")
        parent_session_id = params.get("parentSessionId", "")

        session_id = str(uuid.uuid4())

        system = (
            "你是一个独立的子Agent，专门负责完成分配给你的任务。\n"
            "请自主规划步骤，逐步完成任务，并在完成后给出总结。\n"
            "在任务过程中，思考你的每一步操作。"
        )
        if novel_context:
            system += f"\n\n当前作品上下文：{novel_context}"

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]

        yield AIStreamChunk(
            type="content",
            content="",
            metadata={
                "subSessionId": session_id,
                "parentSessionId": parent_session_id,
                "status": "started",
            },
        )

        async for chunk in ai.chat_stream(config, messages):
            yield chunk

        yield AIStreamChunk(
            type="content",
            content="",
            metadata={
                "subSessionId": session_id,
                "status": "completed",
            },
        )


SkillRegistry.register(SubAgentSkill())
