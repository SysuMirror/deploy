from .base import BaseAgent


class ForeshadowingAgent(BaseAgent):
    """Foreshadowing tracking agent — identifies and tracks plot threads."""

    async def extract_plot_threads(self, config, content: str, existing_threads: list[dict]) -> str:
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
        return await self.respond(config, messages)

    async def infer_timeline(self, config, content: str, existing_events: list[dict]) -> str:
        events_text = "\n".join(
            f"- {e.get('time_label', '')}: {e.get('title', '')} — {e.get('description', '')[:200]}"
            for e in existing_events
        )
        system = "请从以下文本中提取时间线事件，与已有事件对齐时间顺序。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"已有时间线：\n{events_text}\n\n新内容：\n{content[:5000]}"},
        ]
        return await self.respond(config, messages)
