from .base import BaseAgent


class KnowledgeAgent(BaseAgent):
    """Knowledge extraction and management agent."""

    async def extract_knowledge(self, config, content: str) -> str:
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
        return await self.respond(config, messages)

    async def search_knowledge(self, config, query: str, documents: list[dict]) -> str:
        docs_text = "\n---\n".join(
            f"[{d.get('title', '')}] {d.get('content', '')[:1000]}" for d in documents
        )
        system = "请根据知识库内容回答用户问题。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"知识库内容：\n{docs_text[:8000]}\n\n问题：{query}"},
        ]
        return await self.respond(config, messages)
