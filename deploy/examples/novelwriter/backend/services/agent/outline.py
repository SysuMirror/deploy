import logging
from .base import BaseAgent
from utils.json_extract import extract_json

logger = logging.getLogger(__name__)


class OutlineAgent(BaseAgent):
    """Outline management agent — generates and manages novel outlines."""

    async def generate_outline(
        self, config, title: str, background: str, genre: list[str], style: list[str]
    ) -> str:
        system = """你是一位专业的小说结构设计师。请根据以下信息生成完整的小说大纲：
1. 故事框架（开端-发展-高潮-结局）
2. 分卷规划（每卷的核心冲突和主题）
3. 每卷下的章节规划（每章的情节要点）
4. 主线与支线的交织安排

格式：使用Markdown层级结构。"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"书名：{title}\n背景：{background}\n类型：{', '.join(genre) if genre else '未指定'}\n风格：{', '.join(style) if style else '未指定'}"},
        ]
        return await self.respond(config, messages)

    async def condense_outline(self, config, outline: str) -> str:
        system = "请将以下小说大纲精简提炼，保留核心结构和关键情节点。"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": outline[:8000]},
        ]
        return await self.respond(config, messages)

    async def generate_volumes(
        self, config, title: str, background: str, outline: str, count: int = 5,
        additional_requirements: str = "",
    ) -> list[dict]:
        system = (
            f"你是小说分卷策划师。请规划恰好 {count} 卷。"
            "只输出 JSON 数组，不要 markdown，不要解释。"
            '格式：[{"title":"卷名","summary":"本卷摘要","order":0}]'
        )
        extra = f"\n额外要求：{additional_requirements}" if additional_requirements else ""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"书名：{title}\n背景：{background}\n大纲：{outline[:5000]}{extra}"},
        ]
        raw = await self.respond(config, messages)
        data = extract_json(raw)
        if isinstance(data, dict):
            data = data.get("volumes") or data.get("items") or []
        if not isinstance(data, list):
            raise ValueError("分卷结果格式无效")
        volumes = []
        for i, item in enumerate(data[:count]):
            if not isinstance(item, dict):
                continue
            volumes.append({
                "title": str(item.get("title") or f"第{i + 1}卷"),
                "summary": str(item.get("summary") or ""),
                "order": int(item.get("order") if item.get("order") is not None else i),
            })
        if not volumes:
            raise ValueError("未生成有效分卷")
        return volumes

    async def generate_chapters(
        self, config, title: str, volume_title: str, outline: str, count: int = 10,
        additional_requirements: str = "",
    ) -> list[dict]:
        system = (
            f"你是章节规划师。请为指定分卷规划恰好 {count} 章。"
            "只输出 JSON 数组，不要 markdown，不要解释。"
            '格式：[{"title":"章名","outline":"一句话概要","order":0}]'
        )
        extra = f"\n额外要求：{additional_requirements}" if additional_requirements else ""
        messages = [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": (
                    f"书名：{title}\n分卷：{volume_title}\n大纲：{outline[:3000]}{extra}"
                ),
            },
        ]
        raw = await self.respond(config, messages)
        data = extract_json(raw)
        if isinstance(data, dict):
            data = data.get("chapters") or data.get("items") or []
        if not isinstance(data, list):
            raise ValueError("章节结果格式无效")
        chapters = []
        for i, item in enumerate(data[:count]):
            if not isinstance(item, dict):
                continue
            chapters.append({
                "title": str(item.get("title") or f"第{i + 1}章"),
                "outline": str(item.get("outline") or item.get("summary") or ""),
                "content": "",
                "order": int(item.get("order") if item.get("order") is not None else i),
                "status": "draft",
            })
        if not chapters:
            raise ValueError("未生成有效章节")
        return chapters
