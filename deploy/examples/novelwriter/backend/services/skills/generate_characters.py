from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class GenerateCharactersSkill(Skill):
    id = "generate_characters"
    name = "生成角色"
    description = "根据小说设定自动设计角色"
    category = "world"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        title = params.get("title", "")
        background = params.get("background", "")
        genre = params.get("genre", [])
        count = params.get("count", 3)

        system = f"""你是角色设计师。请为《{title}》设计{count}个角色。
每个角色包括：
- 姓名、角色定位（主角/配角/反派等）
- 性格特质（列表）
- 能力/技能
- 外貌描述
- 背景故事
- 与其他角色的关系
- 角色成长弧线"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"背景：{background}\n类型：{', '.join(genre) if genre else '未指定'}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(GenerateCharactersSkill())
