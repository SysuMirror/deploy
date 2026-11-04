from .base import BaseAgent


class AIDetectorAgent(BaseAgent):
    """AI-generated content detection agent."""

    async def detect_ai_rate(self, config, content: str) -> str:
        system = """请分析以下文本的AI生成痕迹。从以下几个维度评估：
1. 语言模式 — 是否存在过于规整、缺乏自然的句式变化
2. 重复性 — 是否有AI常见的词语和句式重复
3. 情感深度 — 情感描写是否自然、有层次
4. 细节真实性 — 细节描写是否符合真实体验
5. 创造性 — 是否有独特的创意表达
6. 风格一致性 — 风格是否前后统一

给出综合评估和改进建议。"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": content[:8000]},
        ]
        return await self.respond(config, messages)
