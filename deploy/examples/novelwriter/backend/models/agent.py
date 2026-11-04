from datetime import datetime, timezone
from sqlalchemy import Column, String, Text, ForeignKey, JSON, DateTime
from sqlalchemy.orm import relationship
from database import Base
from .base import new_id, TimestampMixin

_utcnow = lambda: datetime.now(timezone.utc)


class AgentSession(Base, TimestampMixin):
    __tablename__ = "agent_sessions"

    id = Column(String(36), primary_key=True, default=new_id)
    user_id = Column(String(36), ForeignKey("users.id"), index=True, nullable=True)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=True)
    title = Column(String(255), nullable=False, default="")
    status = Column(String(20), nullable=False, default="active")
    context = Column(JSON, nullable=True)
    plan = Column(JSON, nullable=True)

    messages = relationship("AgentMessage", back_populates="session")


class AgentMessage(Base):
    __tablename__ = "agent_messages"

    id = Column(String(36), primary_key=True, default=new_id)
    session_id = Column(String(36), ForeignKey("agent_sessions.id"), index=True, nullable=False)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False, default="")
    extra = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=_utcnow)

    session = relationship("AgentSession", back_populates="messages")


class AILog(Base):
    __tablename__ = "ai_logs"

    id = Column(String(36), primary_key=True, default=new_id)
    task_id = Column(String(36), index=True, nullable=True)
    novel_id = Column(String(36), index=True, nullable=True)
    interaction_id = Column(String(36), index=True, nullable=True)
    type = Column(String(20), nullable=False, default="llm")
    status = Column(String(20), nullable=False, default="")
    message = Column(Text, nullable=False, default="")
    chunk = Column(Text, nullable=False, default="")
    provider = Column(String(50), nullable=False, default="")
    model = Column(String(100), nullable=False, default="")
    prompt = Column(Text, nullable=False, default="")
    response = Column(Text, nullable=False, default="")
    error = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=_utcnow)
