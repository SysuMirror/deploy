from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class ExtractPlotThreadsSkill(Skill):
    id = "extract_plot_threads"
    name = "提取伏笔"
    description = "分析文本识别伏笔和情节线"
    category = "audit"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        content = params.get("content", "")
        existing_threads = params.get("existingThreads", [])

        threads_text = "\n".join(
            f"- [{t.get('status', 'open')}] {t.get('title', '')}: {t.get('content', '')[:200]}"
            for t in existing_threads
        )
        system = """请分析以下文本，识别其中的伏笔和情节线：
1. 新埋下的伏笔（暗线、铺垫、未完成的对话）
2. 对之前伏笔的回收或推进
3. 新的人物关系和冲突线"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"已有伏笔/情节线：\n{threads_text}\n\n新内容：\n{content[:5000]}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(ExtractPlotThreadsSkill())
