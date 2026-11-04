from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class DraftChapterSkill(Skill):
    id = "draft_chapter"
    name = "撰写章节"
    description = "根据大纲和上下文生成章节正文"
    category = "writing"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        novel_title = params.get("novelTitle", "")
        background = params.get("background", "")
        style = params.get("style", [])
        outline = params.get("outline", "")
        prev_content = params.get("prevContent", "")
        instruction = params.get("instruction", "")

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

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(DraftChapterSkill())
