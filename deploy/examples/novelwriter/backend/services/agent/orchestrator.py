import json
import logging
from typing import AsyncGenerator
from sqlalchemy.orm import Session

from models import AIConfig, AgentSession, AgentMessage, Novel
from services.ai_service import AIService, AIStreamChunk
from utils.helpers import new_id
from .base import BaseAgent, AGENT_SKILLS
from .author import AuthorAgent
from .outline import OutlineAgent
from .character import CharacterAgent
from .reader import ReaderAgent
from .knowledge import KnowledgeAgent
from .foreshadowing import ForeshadowingAgent
from .ai_detector import AIDetectorAgent

logger = logging.getLogger(__name__)

INTENT_MAP = {
    "plan": ["大纲", "规划", "结构", "卷", "分卷", "剧情走向"],
    "write": ["写", "续写", "生成", "章节", "内容"],
    "audit": ["审计", "检查", "评估", "诊断", "问题"],
    "character": ["角色", "人物", "性格", "关系"],
    "outline": ["大纲版本", "版本管理", "锁定"],
    "knowledge": ["知识", "设定", "世界观", "规则"],
    "foreshadowing": ["伏笔", "铺垫", "呼应"],
}


class Orchestrator:
    def __init__(self, ai: AIService):
        self.ai = ai
        self.Author = AuthorAgent(ai)
        self.Outline = OutlineAgent(ai)
        self.Character = CharacterAgent(ai)
        self.Reader = ReaderAgent(ai)
        self.Knowledge = KnowledgeAgent(ai)
        self.Foreshadowing = ForeshadowingAgent(ai)
        self.Detector = AIDetectorAgent(ai)

    def classify_intent(self, message: str) -> str:
        msg = message.lower()
        for intent, keywords in INTENT_MAP.items():
            for kw in keywords:
                if kw in msg:
                    return intent
        return "chat"

    def get_config(self, db: Session, user_id: str, purpose: str = "default") -> AIConfig | None:
        cfg = (
            db.query(AIConfig)
            .filter(AIConfig.user_id == user_id, AIConfig.purpose == purpose, AIConfig.is_default == True)
            .first()
        )
        if not cfg:
            cfg = db.query(AIConfig).filter(AIConfig.user_id == user_id, AIConfig.is_default == True).first()
        return cfg

    async def process(
        self,
        db: Session,
        session: AgentSession,
        message: str,
        user_id: str,
        config: AIConfig,
        novel: Novel | None = None,
    ) -> dict:
        intent = self.classify_intent(message)
        skill = next((s for s in AGENT_SKILLS if s["id"] == intent), AGENT_SKILLS[-1])

        self._save_message(db, session.id, "user", message)

        system = self._build_system(intent, novel)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": message}]

        full = ""
        try:
            async for chunk in self.ai.chat_stream(config, messages):
                if chunk.type in ("content", "reasoning"):
                    full += chunk.content
                elif chunk.type == "error":
                    raise RuntimeError(chunk.content)
                elif chunk.type == "done":
                    break
        except Exception as e:
            logger.error(f"Agent process error: {e}")
            full = f"处理失败：{str(e)}"

        agent_msg = self._save_message(db, session.id, "assistant", full, {"intent": intent, "skill": skill["id"]})

        return {
            "intent": intent,
            "skill": skill,
            "message": {
                "id": agent_msg.id,
                "role": "assistant",
                "content": full,
                "metadata": {"intent": intent, "skill": skill["id"]},
            },
        }

    async def process_stream(
        self,
        db: Session,
        session: AgentSession,
        message: str,
        user_id: str,
        config: AIConfig,
        novel: Novel | None = None,
    ) -> AsyncGenerator[AIStreamChunk, None]:
        intent = self.classify_intent(message)
        skill = next((s for s in AGENT_SKILLS if s["id"] == intent), AGENT_SKILLS[-1])

        self._save_message(db, session.id, "user", message)

        system = self._build_system(intent, novel)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": message}]

        # Send metadata as a meta chunk
        yield AIStreamChunk(type="content", content=f"__META__{json.dumps({'intent': intent, 'skill': skill}, ensure_ascii=False)}__ENDMETA__")

        full_response = ""
        try:
            async for chunk in self.ai.chat_stream(config, messages):
                if chunk.type in ("content", "reasoning"):
                    full_response += chunk.content
                    yield chunk
                elif chunk.type == "error":
                    yield chunk
                    raise RuntimeError(chunk.content)
                elif chunk.type == "done":
                    yield chunk
        except Exception as e:
            logger.error(f"Agent stream error: {e}")
            yield AIStreamChunk(type="error", content=str(e))

        self._save_message(db, session.id, "assistant", full_response, {"intent": intent, "skill": skill["id"]})

    def execute_skill(self, skill_id: str, **kwargs) -> dict:
        agents = {
            "plan": self.Outline,
            "write": self.Author,
            "character": self.Character,
            "audit": self.Reader,
            "outline": self.Outline,
            "knowledge": self.Knowledge,
            "foreshadowing": self.Foreshadowing,
        }
        agent = agents.get(skill_id, self.Author)
        if hasattr(agent, "execute"):
            return agent.execute(**kwargs)
        return {"error": f"Skill {skill_id} not executable"}

    def _build_system(self, intent: str, novel: Novel | None) -> str:
        base = "你是一位专业的小说创作AI助手，精通中文文学创作。"
        context = ""
        if novel:
            context = (
                f"\n当前小说：《{novel.title}》"
                f"\n背景：{novel.background}"
                f"\n风格：{', '.join(novel.style) if novel.style else '未指定'}"
                f"\n类型：{', '.join(novel.genre) if novel.genre else '未指定'}"
            )
        prompts = {
            "plan": "请根据用户需求规划小说结构，包括分卷、章节划分和每章概要。",
            "write": "请根据已有内容和用户需求进行创作，保持风格一致。",
            "audit": "请对提供的文本进行全面审计，包括文学质量、一致性、节奏等方面。",
            "character": "请帮助设计和管理角色，包括性格、背景、关系和成长弧。",
            "outline": "请帮助管理和优化小说大纲，确保结构合理。",
            "knowledge": "请帮助整理世界观设定和知识体系。",
            "foreshadowing": "请帮助识别和追踪小说中的伏笔。",
            "chat": "请以小说创作专家的身份与用户自由交流。",
        }
        return base + context + "\n\n" + prompts.get(intent, prompts["chat"])

    def _save_message(
        self, db: Session, session_id: str, role: str, content: str, metadata: dict | None = None
    ) -> AgentMessage:
        msg = AgentMessage(
            id=new_id(),
            session_id=session_id,
            role=role,
            content=content,
            extra=metadata,
        )
        db.add(msg)
        db.commit()
        db.refresh(msg)
        return msg

    @staticmethod
    def get_skills() -> list[dict]:
        return AGENT_SKILLS
