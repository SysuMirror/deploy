from .base import BaseAgent


class AuthorAgent(BaseAgent):
    """Novel writing agent — generates chapter content, continues writing."""

    async def draft_chapter(
        self, config, novel_title: str, background: str, style: list[str],
        outline: str, prev_content: str, instruction: str,
    ) -> str:
        system = f"""你是一位专业小说作家，正在创作《{novel_title}》。
背景设定：{background}
写作风格：{', '.join(style) if style else '流畅自然'}
坚持以下规则：
1. 保持风格一致性
2. Show, Don't Tell
3. 对话生动自然，符合角色性格
4. 每个场景有明确的情感基调
5. 适当使用伏笔和细节描写"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"章节大纲：{outline}\n\n前文摘要：{prev_content[:2000]}\n\n续写要求：{instruction}"},
        ]
        return await self.respond(config, messages)

    async def continue_writing(
        self, config, novel_title: str, context: str, instruction: str
    ) -> str:
        system = f"你是《{novel_title}》的作者，请根据上下文和指令续写内容。保持风格一致，情节合理推进。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"上下文：{context[:3000]}\n\n指令：{instruction}"},
        ]
        return await self.respond(config, messages)

    async def suggest_titles(self, config, background: str, genre: list[str], count: int = 5) -> str:
        system = f"你是一位专业的书名策划师。根据背景和类型，生成{count}个吸引人的小说书名建议。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"背景：{background}\n类型：{', '.join(genre) if genre else '未指定'}"},
        ]
        msg = await self.respond(config, messages)
        print(f"Suggested titles: {msg}")
        return msg.split("\n")[:count]
    async def expand_background(self, config, title: str, background: str, genre: list[str]) -> str:
        system = "你是世界观构建专家。请根据已有信息，扩展和丰富小说背景设定。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"书名：{title}\n当前背景：{background}\n类型：{', '.join(genre) if genre else '未指定'}"},
        ]
        return await self.respond(config, messages)

    async def extract_style(self, config, content: str) -> str:
        system = "请分析以下文本的写作风格特征，包括：句式特点、用词习惯、叙事视角、节奏控制、描写手法等。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": content[:5000]},
        ]
        return await self.respond(config, messages)

    async def rewrite_paragraph(self, config, paragraph: str, instruction: str) -> str:
        system = f"请根据指令重写以下段落，保持核心意思不变。\n指令：{instruction}"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": paragraph},
        ]
        return await self.respond(config, messages)
