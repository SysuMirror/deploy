import re
from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class SuggestTitlesSkill(Skill):
    id = "suggest_titles"
    name = "建议书名"
    description = "根据小说背景和类型生成书名建议"
    category = "writing"
    requires_novel = False

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        background = params.get("background", "")
        genre = params.get("genre", [])
        count = params.get("count", 5)

        system = (
            f"你是一位专业的书名策划师。请根据背景和类型，生成{count}个吸引人的小说书名建议。\n"
            "格式：每行一个书名，以数字序号开头，如 '1. 书名'。不要有其他说明。"
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"背景：{background}\n类型：{', '.join(genre) if genre else '未指定'}"},
        ]

        full = ""
        async for chunk in ai.chat_stream(config, messages):
            if chunk.type in ("content", "reasoning"):
                full += chunk.content
                yield chunk
            elif chunk.type == "done":
                break
            elif chunk.type == "error":
                yield chunk
                return

        # Parse titles from response
        titles = self._parse_titles(full)
        yield AIStreamChunk(
            type="content",
            content="",
            metadata={"titles": titles, "raw": full[:500]},
        )

    @staticmethod
    def _parse_titles(text: str) -> list[str]:
        titles: list[str] = []
        for line in text.split("\n"):
            line = line.strip()
            match = re.match(r'^[\d]+[.\、)\s]+(.+)', line)
            if match:
                title = match.group(1).strip().strip('"').strip("'").strip("《").strip("》")
                if title:
                    titles.append(title)
        if not titles and text.strip():
            titles = [text.strip()[:50]]
        return titles


SkillRegistry.register(SuggestTitlesSkill())
