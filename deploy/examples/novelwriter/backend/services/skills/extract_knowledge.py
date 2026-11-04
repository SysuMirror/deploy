from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class ExtractKnowledgeSkill(Skill):
    id = "extract_knowledge"
    name = "提取知识点"
    description = "从小说文本中提取世界观知识点"
    category = "world"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        content = params.get("content", "")

        system = """请从以下小说文本中提取世界观知识点：
1. 世界观设定（时间、地点、社会结构、规则）
2. 力量体系/魔法规则（如有）
3. 特殊名词和术语
4. 重要地点和场景
5. 文化和习俗
6. 历史事件和传说"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": content[:8000]},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(ExtractKnowledgeSkill())
