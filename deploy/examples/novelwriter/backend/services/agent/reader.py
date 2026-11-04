from .base import BaseAgent


class ReaderAgent(BaseAgent):
    """Reading experience auditor — evaluates content quality and readability."""

    async def audit_reading_experience(self, config, content: str) -> str:
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
        return await self.respond(config, messages)

    async def read_through(self, config, title: str, chapters: list[dict]) -> str:
        chapter_summaries = "\n".join(
            f"第{c.get('order', i+1)}章 {c.get('title', '')}: {c.get('content', '')[:500]}"
            for i, c in enumerate(chapters)
        )
        system = f"请以编辑身份通读《{title}》的以下章节摘要，评估整体连贯性和节奏。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": chapter_summaries[:8000]},
        ]
        return await self.respond(config, messages)
