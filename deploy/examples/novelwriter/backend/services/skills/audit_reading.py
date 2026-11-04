from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class AuditReadingSkill(Skill):
    id = "audit_reading"
    name = "阅读体验审计"
    description = "以编辑身份审计文本的阅读体验质量"
    category = "audit"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        content = params.get("content", "")

        system = """请以资深编辑的身份审计以下文本的阅读体验，需要检查：
1. 流畅度 — 语句是否通顺，段落过渡是否自然
2. 吸引力 — 开头是否有钩子，节奏是否合适
3. 信息密度 — 是否有冗余或不够详细的部分
4. 情感共鸣 — 读者是否能感知到情感变化
5. 画面感 — 场景描写是否生动
6. 人物魅力 — 角色是否让人记住"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": content[:8000]},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(AuditReadingSkill())
