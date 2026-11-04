from .base import BaseAgent


class CharacterAgent(BaseAgent):
    """Character design and management agent."""

    async def generate_characters(
        self, config, title: str, background: str, genre: list[str], count: int = 3
    ) -> str:
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
        return await self.respond(config, messages)

    async def check_ooc(self, config, character_name: str, character_profile: str, content: str) -> str:
        system = f"请检查以下文本中角色'{character_name}'的行为是否符合其设定。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"角色设定：{character_profile}\n\n检查文本：{content[:3000]}"},
        ]
        return await self.respond(config, messages)
