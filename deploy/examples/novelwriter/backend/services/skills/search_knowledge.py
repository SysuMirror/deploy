from services.agent.base import Skill, SkillRegistry
from services.ai_service import AIService, AIStreamChunk
from typing import AsyncGenerator


class SearchKnowledgeSkill(Skill):
    id = "search_knowledge"
    name = "知识库检索"
    description = "根据知识库内容回答用户问题"
    category = "world"

    async def execute_stream(
        self, ai: AIService, config, params: dict, db, log_service, task_id: str
    ) -> AsyncGenerator[AIStreamChunk, None]:
        query = params.get("query", "")
        documents = params.get("documents", [])

        docs_text = "\n---\n".join(
            f"[{d.get('title', '')}] {d.get('content', '')[:1000]}" for d in documents
        )
        system = "请根据知识库内容回答用户问题。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"知识库内容：\n{docs_text[:8000]}\n\n问题：{query}"},
        ]

        async for chunk in ai.chat_stream(config, messages):
            yield chunk


SkillRegistry.register(SearchKnowledgeSkill())
