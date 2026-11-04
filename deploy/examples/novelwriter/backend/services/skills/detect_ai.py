"""AI content detection skill — analyzes text for AI-generated traces."""

from typing import AsyncGenerator

from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from services.agent.ai_detector import AIDetectorAgent


class DetectAISkill(Skill):
    id = "detect_ai"
    name = "AI率检测"
    description = "分析文本的AI生成痕迹，从6个维度评估并给出改进建议"
    category = "audit"
    requires_novel = False

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        content = (params.get("content", "") or "")[:8000]
        if not content.strip():
            yield AIStreamChunk(type="content", content="没有提供需要检测的文本内容。")
            yield AIStreamChunk(type="done", content="")
            return

        detector = AIDetectorAgent(ai)
        try:
            result = await detector.detect_ai_rate(config, content)
            yield AIStreamChunk(type="content", content=result)
        except Exception as e:
            yield AIStreamChunk(type="error", content=f"AI检测失败: {e}")
        yield AIStreamChunk(type="done", content="")


SkillRegistry.register(DetectAISkill())
